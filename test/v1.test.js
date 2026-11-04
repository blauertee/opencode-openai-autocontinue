import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../src/server.js"
import { bearerFromAuth, createV1Server, fromV1Error, partID } from "../src/v1.js"
import { isUsageLimitError } from "../src/logic.js"
import { settle } from "./fake-context.js"

const START = 1_800_000_000_000
const S = (ms) => Math.floor(ms / 1000)
const STATE = "/state/opencode/openai-autocontinue-v1.json"

const blockedUsage = (resetAt) => ({ rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: S(resetAt) } } })
const freeUsage = { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 3, reset_at: S(START) + 18_000 } } }

const assistant = (extra = {}) => ({
  id: "msg_a",
  sessionID: "ses_1",
  role: "assistant",
  providerID: "openai",
  modelID: "gpt-6-sol",
  agent: "build",
  time: { created: START },
  ...extra,
})

const usageError = (resetsAt) => ({
  name: "APIError",
  data: {
    message: "The usage limit has been reached",
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { "x-codex-primary-used-percent": "100" },
    responseBody: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: resetsAt } }),
  },
})

async function harness({ options = {}, usage = () => null, files: initial = {}, auth } = {}) {
  let clock = START
  let tick
  const timers = []
  const logs = []
  const parts = new Map()
  const calls = { patch: [], delete: [], prompt: [], toast: [] }
  const statuses = {}
  const fs = new Map(Object.entries(initial))
  const authContent = JSON.stringify({ openai: auth ?? { type: "oauth", access: "tok", refresh: "r", expires: START + 86_400_000, accountId: "acc" } })
  const client = {
    _client: {
      patch: async ({ path, body }) => {
        calls.patch.push({ path, body })
        parts.set(path.partID, body)
        return { data: body }
      },
      delete: async ({ path }) => {
        calls.delete.push(path)
        parts.delete(path.partID)
        return { data: true }
      },
    },
    session: {
      get: async ({ path }) => ({ data: { id: path.id } }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: statuses }),
      promptAsync: async (input) => {
        calls.prompt.push(input)
        return { data: undefined }
      },
    },
    tui: { showToast: async (input) => void calls.toast.push(input) },
  }
  const requests = []
  const server = createV1Server({
    now: () => clock,
    setTimeout: (fn, ms) => {
      const timer = { at: clock + ms, fn }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
    setInterval: (fn) => {
      tick = fn
      return 1
    },
    clearInterval: () => {},
    logger: (message) => logs.push(message),
    env: { OPENCODE_AUTH_CONTENT: authContent, XDG_STATE_HOME: "/state", XDG_DATA_HOME: "/data" },
    home: "/home/u",
    files: {
      readFile: async (file) => {
        if (!fs.has(file)) throw new Error("ENOENT")
        return fs.get(file)
      },
      writeFile: async (file, text) => void fs.set(file, text),
      rename: async (from, to) => {
        fs.set(to, fs.get(from))
        fs.delete(from)
      },
      mkdir: async () => {},
    },
    fetch: async (url, init) => {
      requests.push({ url, init })
      const body = usage()
      if (!body) return new Response("nope", { status: 403 })
      return Response.json(body)
    },
  })
  const hooks = await server({ client, directory: "/work" }, options)
  return {
    hooks,
    calls,
    parts,
    logs,
    requests,
    statuses,
    fs,
    state: () => JSON.parse(fs.get(STATE) ?? '{"entries":{}}').entries,
    now: () => clock,
    emit: async (type, properties) => {
      await hooks.event({ event: { type, properties } })
      await settle()
    },
    advance: async (ms) => {
      clock += ms
      for (const timer of timers.filter((item) => item.at <= clock)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.fn()
      }
      tick?.()
      await settle()
    },
  }
}

const headersInput = { sessionID: "ses_1", agent: "build", model: { providerID: "openai", id: "gpt-6-sol" }, provider: { info: { id: "openai" } } }

async function startHold(h) {
  await h.emit("message.updated", { info: assistant() })
  await h.emit("session.status", { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "The usage limit has been reached", next: h.now() + 2000 } })
  let released = false
  const run = h.hooks["chat.headers"](headersInput, { headers: {} }).then(() => (released = true))
  await settle()
  return { run, released: () => released }
}

test("one default export loads on OpenCode 1 and 2", () => {
  assert.equal(plugin.id, "openai-autocontinue")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")
})

test("hold: keeps the request back until the reset and shows a note in the chat", async () => {
  let resetAt = START + 30 * 60_000
  const h = await harness({ usage: () => (h.now() < resetAt ? blockedUsage(resetAt) : freeUsage) })
  const hold = await startHold(h)

  assert.equal(hold.released(), false)
  assert.equal(h.calls.patch.length, 1)
  const note = h.calls.patch[0].body
  assert.equal(note.messageID, "msg_a")
  assert.equal(note.type, "text")
  assert.match(note.text, /Continuing automatically at .* \(in 31m\)/)
  assert.equal(h.requests[0].init.headers.Authorization, "Bearer tok")
  assert.equal(h.requests[0].init.headers["ChatGPT-Account-Id"], "acc")
  assert.equal(h.state().ses_1.mode, "hold")

  await h.advance(20 * 60_000)
  assert.equal(hold.released(), false)
  await h.advance(12 * 60_000)
  await hold.run
  assert.equal(hold.released(), true)
  assert.deepEqual(h.calls.delete.map((item) => item.partID), [note.id])
  assert.equal(h.parts.size, 0)
  assert.equal(h.state().ses_1, undefined)
  assert.equal(h.calls.prompt.length, 0)
})

test("hold: still limited at the reset time keeps waiting and updates the note", async () => {
  let resetAt = START + 10 * 60_000
  const h = await harness({ usage: () => (h.now() < resetAt ? blockedUsage(resetAt) : freeUsage) })
  const hold = await startHold(h)
  const id = h.calls.patch[0].body.id
  resetAt = START + 60 * 60_000 // the weekly window turned out to be full as well
  await h.advance(11 * 60_000)
  assert.equal(hold.released(), false)
  assert.equal(h.parts.get(id).text.includes("(in 50m)"), true)
  await h.advance(50 * 60_000)
  await hold.run
  assert.equal(hold.released(), true)
})

test("hold: Esc cancels it and removes the note", async () => {
  const resetAt = START + 30 * 60_000
  const h = await harness({ usage: () => blockedUsage(resetAt) })
  const hold = await startHold(h)
  await h.emit("session.error", { sessionID: "ses_1", error: { name: "MessageAbortedError", data: { message: "Aborted" } } })
  await hold.run
  assert.equal(h.parts.size, 0)
  assert.equal(h.state().ses_1, undefined)
  assert.ok(h.logs.some((line) => line.includes("hold cancelled (interrupted)")))
  // No hold on the next request.
  await h.hooks["chat.headers"](headersInput, { headers: {} })
})

test("a retry that is not the plan limit is left to OpenCode", async () => {
  const h = await harness({ usage: () => freeUsage })
  await h.emit("message.updated", { info: assistant() })
  await h.emit("session.status", { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "Rate limit reached", next: START + 2000 } })
  await h.hooks["chat.headers"](headersInput, { headers: {} })
  assert.equal(h.calls.patch.length, 0)
})

test("other providers are ignored", async () => {
  const h = await harness({ usage: () => blockedUsage(START + 60_000) })
  await h.emit("message.updated", { info: assistant({ providerID: "anthropic" }) })
  await h.emit("session.status", { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "usage limit", next: START + 2000 } })
  await h.hooks["chat.headers"]({ ...headersInput, model: { providerID: "anthropic" } }, { headers: {} })
  assert.equal(h.requests.length, 0)
})

test("fallback: after OpenCode gives up, resumes with a synthetic prompt at the reset", async () => {
  const resetAt = START + 3 * 3_600_000
  const h = await harness({ usage: () => (h.now() < resetAt ? blockedUsage(resetAt) : freeUsage) })
  await h.emit("message.updated", { info: assistant() })
  await h.emit("session.error", { sessionID: "ses_1", error: usageError(S(resetAt)) })

  const entry = h.state().ses_1
  assert.equal(entry.mode, "resume")
  assert.equal(entry.source, "error")
  assert.equal(entry.resumeAt, resetAt + 60_000)
  const note = h.parts.get(entry.note.partID)
  assert.equal(note.messageID, "msg_a")
  assert.match(note.text, /Continuing automatically/)

  await h.advance(3 * 3_600_000)
  assert.equal(h.calls.prompt.length, 0)
  await h.advance(61_000)
  assert.equal(h.calls.prompt.length, 1)
  const prompt = h.calls.prompt[0]
  assert.equal(prompt.path.id, "ses_1")
  assert.deepEqual(prompt.body.model, { providerID: "openai", modelID: "gpt-6-sol" })
  assert.equal(prompt.body.agent, "build")
  assert.equal(prompt.body.parts[0].synthetic, true)
  assert.match(h.parts.get(entry.note.partID).text, /Continued automatically/)
  assert.equal(h.state().ses_1, undefined)
})

test("fallback: new input cancels the pending resume", async () => {
  const h = await harness({ usage: () => blockedUsage(START + 3_600_000) })
  await h.emit("message.updated", { info: assistant() })
  await h.emit("session.error", { sessionID: "ses_1", error: usageError(S(START) + 3600) })
  const { note } = h.state().ses_1
  await h.emit("session.status", { sessionID: "ses_1", status: { type: "busy" } })
  assert.equal(h.state().ses_1, undefined)
  assert.equal(h.parts.get(note.partID).text, "Automatic continue cancelled.")
  await h.advance(2 * 3_600_000)
  assert.equal(h.calls.prompt.length, 0)
})

test("fallback: ignores errors that waiting does not fix", async () => {
  const h = await harness()
  await h.emit("message.updated", { info: assistant() })
  const error = usageError(S(START) + 60)
  error.data.responseBody = '{"error":{"code":"insufficient_quota"}}'
  await h.emit("session.error", { sessionID: "ses_1", error })
  assert.equal(h.state().ses_1, undefined)
})

test("restart during a hold: deletes the stale note and resumes", async () => {
  const entry = {
    sessionID: "ses_1",
    directory: "/work",
    mode: "hold",
    resumeAt: START + 60_000,
    resetAt: START,
    source: "usage",
    note: { messageID: "msg_a", partID: "prt_old" },
    streak: 1,
    model: { providerID: "openai", modelID: "gpt-6-sol" },
  }
  const h = await harness({ usage: () => freeUsage, files: { [STATE]: JSON.stringify({ entries: { ses_1: entry } }) } })
  await settle()
  assert.deepEqual(h.calls.delete, [{ sessionID: "ses_1", messageID: "msg_a", partID: "prt_old" }])
  assert.equal(h.state().ses_1.mode, "resume")
  await h.advance(61_000)
  assert.equal(h.calls.prompt.length, 1)
})

test("entries of other projects are left alone", async () => {
  const other = { sessionID: "ses_9", directory: "/elsewhere", mode: "resume", resumeAt: START }
  const h = await harness({ usage: () => freeUsage, files: { [STATE]: JSON.stringify({ entries: { ses_9: other } }) } })
  await h.advance(TICK)
  assert.equal(h.calls.prompt.length, 0)
  assert.ok(h.state().ses_9)
})
const TICK = 15_000

test("hold: continues early when the limit clears before the reset (usage reset)", async () => {
  const resetAt = START + 3 * 3_600_000
  let reset = false
  const h = await harness({ usage: () => (reset ? freeUsage : blockedUsage(resetAt)) })
  const hold = await startHold(h)
  for (let i = 0; i < 20; i++) await h.advance(15_000) // 5 minutes
  assert.equal(hold.released(), false)
  reset = true
  for (let i = 0; i < 21; i++) await h.advance(15_000)
  await hold.run
  assert.equal(hold.released(), true)
  assert.ok(h.now() < START + 11 * 60_000)
  assert.equal(h.parts.size, 0)
  assert.ok(h.logs.some((line) => line.includes("cleared before the reset time")))
})

test("fallback: resumes early when the limit clears before the reset", async () => {
  const resetAt = START + 3 * 3_600_000
  let reset = false
  const h = await harness({ usage: () => (reset ? freeUsage : blockedUsage(resetAt)) })
  await h.emit("message.updated", { info: assistant() })
  await h.emit("session.error", { sessionID: "ses_1", error: usageError(S(resetAt)) })
  await h.advance(5 * 60_000)
  assert.equal(h.calls.prompt.length, 0)
  reset = true
  await h.advance(5 * 60_000)
  await h.advance(15_000)
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(h.state().ses_1, undefined)
})

test("an expired token is not used for the usage lookup", () => {
  assert.equal(bearerFromAuth({ type: "oauth", access: "a", expires: START - 1 }, START), null)
  assert.deepEqual(bearerFromAuth({ type: "oauth", access: "a", expires: START + 3_600_000, accountId: "x" }, START), { access: "a", accountID: "x" })
  assert.equal(bearerFromAuth({ type: "api", key: "k" }, START), null)
})

test("1.x usage errors are recognised through the shared logic", () => {
  assert.equal(isUsageLimitError(fromV1Error(usageError(1))), true)
  assert.equal(isUsageLimitError(fromV1Error({ name: "APIError", data: { message: "Rate limit", statusCode: 429, responseBody: "{}" } })), false)
})

test("part IDs sort in creation order", () => {
  const ids = [partID(START), partID(START), partID(START + 1)]
  assert.deepEqual([...ids].sort(), ids)
  assert.match(ids[0], /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

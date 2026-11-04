import assert from "node:assert/strict"
import { test } from "node:test"
import { createAutoContinuePlugin } from "../src/server.js"
import { createFakeContext, settle } from "./fake-context.js"

const START = 1_800_000_000_000
const S = (ms) => Math.floor(ms / 1000)
const model = { providerID: "openai", id: "gpt-6-sol" }
const session = (extra = {}) => ({ id: "ses_1", model, time: { created: START, updated: START, busy: START, idle: START + 1 }, ...extra })

function harness({ options, sessions = { ses_1: session() }, credential, usage, storage } = {}) {
  let clock = START
  let tick
  const logs = []
  const requests = []
  const fake = createFakeContext({ options, sessions, credential, storage })
  const plugin = createAutoContinuePlugin({
    now: () => clock,
    setInterval: (fn) => {
      tick = fn
      return 1
    },
    clearInterval: () => {},
    logger: (message) => logs.push(message),
    fetch: async (url, init) => {
      requests.push({ url, init })
      const body = typeof usage === "function" ? usage() : usage
      if (!body) return new Response("nope", { status: 403 })
      return Response.json(body)
    },
  })
  return {
    ...fake,
    logs,
    requests,
    plugin,
    advance: async (ms) => {
      clock += ms
      tick?.()
      await settle()
    },
    now: () => clock,
  }
}

const usageLimit = (resetsAt) => ({
  type: "provider.quota",
  message: "The usage limit has been reached",
  status: 429,
  response: { body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: resetsAt } }) },
})
const sharingLimit = { type: "provider.chatgpt-limit", message: "ChatGPT usage limit reached.", status: 429, response: { body: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}' } }

test("short wait: retries in place with the delay to the reset plus buffer", async () => {
  const h = harness()
  const cleanup = await h.plugin.setup(h.ctx)
  const event = await h.trigger("retry", {
    sessionID: "ses_1",
    model,
    error: usageLimit(S(START) + 600),
    attempt: 2,
    decision: { retry: false },
  })
  assert.deepEqual(event.decision, { retry: true, delay: 660_000 })
  assert.equal(h.storage.get("pending:ses_1").mode, "inline")
  await h.emit("session.execution.succeeded", { sessionID: "ses_1" })
  assert.equal(h.storage.has("pending:ses_1"), false)
  await cleanup()
})

test("ignores other providers and other errors", async () => {
  const h = harness()
  await h.plugin.setup(h.ctx)
  const other = await h.trigger("retry", { sessionID: "ses_1", model: { providerID: "anthropic" }, error: sharingLimit, decision: { retry: false } })
  assert.deepEqual(other.decision, { retry: false })
  const throttle = await h.trigger("retry", {
    sessionID: "ses_1",
    model,
    error: { type: "provider.rate-limit", message: "slow", status: 429 },
    decision: { retry: true, delay: 2000 },
  })
  assert.deepEqual(throttle.decision, { retry: true, delay: 2000 })
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: { type: "provider.rate-limit", message: "x" } })
  assert.equal(h.storage.size, 0)
})

test("long wait: stops retries, resumes the session after the reset from the usage endpoint", async () => {
  const resetAt = S(START) + 5 * 3600
  let usage = { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: resetAt } } }
  const h = harness({
    credential: { type: "oauth", access: "tok", metadata: { accountID: "acct" } },
    usage: () => usage,
  })
  await h.plugin.setup(h.ctx)
  const event = await h.trigger("retry", { sessionID: "ses_1", model, error: sharingLimit, decision: { retry: false } })
  assert.deepEqual(event.decision, { retry: false })
  assert.equal(h.requests[0].url, "https://chatgpt.com/backend-api/wham/usage")
  assert.equal(h.requests[0].init.headers.Authorization, "Bearer tok")
  assert.equal(h.requests[0].init.headers["ChatGPT-Account-Id"], "acct")

  await h.emit("session.execution.failed", { sessionID: "ses_1", error: sharingLimit })
  const entry = h.storage.get("pending:ses_1")
  assert.equal(entry.mode, "resume")
  assert.equal(entry.resumeAt, resetAt * 1000 + 60_000)
  assert.equal(entry.source, "usage")

  await h.advance(4 * 3600_000)
  assert.equal(h.calls.synthetic.length, 0)

  usage = { rate_limit: { allowed: true, primary_window: { used_percent: 0, reset_at: resetAt + 18000 } } }
  await h.advance(3600_000 + 61_000)
  assert.equal(h.calls.synthetic.length, 1)
  assert.equal(h.calls.synthetic[0].sessionID, "ses_1")
  assert.equal(h.calls.synthetic[0].resume, true)
  assert.equal(h.storage.has("pending:ses_1"), false)

  // Our own resume starting does not count as user input.
  await h.emit("session.execution.started", { sessionID: "ses_1" })
  assert.ok(!h.logs.some((line) => line.includes("new input")))
})

test("re-schedules when the usage endpoint still shows the limit at wake-up", async () => {
  const later = S(START) + 7200
  const h = harness({
    credential: { type: "oauth", access: "tok" },
    usage: { rate_limit: { limit_reached: true, secondary_window: { used_percent: 100, reset_at: later } } },
    options: { inlineMaxWaitMinutes: 0 },
  })
  await h.plugin.setup(h.ctx)
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: usageLimit(S(START) + 60) })
  assert.equal(h.storage.get("pending:ses_1").source, "error")
  await h.advance(121_000)
  assert.equal(h.calls.synthetic.length, 0)
  assert.equal(h.storage.get("pending:ses_1").resumeAt, later * 1000 + 60_000)
})

test("new user input or an interrupt cancels the pending resume", async () => {
  const h = harness({ options: { inlineMaxWaitMinutes: 0 } })
  await h.plugin.setup(h.ctx)
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: usageLimit(S(START) + 600) })
  assert.ok(h.storage.has("pending:ses_1"))
  await h.emit("session.execution.started", { sessionID: "ses_1" })
  assert.equal(h.storage.has("pending:ses_1"), false)

  await h.emit("session.execution.failed", { sessionID: "ses_1", error: usageLimit(S(START) + 600) })
  await h.emit("session.execution.interrupted", { sessionID: "ses_1", reason: "user" })
  assert.equal(h.storage.has("pending:ses_1"), false)
  await h.advance(3600_000)
  assert.equal(h.calls.synthetic.length, 0)
})

test("cancel command drops the pending resume", async () => {
  const h = harness({ options: { inlineMaxWaitMinutes: 0 } })
  await h.plugin.setup(h.ctx)
  assert.equal(h.commands[0].name, "autocontinue-cancel")
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: usageLimit(S(START) + 600) })
  await h.commands[0].execute({ sessionID: "ses_1" })
  assert.equal(h.storage.has("pending:ses_1"), false)
})

test("restores pending resumes after a restart and resumes overdue ones", async () => {
  const storage = new Map([
    ["pending:ses_1", { sessionID: "ses_1", directory: "/work", mode: "inline", resumeAt: START - 1000, resetAt: START - 61_000, source: "error", streak: 0 }],
    ["pending:ses_x", { sessionID: "ses_x", directory: "/elsewhere", mode: "resume", resumeAt: START - 1000 }],
  ])
  const h = harness({ storage })
  await h.plugin.setup(h.ctx)
  await h.advance(15_000)
  assert.deepEqual(h.calls.synthetic.map((call) => call.sessionID), ["ses_1"])
  assert.ok(storage.has("pending:ses_x"), "another location's entry is left alone")
})

test("skips subagent sessions by default", async () => {
  const h = harness({ sessions: { ses_1: session({ parentID: "ses_0" }) }, options: { inlineMaxWaitMinutes: 0 } })
  await h.plugin.setup(h.ctx)
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: usageLimit(S(START) + 600) })
  assert.equal(h.storage.size, 0)
})

test("gives up after repeated limits right after resuming", async () => {
  const h = harness({ options: { inlineMaxWaitMinutes: 0, maxConsecutiveResumes: 2 } })
  await h.plugin.setup(h.ctx)
  for (let i = 0; i < 2; i++) {
    await h.emit("session.execution.failed", { sessionID: "ses_1", error: sharingLimit })
    await h.advance(16 * 60_000)
    await h.emit("session.execution.started", { sessionID: "ses_1" })
  }
  assert.equal(h.calls.synthetic.length, 2)
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: sharingLimit })
  assert.equal(h.storage.has("pending:ses_1"), false)
  assert.ok(h.logs.some((line) => line.includes("giving up")))
})

test("disabled does nothing", async () => {
  const h = harness({ options: { enabled: false } })
  await h.plugin.setup(h.ctx)
  const event = await h.trigger("retry", { sessionID: "ses_1", model, error: sharingLimit, decision: { retry: false } })
  assert.deepEqual(event.decision, { retry: false })
})

const blocked = (resetAt) => ({ rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: resetAt } } })
const cleared = { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 0, reset_at: S(START) + 18_000 } } }

test("durable resume: continues early when the usage endpoint shows the limit cleared", async () => {
  const resetAt = S(START) + 5 * 3600
  let usage = blocked(resetAt)
  const h = harness({ credential: { type: "oauth", access: "tok" }, usage: () => usage })
  await h.plugin.setup(h.ctx)
  await h.trigger("retry", { sessionID: "ses_1", model, error: sharingLimit, decision: { retry: false } })
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: sharingLimit })
  assert.equal(h.storage.get("pending:ses_1").mode, "resume")

  await h.advance(5 * 60_000)
  assert.equal(h.calls.synthetic.length, 0)
  usage = cleared // the user redeemed a usage reset
  await h.advance(5 * 60_000)
  assert.equal(h.calls.synthetic.length, 1)
  assert.equal(h.storage.has("pending:ses_1"), false)
  assert.ok(h.logs.some((line) => line.includes("cleared before the reset time")))
})

test("in-place retry: stops OpenCode's wait and resumes when the limit clears early", async () => {
  let usage = blocked(S(START) + 50 * 60)
  const h = harness({ credential: { type: "oauth", access: "tok" }, usage: () => usage })
  await h.plugin.setup(h.ctx)
  const event = await h.trigger("retry", { sessionID: "ses_1", model, error: usageLimit(S(START) + 50 * 60), decision: { retry: false } })
  assert.equal(event.decision.retry, true)
  assert.equal(h.storage.get("pending:ses_1").mode, "inline")

  usage = cleared
  await h.advance(5 * 60_000)
  assert.deepEqual(h.calls.interrupt, [{ sessionID: "ses_1" }])
  assert.equal(h.storage.get("pending:ses_1").mode, "stopping")
  assert.equal(h.calls.synthetic.length, 0)

  await h.emit("session.execution.interrupted", { sessionID: "ses_1", reason: "user" })
  assert.equal(h.storage.get("pending:ses_1").mode, "resume")
  await h.advance(15_000)
  assert.equal(h.calls.synthetic.length, 1)
  assert.equal(h.storage.has("pending:ses_1"), false)
})

test("usageCheckMinutes: 0 turns the early check off", async () => {
  const h = harness({ credential: { type: "oauth", access: "tok" }, usage: () => cleared, options: { usageCheckMinutes: 0, inlineMaxWaitMinutes: 0 } })
  await h.plugin.setup(h.ctx)
  await h.emit("session.execution.failed", { sessionID: "ses_1", error: usageLimit(S(START) + 3600) })
  const requests = h.requests.length
  await h.advance(30 * 60_000)
  assert.equal(h.calls.synthetic.length, 0)
  assert.equal(h.requests.length, requests)
})

// OpenCode 1 server plugin (checked against OpenCode 1.19.5). Same goal as the
// OpenCode 2 plugin in server.js, but 1.x has no retry hook, no plugin storage
// and no credential API, so it works differently:
//
//   - Hold in place. When a request of an OpenAI session fails and OpenCode
//     schedules a retry (`session.status` of type `retry`), the plugin checks
//     the ChatGPT usage endpoint. If the plan's limit is exhausted, its
//     `chat.headers` hook, which OpenCode awaits inside the next attempt, does
//     not return until the limit resets. The session stays busy (spinner on),
//     a note in the chat says when it will continue, and the original request
//     is then simply sent again. The note is deleted first: OpenCode sends
//     assistant text back to the model.
//   - Esc cancels: OpenCode interrupts the attempt and the plugin drops the
//     hold when it sees the abort.
//   - Fallback. If OpenCode gives up anyway (it was restarted, or the limit
//     was not visible in time), the session stops with the usage error. The
//     resume time is saved to a state file and a synthetic "continue" prompt
//     is sent once it has passed; sending the session a message cancels it.
//
// The OAuth credential is read from OpenCode's auth.json, the state file lives
// next to the log file.

import {
  formatDelay,
  isUsageLimitError,
  limitsFromHeaders,
  normalizeConfig,
  planResume,
  resetFromLimits,
} from "./logic.js"
import { createLog } from "./log.js"
import { createUsageReader } from "./usage.js"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const TICK_MS = 15_000
const SEND_RETRY_MS = 60_000
const MAX_SEND_FAILURES = 5
const PART_URL = "/session/{sessionID}/message/{messageID}/part/{partID}"

/* -- Files ------------------------------------------------------------------ */

const dataDir = (env, home) => path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode")
const stateDir = (env, home) => path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "opencode")

/** OpenCode 1 keeps provider credentials in `$XDG_DATA_HOME/opencode/auth.json`. */
export function authFile(env = process.env, home = os.homedir()) {
  return path.join(dataDir(env, home), "auth.json")
}

export function stateFile(env = process.env, home = os.homedir()) {
  return path.join(stateDir(env, home), "openai-autocontinue-v1.json")
}

/**
 * Bearer token and account ID from an OpenCode 1 auth entry
 * (`{ type: "oauth", access, refresh, expires, accountId }`). An expired token
 * is not used: OpenCode refreshes it on its next request, and refreshing it
 * here would rotate the refresh token behind OpenCode's back.
 */
export function bearerFromAuth(entry, nowMs = Date.now()) {
  if (!entry || entry.type !== "oauth" || typeof entry.access !== "string" || !entry.access) return null
  if (typeof entry.expires === "number" && entry.expires > 0 && entry.expires < nowMs + 30_000) return null
  const accountID = entry.accountId ?? entry.accountID
  return { access: entry.access, accountID: typeof accountID === "string" && accountID ? accountID : null }
}

/* -- Helpers ---------------------------------------------------------------- */

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastIdTime = 0
let idCounter = 0

/** An ascending part ID in OpenCode's format, so the note sorts after existing parts. */
export function partID(nowMs = Date.now()) {
  if (nowMs !== lastIdTime) {
    lastIdTime = nowMs
    idCounter = 0
  }
  idCounter++
  const value = BigInt(nowMs) * 0x1000n + BigInt(idCounter)
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => ID_CHARS[byte % 62]).join("")
  return `prt_${time}${random}`
}

/**
 * An OpenCode 1 session error (`{ name: "APIError", data: { ... } }`) in the
 * shape the shared logic reads (`{ message, status, response: { body } }`).
 */
export function fromV1Error(error) {
  if (!error || typeof error !== "object") return null
  const data = error.data && typeof error.data === "object" ? error.data : {}
  const headers = data.responseHeaders ?? {}
  const retryAfter = Number.parseFloat(headers["retry-after"] ?? "")
  return {
    type: error.name,
    message: data.message,
    status: data.statusCode,
    response: { body: data.responseBody, headers },
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
  }
}

const result = (response) => (response && typeof response === "object" && "data" in response ? response.data : response)

function noteText(resumeAt, nowMs) {
  const when = new Date(resumeAt)
  const sameDay = new Date(nowMs).toDateString() === when.toDateString()
  const time = sameDay
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  const delay = resumeAt - nowMs < 60_000 ? "in under a minute" : `in ${formatDelay(resumeAt - nowMs)}`
  return `ChatGPT usage limit reached. Continuing automatically at ${time} (${delay}).`
}

/* -- Plugin ----------------------------------------------------------------- */

export function createV1Server({
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  setTimeout: later = globalThis.setTimeout,
  clearTimeout: cancelLater = globalThis.clearTimeout,
  setInterval: every = globalThis.setInterval,
  clearInterval: stopEvery = globalThis.clearInterval,
  logger,
  env = process.env,
  home = os.homedir(),
  files = { readFile, writeFile, rename, mkdir },
} = {}) {
  return async function server(input, options) {
    const config = normalizeConfig(options ?? {})
    const { info, debug } = createLog(config, logger)
    if (!config.enabled) return {}

    const client = input.client
    const raw = client?._client ?? client?.session?._client
    const directory = input.directory
    const statePath = stateFile(env, home)

    async function credential() {
      try {
        const text = env.OPENCODE_AUTH_CONTENT || (await files.readFile(authFile(env, home), "utf8"))
        return bearerFromAuth(JSON.parse(text)?.[config.usageIntegrationID], now())
      } catch {
        return null
      }
    }
    const readUsage = createUsageReader({ config, fetch: fetcher, now, log: debug, credential })

    /** sessionID -> latest assistant message `{ id, providerID, modelID, agent, completed }`. */
    const assistants = new Map()
    /** sessionID -> `{ resumeAt, resetAt, source }` once a retry was found to be a usage limit. */
    const limited = new Map()
    /** sessionID -> promise of the usage check started by a retry. */
    const checking = new Map()
    /** sessionID -> the hold currently keeping a request back. */
    const holds = new Map()
    /** sessionID -> durable entry (mirrored in the state file). */
    const pending = new Map()
    const streak = new Map()
    const resuming = new Set()
    const firing = new Set()
    const parents = new Map()

    const allowedProvider = (providerID) => typeof providerID === "string" && config.providerIDs.includes(providerID)

    /* -- State file ----------------------------------------------------- */

    let writing = Promise.resolve()
    async function readState() {
      try {
        const value = JSON.parse(await files.readFile(statePath, "utf8"))
        return value && typeof value === "object" && value.entries && typeof value.entries === "object" ? value : { entries: {} }
      } catch {
        return { entries: {} }
      }
    }
    function persist(sessionID, entry) {
      // Read-modify-write, serialised: other projects' instances share the file.
      writing = writing
        .then(async () => {
          const state = await readState()
          if (entry) state.entries[sessionID] = entry
          else delete state.entries[sessionID]
          await files.mkdir(path.dirname(statePath), { recursive: true })
          const temp = `${statePath}.${process.pid}.tmp`
          await files.writeFile(temp, JSON.stringify(state, null, 2))
          await files.rename(temp, statePath)
        })
        .catch((error) => debug(`could not write ${statePath}: ${error?.message ?? error}`))
      return writing
    }
    async function save(entry) {
      pending.set(entry.sessionID, entry)
      await persist(entry.sessionID, entry)
    }
    async function drop(sessionID, reason) {
      const entry = pending.get(sessionID)
      if (!entry) return
      pending.delete(sessionID)
      await persist(sessionID, null)
      if (reason) info(`${sessionID}: pending resume cancelled (${reason})`)
      return entry
    }

    /* -- Session helpers ---------------------------------------------- */

    async function eligible(sessionID) {
      if (config.resumeSubagents) return true
      if (!parents.has(sessionID)) {
        try {
          const session = result(await client.session.get({ path: { id: sessionID } }))
          if (!session) return true
          parents.set(sessionID, session.parentID ?? null)
        } catch {
          return true
        }
      }
      return !parents.get(sessionID)
    }

    async function lastAssistant(sessionID) {
      const known = assistants.get(sessionID)
      if (known) return known
      try {
        const messages = result(await client.session.messages({ path: { id: sessionID } })) ?? []
        const found = [...messages].reverse().find((item) => item?.info?.role === "assistant")?.info
        return found ? remember(found) : null
      } catch {
        return null
      }
    }

    function remember(message) {
      const value = {
        id: message.id,
        providerID: message.providerID,
        modelID: message.modelID,
        agent: message.agent ?? message.mode,
        completed: Boolean(message.time?.completed),
        error: message.error ?? null,
      }
      assistants.set(message.sessionID, value)
      return value
    }

    /* -- Chat note -------------------------------------------------------- */

    async function writeNote(sessionID, messageID, text, id = partID(now())) {
      if (!raw || !messageID) return null
      try {
        const response = await raw.patch({
          url: PART_URL,
          path: { sessionID, messageID, partID: id },
          body: { id, sessionID, messageID, type: "text", text, synthetic: true, time: { start: now() }, metadata: { autocontinue: true } },
          headers: { "Content-Type": "application/json" },
        })
        if (response?.error) throw new Error(JSON.stringify(response.error))
        return { messageID, partID: id }
      } catch (error) {
        debug(`${sessionID}: could not write the note: ${error?.message ?? error}`)
        return null
      }
    }

    async function deleteNote(sessionID, note) {
      if (!raw || !note) return
      try {
        await raw.delete({ url: PART_URL, path: { sessionID, messageID: note.messageID, partID: note.partID } })
      } catch (error) {
        debug(`${sessionID}: could not delete the note: ${error?.message ?? error}`)
      }
    }

    async function toast(message, variant = "info") {
      try {
        await client.tui?.showToast?.({ body: { title: "Auto-continue", message, variant, duration: 10_000 } })
      } catch {}
    }

    /* -- Detecting a usage limit during OpenCode's retry ------------------ */

    async function check(sessionID, status) {
      const assistant = await lastAssistant(sessionID)
      if (!allowedProvider(assistant?.providerID)) return
      if (!(await eligible(sessionID))) return
      const usage = await readUsage()
      const blockedUntil = resetFromLimits(usage, now())
      const looksLikeLimit = /usage[ _-]?limit/i.test(status?.message ?? "")
      if (blockedUntil === null && !(usage === null && looksLikeLimit)) {
        limited.delete(sessionID)
        return
      }
      // Usage unreadable but the message says it is the plan limit: wait the
      // fallback and let the retry find out.
      const plan = planResume({ error: null, usage, headers: null, nowMs: now(), config })
      limited.set(sessionID, plan)
      debug(`${sessionID}: retry is a usage limit; holding until ${new Date(plan.resumeAt).toISOString()} (${plan.source})`)
    }

    /* -- Holding a request until the reset -------------------------------- */

    function sleep(ms, hold) {
      return new Promise((resolve) => {
        const timer = later(resolve, ms)
        hold.wake = () => {
          cancelLater(timer)
          resolve()
        }
      })
    }

    async function hold(sessionID, plan) {
      const count = (streak.get(sessionID) ?? 0) + 1
      if (config.maxConsecutiveResumes > 0 && count > config.maxConsecutiveResumes) {
        streak.delete(sessionID)
        limited.delete(sessionID)
        info(`${sessionID}: usage limit hit ${count - 1} times in a row; letting the request fail`)
        return
      }
      streak.set(sessionID, count)

      const state = { cancelled: false, wake: null, note: null, plan }
      holds.set(sessionID, state)
      const assistant = await lastAssistant(sessionID)
      const entry = (extra = {}) => ({
        sessionID,
        directory,
        mode: "hold",
        ...state.plan,
        note: state.note,
        streak: count,
        failures: 0,
        model: assistant ? { providerID: assistant.providerID, modelID: assistant.modelID } : null,
        agent: assistant?.agent ?? null,
        createdAt: now(),
        ...extra,
      })
      try {
        state.note = await writeNote(sessionID, assistant && !assistant.completed ? assistant.id : null, noteText(plan.resumeAt, now()))
        // Saved so a restart during the hold still resumes the session.
        await save(entry())
        if (!state.note) await toast(noteText(plan.resumeAt, now()))
        info(`${sessionID}: ChatGPT usage limit reached; holding the request until ${new Date(plan.resumeAt).toLocaleString()} (reset time from ${plan.source})`)

        while (!state.cancelled) {
          const wait = state.plan.resumeAt - now()
          if (wait > 0) {
            await sleep(Math.min(wait, TICK_MS), state)
            continue
          }
          // Check again before spending a request.
          const blockedUntil = resetFromLimits(await readUsage(), now())
          if (blockedUntil !== null && blockedUntil + config.bufferSeconds * 1000 > now() + 30_000) {
            const resumeAt = Math.min(blockedUntil + config.bufferSeconds * 1000, now() + config.maxWaitHours * 3_600_000)
            state.plan = { resumeAt, resetAt: blockedUntil, source: "usage" }
            if (state.note) await writeNote(sessionID, state.note.messageID, noteText(resumeAt, now()), state.note.partID)
            await save(entry())
            info(`${sessionID}: still limited; holding until ${new Date(resumeAt).toLocaleString()}`)
            continue
          }
          break
        }
      } finally {
        holds.delete(sessionID)
        limited.delete(sessionID)
        // On shutdown the saved hold stays: the next start deletes the note
        // and resumes the session.
        if (state.cancelled !== "shutdown") {
          await deleteNote(sessionID, state.note)
          // A fallback entry may have replaced the hold meanwhile; keep that one.
          if (pending.get(sessionID)?.mode === "hold") await drop(sessionID)
        }
      }
      if (state.cancelled) info(`${sessionID}: hold cancelled (${state.cancelled})`)
      else info(`${sessionID}: usage limit reset; sending the request again`)
    }

    function cancelHold(sessionID, reason) {
      const state = holds.get(sessionID)
      if (!state) return false
      state.cancelled = reason
      state.wake?.()
      return true
    }

    /* -- Fallback: resume after the session stopped ------------------------ */

    async function onFailed(sessionID, rawError) {
      const error = fromV1Error(rawError)
      limited.delete(sessionID)
      if (!isUsageLimitError(error)) return drop(sessionID)
      const assistant = await lastAssistant(sessionID)
      if (!allowedProvider(assistant?.providerID)) return
      if (!(await eligible(sessionID))) return
      const count = (streak.get(sessionID) ?? 0) + 1
      streak.set(sessionID, count)
      if (config.maxConsecutiveResumes > 0 && count > config.maxConsecutiveResumes) {
        streak.delete(sessionID)
        await drop(sessionID)
        info(`${sessionID}: usage limit hit ${count - 1} times in a row after resuming; giving up`)
        return
      }
      const usage = await readUsage()
      const plan = planResume({ error, usage, headers: limitsFromHeaders(error.response.headers, now()), nowMs: now(), config })
      // The failed message is not sent to the model again, so the note can stay.
      const note = await writeNote(sessionID, assistant?.id, noteText(plan.resumeAt, now()))
      await save({
        sessionID,
        directory,
        mode: "resume",
        ...plan,
        note,
        streak: count,
        failures: 0,
        model: { providerID: assistant.providerID, modelID: assistant.modelID },
        agent: assistant.agent ?? null,
        createdAt: now(),
      })
      if (!note) await toast(noteText(plan.resumeAt, now()))
      info(`${sessionID}: ChatGPT usage limit reached; resuming at ${new Date(plan.resumeAt).toLocaleString()} (reset time from ${plan.source})`)
    }

    async function cancelResume(sessionID, reason) {
      const entry = await drop(sessionID, reason)
      if (entry?.mode === "resume" && entry.note) await writeNote(sessionID, entry.note.messageID, "Automatic continue cancelled.", entry.note.partID)
    }

    async function fire(entry) {
      const sessionID = entry.sessionID
      let statuses = {}
      try {
        statuses = result(await client.session.status()) ?? {}
      } catch {}
      const status = statuses[sessionID]?.type
      if (status === "busy" || status === "retry") return drop(sessionID) // running again

      const blockedUntil = resetFromLimits(await readUsage(), now())
      if (blockedUntil !== null && blockedUntil + config.bufferSeconds * 1000 > now() + 30_000) {
        const resumeAt = Math.min(blockedUntil + config.bufferSeconds * 1000, now() + config.maxWaitHours * 3_600_000)
        await save({ ...entry, resumeAt, resetAt: blockedUntil, source: "usage" })
        if (entry.note) await writeNote(sessionID, entry.note.messageID, noteText(resumeAt, now()), entry.note.partID)
        info(`${sessionID}: still limited; resuming at ${new Date(resumeAt).toLocaleString()}`)
        return
      }

      resuming.add(sessionID)
      try {
        const response = await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            ...(entry.model?.providerID && entry.model?.modelID ? { model: entry.model } : {}),
            ...(entry.agent ? { agent: entry.agent } : {}),
            parts: [{ type: "text", text: config.message, synthetic: true }],
          },
        })
        if (response?.error) throw new Error(JSON.stringify(response.error))
        await drop(sessionID)
        if (entry.note) await writeNote(sessionID, entry.note.messageID, "ChatGPT usage limit reset. Continued automatically.", entry.note.partID)
        info(`${sessionID}: usage limit reset; session resumed`)
      } catch (error) {
        resuming.delete(sessionID)
        const failures = (entry.failures ?? 0) + 1
        if (failures >= MAX_SEND_FAILURES) return cancelResume(sessionID, `could not resume: ${error?.message ?? error}`)
        await save({ ...entry, failures, resumeAt: now() + SEND_RETRY_MS })
        debug(`${sessionID}: resume failed (${error?.message ?? error}); trying again in a minute`)
      }
    }

    function tick() {
      if (restoring) return
      const at = now()
      for (const entry of pending.values()) {
        if (entry.mode !== "resume" || entry.resumeAt > at || firing.has(entry.sessionID)) continue
        firing.add(entry.sessionID)
        void fire(entry)
          .catch((error) => debug(`${entry.sessionID}: ${error?.message ?? error}`))
          .finally(() => firing.delete(entry.sessionID))
      }
    }

    /* -- Events ----------------------------------------------------------- */

    async function onEvent(event) {
      const props = event?.properties ?? {}
      switch (event?.type) {
        case "message.updated": {
          const message = props.info
          if (message?.role !== "assistant" || !message.sessionID) return
          const value = remember(message)
          if (value.completed && !value.error && !holds.has(message.sessionID) && !limited.has(message.sessionID)) streak.delete(message.sessionID)
          return
        }
        case "session.status": {
          const sessionID = props.sessionID
          const type = props.status?.type
          if (!sessionID) return
          if (type === "retry") {
            if (holds.has(sessionID)) return
            const run = check(sessionID, props.status).catch((error) => debug(`${sessionID}: ${error?.message ?? error}`))
            checking.set(sessionID, run)
            await run
            if (checking.get(sessionID) === run) checking.delete(sessionID)
            return
          }
          if (type === "busy") {
            if (resuming.delete(sessionID)) return
            if (pending.get(sessionID)?.mode === "resume") {
              streak.delete(sessionID)
              await cancelResume(sessionID, "new input")
            }
            return
          }
          if (type === "idle") {
            limited.delete(sessionID)
            cancelHold(sessionID, "stopped")
          }
          return
        }
        case "session.error": {
          const sessionID = props.sessionID
          if (!sessionID) return
          if (props.error?.name === "MessageAbortedError") {
            streak.delete(sessionID)
            limited.delete(sessionID)
            if (cancelHold(sessionID, "interrupted")) return
            if (pending.get(sessionID)?.mode === "resume") return cancelResume(sessionID, "interrupted")
            return
          }
          if (holds.has(sessionID)) return
          return onFailed(sessionID, props.error)
        }
        case "session.deleted": {
          const sessionID = props.info?.id
          if (!sessionID) return
          cancelHold(sessionID, "session deleted")
          for (const map of [assistants, limited, streak, parents]) map.delete(sessionID)
          return drop(sessionID)
        }
      }
    }

    /* -- Restore and run -------------------------------------------------- */

    const state = await readState()
    const stale = []
    for (const [sessionID, value] of Object.entries(state.entries)) {
      if (!value || typeof value !== "object" || value.sessionID !== sessionID) continue
      if (directory && value.directory && value.directory !== directory) continue
      if (value.mode === "hold") {
        // The process stopped during a hold: resume by the clock instead.
        pending.set(sessionID, { ...value, mode: "resume", note: null })
        if (value.note) stale.push([sessionID, value.note])
      } else pending.set(sessionID, value)
      if (Number.isFinite(value.streak)) streak.set(sessionID, value.streak)
    }
    if (pending.size) info(`restored ${pending.size} pending resume(s)`)
    // Not awaited: OpenCode answers client calls only once plugins are loaded.
    // A held message is not marked as failed, so its note would reach the
    // model: delete it before anything resumes.
    const restored = (async () => {
      for (const [sessionID, note] of stale) {
        await deleteNote(sessionID, note)
        const entry = pending.get(sessionID)
        if (entry) await save(entry)
      }
    })().catch((error) => debug(`restore: ${error?.message ?? error}`))

    let restoring = true
    void restored.finally(() => (restoring = false))
    const timer = every(tick, TICK_MS)
    timer?.unref?.()

    return {
      event: async ({ event }) => {
        await onEvent(event).catch((error) => debug(`event ${event?.type}: ${error?.message ?? error}`))
      },
      "chat.headers": async (hookInput) => {
        const sessionID = hookInput?.sessionID
        if (!sessionID || !allowedProvider(hookInput.model?.providerID ?? hookInput.provider?.info?.id)) return
        await checking.get(sessionID)
        const plan = limited.get(sessionID)
        if (!plan || holds.has(sessionID)) return
        if (plan.resumeAt <= now()) {
          limited.delete(sessionID)
          return
        }
        await hold(sessionID, plan)
      },
      dispose: async () => {
        stopEvery(timer)
        for (const sessionID of holds.keys()) cancelHold(sessionID, "shutdown")
        await writing
      },
    }
  }
}

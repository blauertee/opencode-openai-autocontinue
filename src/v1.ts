// OpenCode 1 server plugin (checked against OpenCode 1.19.5). Same goal as the
// OpenCode 2 plugin in server.ts, but 1.x has no retry hook, no plugin storage
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
  errorText,
  resetFromLimits,
  type LimitError,
  type Plan,
  retryMayBeLimit,
  usageCleared,
} from "./logic.ts"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { AssistantMessage, Event, Message, Part, SessionStatus } from "@opencode-ai/sdk"
import { createLog, type Logger } from "./log.ts"
import { createUsageReader, type Bearer, type Fetch } from "./usage.ts"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const TICK_MS = 15_000
const SEND_RETRY_MS = 60_000
const MAX_SEND_FAILURES = 5
type Env = Record<string, string | undefined>
type Client = PluginInput["client"]
type V1Error = NonNullable<AssistantMessage["error"]>

/**
 * The generated client's raw transport. The plugin client does not wrap the
 * part endpoints, so the note is written through it.
 */
interface RawClient {
  patch(options: { url: string; path: Record<string, string>; body: unknown; headers?: Record<string, string> }): Promise<{ error?: unknown }>
  delete(options: { url: string; path: Record<string, string> }): Promise<{ error?: unknown }>
}

/** Where a note was written: a text part of an assistant message. */
export interface Note {
  messageID: string
  partID: string
}

/** What the plugin remembers about a session's latest assistant message. */
interface Known {
  id: string
  providerID: string
  modelID: string
  agent: string | undefined
  completed: boolean
  error: V1Error | null
}

/** A hold or pending resume, mirrored in the state file. */
export interface Entry extends Plan {
  sessionID: string
  directory: string | undefined
  mode: "hold" | "resume"
  note: Note | null
  streak: number
  failures: number
  deadline?: number
  model: { providerID: string; modelID: string } | null
  agent: string | null
  createdAt: number
}

interface State {
  entries: Record<string, Entry>
}

interface Hold {
  cancelled: false | "interrupted" | "stopped" | "session deleted" | "shutdown"
  wake: (() => void) | null
  note: Note | null
  plan: Plan
}

export interface Files {
  readFile(file: string, encoding: "utf8"): Promise<string>
  writeFile(file: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>
}

const PART_URL = "/session/{sessionID}/message/{messageID}/part/{partID}"

/* -- Files ------------------------------------------------------------------ */

const dataDir = (env: Env, home: string) => path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode")
const stateDir = (env: Env, home: string) => path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "opencode")

/** OpenCode 1 keeps provider credentials in `$XDG_DATA_HOME/opencode/auth.json`. */
export function authFile(env: Env = process.env, home = os.homedir()): string {
  return path.join(dataDir(env, home), "auth.json")
}

export function stateFile(env: Env = process.env, home = os.homedir()): string {
  return path.join(stateDir(env, home), "openai-autocontinue-v1.json")
}

/**
 * Bearer token and account ID from an OpenCode 1 auth entry
 * (`{ type: "oauth", access, refresh, expires, accountId }`). An expired token
 * is not used: OpenCode refreshes it on its next request, and refreshing it
 * here would rotate the refresh token behind OpenCode's back.
 */
export function bearerFromAuth(value: unknown, nowMs = Date.now()): Bearer | null {
  if (!value || typeof value !== "object") return null
  const entry = value as { type?: unknown; access?: unknown; expires?: unknown; accountId?: unknown; accountID?: unknown }
  if (entry.type !== "oauth" || typeof entry.access !== "string" || !entry.access) return null
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
export function fromV1Error(error: V1Error | null | undefined): LimitError | null {
  if (!error || typeof error !== "object") return null
  const data: { message?: string; statusCode?: number; responseHeaders?: Record<string, string>; responseBody?: string } =
    error.data && typeof error.data === "object" ? error.data : {}
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

/** The `data` of a generated-client response (which never throws). */
const result = <T>(response: { data?: T } | undefined): T | undefined => response?.data

export const PLUGIN_NAME = "opencode-openai-autocontinue"

function at(resumeAt: number, nowMs: number): string {
  const when = new Date(resumeAt)
  const sameDay = new Date(nowMs).toDateString() === when.toDateString()
  const time = sameDay
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  const delay = resumeAt - nowMs < 60_000 ? "in under a minute" : `in ${formatDelay(resumeAt - nowMs)}`
  return `${time} (${delay})`
}

/** Why the plugin believes the limit is reached, by where the reset time came from. */
function reason(source: Plan["source"], modelID: string | null | undefined): string {
  const model = modelID ? ` for ${modelID}` : ""
  switch (source) {
    case "usage":
      return `the ChatGPT usage endpoint reports the plan limit${model} as used up`
    case "error":
      return "OpenAI answered that the ChatGPT usage limit is reached"
    case "headers":
      return "OpenAI's rate-limit headers report the plan limit as used up"
    case "retry-after":
      return "OpenAI reported the usage limit and asked to retry later"
    default:
      return "OpenCode's retry says the usage limit is reached, but no reset time is known, so the plugin checks again then"
  }
}

/**
 * The note shown while the plugin holds a request back. It names the plugin,
 * says that nothing has been sent and how to cancel, so a held session is
 * never mistaken for a slow model or a stuck provider.
 */
export function holdNoteText(plan: Pick<Plan, "resumeAt" | "source">, nowMs: number, modelID?: string | null): string {
  return (
    `⏸ Held by the ${PLUGIN_NAME} plugin: this request has not been sent. ` +
    `Reason: ${reason(plan.source, modelID)}. ` +
    `It is sent automatically at ${at(plan.resumeAt, nowMs)}. ` +
    `Press Esc to cancel, or set the plugin option "enabled": false to turn this off.`
  )
}

/** The note left under a session that stopped and will be continued later. */
export function resumeNoteText(plan: Pick<Plan, "resumeAt" | "source">, nowMs: number, modelID?: string | null): string {
  return (
    `⏸ Stopped by the ChatGPT usage limit (${reason(plan.source, modelID)}). ` +
    `The ${PLUGIN_NAME} plugin will continue this session at ${at(plan.resumeAt, nowMs)}. ` +
    `Sending a message or pressing Esc cancels that.`
  )
}

const TOAST_EVERY_MS = 5 * 60_000

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
}: {
  fetch?: Fetch
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (timer: any) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (timer: any) => void
  logger?: Logger
  env?: Env
  home?: string
  files?: Files
} = {}): (input: Pick<PluginInput, "client" | "directory">, options?: Record<string, unknown>) => Promise<Hooks> {
  return async function server(input, options) {
    const config = normalizeConfig(options ?? {})
    const { info, debug } = createLog(config, logger)
    if (!config.enabled) return {}

    const client = input.client
    const internals = client as unknown as { _client?: RawClient; session?: { _client?: RawClient } } | undefined
    const raw = internals?._client ?? internals?.session?._client
    const directory = input.directory
    const statePath = stateFile(env, home)

    async function credential(): Promise<Bearer | null> {
      try {
        const text = env.OPENCODE_AUTH_CONTENT || (await files.readFile(authFile(env, home), "utf8"))
        const auth: Record<string, unknown> | null = JSON.parse(text)
        return bearerFromAuth(auth?.[config.usageIntegrationID], now())
      } catch {
        return null
      }
    }
    const readUsage = createUsageReader({ config, fetch: fetcher, now, log: debug, credential })

    /** sessionID -> latest assistant message `{ id, providerID, modelID, agent, completed }`. */
    const assistants = new Map<string, Known>()
    /** sessionID -> `{ resumeAt, resetAt, source }` once a retry was found to be a usage limit. */
    const limited = new Map<string, Plan>()
    /** sessionID -> promise of the usage check started by a retry. */
    const checking = new Map<string, Promise<void>>()
    /** sessionID -> the hold currently keeping a request back. */
    const holds = new Map<string, Hold>()
    /** sessionID -> durable entry (mirrored in the state file). */
    const pending = new Map<string, Entry>()
    const streak = new Map<string, number>()
    const resuming = new Set<string>()
    const firing = new Set<string>()
    const parents = new Map<string, string | null>()

    const allowedProvider = (providerID: unknown): providerID is string => typeof providerID === "string" && config.providerIDs.includes(providerID)

    /* -- State file ----------------------------------------------------- */

    let writing: Promise<void> = Promise.resolve()
    async function readState(): Promise<State> {
      try {
        const value = JSON.parse(await files.readFile(statePath, "utf8"))
        return value && typeof value === "object" && value.entries && typeof value.entries === "object" ? value : { entries: {} }
      } catch {
        return { entries: {} }
      }
    }
    function persist(sessionID: string, entry: Entry | null) {
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
        .catch((error) => debug(`could not write ${statePath}: ${errorText(error)}`))
      return writing
    }
    async function save(entry: Entry) {
      pending.set(entry.sessionID, entry)
      await persist(entry.sessionID, entry)
    }
    async function drop(sessionID: string, reason?: string): Promise<Entry | undefined> {
      const entry = pending.get(sessionID)
      if (!entry) return
      pending.delete(sessionID)
      await persist(sessionID, null)
      if (reason) info(`${sessionID}: pending resume cancelled (${reason})`)
      return entry
    }

    /* -- Session helpers ---------------------------------------------- */

    async function eligible(sessionID: string): Promise<boolean> {
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

    async function lastAssistant(sessionID: string): Promise<Known | null> {
      const known = assistants.get(sessionID)
      if (known) return known
      try {
        const messages = result(await client.session.messages({ path: { id: sessionID } })) ?? []
        const found = [...messages].reverse().find((item) => item?.info?.role === "assistant")?.info
        return found?.role === "assistant" ? remember(found) : null
      } catch {
        return null
      }
    }

    function remember(message: AssistantMessage & { agent?: string }): Known {
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

    async function writeNote(sessionID: string, messageID: string | null | undefined, text: string, id = partID(now())): Promise<Note | null> {
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
        debug(`${sessionID}: could not write the note: ${errorText(error)}`)
        return null
      }
    }

    async function deleteNote(sessionID: string, note: Note | null | undefined) {
      if (!raw || !note) return
      try {
        await raw.delete({ url: PART_URL, path: { sessionID, messageID: note.messageID, partID: note.partID } })
      } catch (error) {
        debug(`${sessionID}: could not delete the note: ${errorText(error)}`)
      }
    }

    async function toast(message: string, variant: "info" | "success" | "warning" | "error" = "warning") {
      try {
        await client.tui?.showToast?.({ body: { title: PLUGIN_NAME, message, variant, duration: 30_000 } })
      } catch {}
    }

    /**
     * The message a hold note goes into: the reply in progress, else the
     * session's latest assistant message (the note is deleted before the
     * request goes out, so the model never sees it either way).
     */
    async function noteTarget(sessionID: string, assistant: Known | null): Promise<string | null> {
      if (assistant && !assistant.completed) return assistant.id
      try {
        const messages = result(await client.session.messages({ path: { id: sessionID } })) ?? []
        const replies = messages.map((item) => item?.info).filter((info) => info?.role === "assistant")
        const target = replies.findLast((info) => !info.time?.completed) ?? replies.at(-1)
        if (target?.id) return target.id
      } catch (error) {
        debug(`${sessionID}: could not list messages for the note: ${errorText(error)}`)
      }
      return assistant?.id ?? null
    }

    /* -- Detecting a usage limit during OpenCode's retry ------------------ */

    async function check(sessionID: string, status: Extract<SessionStatus, { type: "retry" }>) {
      // Only a retry that can be the plan limit is checked: a header timeout,
      // network error or overloaded server is OpenCode's to retry, even while
      // some allowance on the account happens to be used up.
      if (!retryMayBeLimit(status?.message)) {
        limited.delete(sessionID)
        return
      }
      const assistant = await lastAssistant(sessionID)
      if (!allowedProvider(assistant?.providerID)) return
      if (!(await eligible(sessionID))) return
      const usage = await readUsage()
      const blockedUntil = resetFromLimits(usage, now(), assistant.modelID)
      const looksLikeLimit = /usage[ _-]?limit/i.test(status?.message ?? "")
      if (blockedUntil === null && !(usage === null && looksLikeLimit)) {
        limited.delete(sessionID)
        return
      }
      // Usage unreadable but the message says it is the plan limit: wait the
      // fallback and let the retry find out.
      const plan = planResume({ error: null, usage, headers: null, nowMs: now(), config, modelID: assistant.modelID })
      limited.set(sessionID, plan)
      debug(`${sessionID}: retry is a usage limit; holding until ${new Date(plan.resumeAt).toISOString()} (${plan.source})`)
    }

    /* -- Holding a request until the reset -------------------------------- */

    function sleep(ms: number, hold: Hold) {
      return new Promise<void>((resolve) => {
        const timer = later(resolve, ms)
        hold.wake = () => {
          cancelLater(timer)
          resolve()
        }
      })
    }

    async function hold(sessionID: string, plan: Plan) {
      const count = (streak.get(sessionID) ?? 0) + 1
      if (config.maxConsecutiveResumes > 0 && count > config.maxConsecutiveResumes) {
        streak.delete(sessionID)
        limited.delete(sessionID)
        info(`${sessionID}: usage limit hit ${count - 1} times in a row; letting the request fail`)
        return
      }
      streak.set(sessionID, count)

      const state: Hold = { cancelled: false, wake: null, note: null, plan }
      holds.set(sessionID, state)
      const assistant = await lastAssistant(sessionID)
      const modelID = assistant?.modelID
      // Fixed when the hold starts: re-checks may move the resume time, but
      // never past this, however often the limit turns out to last longer.
      const deadline = now() + config.maxWaitHours * 3_600_000
      const entry = (extra: Partial<Entry> = {}): Entry => ({
        sessionID,
        directory,
        mode: "hold",
        ...state.plan,
        note: state.note,
        streak: count,
        failures: 0,
        deadline,
        model: assistant ? { providerID: assistant.providerID, modelID: assistant.modelID } : null,
        agent: assistant?.agent ?? null,
        createdAt: now(),
        ...extra,
      })
      try {
        state.note = await writeNote(sessionID, await noteTarget(sessionID, assistant), holdNoteText(plan, now(), modelID))
        // Saved so a restart during the hold still resumes the session.
        await save(entry())
        // Without a note in the chat, a toast says it instead, again every few
        // minutes for as long as the hold lasts.
        let toastedAt = now()
        if (!state.note) await toast(holdNoteText(plan, now(), modelID))
        info(
          `${sessionID}: HOLDING the request (not sent) until ${new Date(plan.resumeAt).toLocaleString()}: ` +
            `${reason(plan.source, modelID)}${state.note ? "" : "; no note could be written to the chat"}`,
        )

        const interval = config.usageCheckMinutes * 60_000
        let checkedAt = now()
        while (!state.cancelled) {
          if (now() >= deadline) {
            info(`${sessionID}: held for maxWaitHours (${config.maxWaitHours}h); sending the request anyway`)
            break
          }
          const wait = Math.min(state.plan.resumeAt, deadline) - now()
          if (!state.note && now() - toastedAt >= TOAST_EVERY_MS) {
            toastedAt = now()
            await toast(holdNoteText(state.plan, now(), modelID))
          }
          if (wait > 0) {
            // Every few minutes: has the limit cleared early (a usage reset)?
            if (interval > 0 && wait > 60_000 && now() - checkedAt >= interval) {
              checkedAt = now()
              if (usageCleared(await readUsage(), now(), modelID)) {
                info(`${sessionID}: usage limit cleared before the reset time (usage reset?); continuing now`)
                break
              }
              continue
            }
            await sleep(Math.min(wait, TICK_MS), state)
            continue
          }
          // Check again before spending a request.
          const blockedUntil = resetFromLimits(await readUsage(), now(), modelID)
          if (blockedUntil !== null && blockedUntil + config.bufferSeconds * 1000 > now() + 30_000) {
            const resumeAt = Math.min(blockedUntil + config.bufferSeconds * 1000, deadline)
            state.plan = { resumeAt, resetAt: blockedUntil, source: "usage" }
            if (state.note) await writeNote(sessionID, state.note.messageID, holdNoteText(state.plan, now(), modelID), state.note.partID)
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

    function cancelHold(sessionID: string, reason: Exclude<Hold["cancelled"], false>) {
      const state = holds.get(sessionID)
      if (!state) return false
      state.cancelled = reason
      state.wake?.()
      return true
    }

    /* -- Fallback: resume after the session stopped ------------------------ */

    async function onFailed(sessionID: string, rawError: V1Error | undefined) {
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
      const deadline = now() + config.maxWaitHours * 3_600_000
      const plan = planResume({
        error,
        usage,
        headers: limitsFromHeaders(error.response?.headers, now()),
        nowMs: now(),
        config,
        modelID: assistant.modelID,
        deadline,
      })
      // The failed message is not sent to the model again, so the note can stay.
      const note = await writeNote(sessionID, assistant?.id, resumeNoteText(plan, now(), assistant.modelID))
      await save({
        sessionID,
        directory,
        mode: "resume",
        ...plan,
        note,
        streak: count,
        failures: 0,
        deadline,
        model: { providerID: assistant.providerID, modelID: assistant.modelID },
        agent: assistant.agent ?? null,
        createdAt: now(),
      })
      if (!note) await toast(resumeNoteText(plan, now(), assistant.modelID))
      info(`${sessionID}: ChatGPT usage limit reached; resuming at ${new Date(plan.resumeAt).toLocaleString()} (reset time from ${plan.source})`)
    }

    async function cancelResume(sessionID: string, reason: string) {
      const entry = await drop(sessionID, reason)
      if (entry?.mode === "resume" && entry.note) await writeNote(sessionID, entry.note.messageID, `Automatic continue by the ${PLUGIN_NAME} plugin cancelled.`, entry.note.partID)
    }

    async function fire(entry: Entry) {
      const sessionID = entry.sessionID
      let statuses: Record<string, SessionStatus> = {}
      try {
        statuses = result(await client.session.status()) ?? {}
      } catch {}
      const status = statuses[sessionID]?.type
      if (status === "busy" || status === "retry") return drop(sessionID) // running again

      // Entries saved before `deadline` existed are bounded from their creation.
      const deadline = entry.deadline ?? (entry.createdAt ?? now()) + config.maxWaitHours * 3_600_000
      const blockedUntil = resetFromLimits(await readUsage(), now(), entry.model?.modelID)
      if (now() < deadline && blockedUntil !== null && blockedUntil + config.bufferSeconds * 1000 > now() + 30_000) {
        const resumeAt = Math.min(blockedUntil + config.bufferSeconds * 1000, deadline)
        await save({ ...entry, resumeAt, resetAt: blockedUntil, source: "usage" })
        if (entry.note)
          await writeNote(sessionID, entry.note.messageID, resumeNoteText({ resumeAt, source: "usage" }, now(), entry.model?.modelID), entry.note.partID)
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
        if (entry.note) await writeNote(sessionID, entry.note.messageID, `ChatGPT usage limit reset. Continued automatically by the ${PLUGIN_NAME} plugin.`, entry.note.partID)
        info(`${sessionID}: usage limit reset; session resumed`)
      } catch (error) {
        resuming.delete(sessionID)
        const failures = (entry.failures ?? 0) + 1
        if (failures >= MAX_SEND_FAILURES) return cancelResume(sessionID, `could not resume: ${errorText(error)}`)
        await save({ ...entry, failures, resumeAt: now() + SEND_RETRY_MS })
        debug(`${sessionID}: resume failed (${errorText(error)}); trying again in a minute`)
      }
    }

    /** sessionID -> when the usage was last checked for an early resume. */
    const lastCheck = new Map()
    const checkingEarly = new Set()

    async function checkEarly(entry: Entry) {
      const sessionID = entry.sessionID
      lastCheck.set(sessionID, now())
      if (!usageCleared(await readUsage(), now(), entry.model?.modelID)) return
      const current = pending.get(sessionID)
      if (!current || current.mode !== "resume" || current.createdAt !== entry.createdAt || current.resumeAt <= now()) return
      info(`${sessionID}: usage limit cleared before the reset time (usage reset?); continuing now`)
      await save({ ...current, resumeAt: now() })
    }

    async function tick() {
      if (restoring) return
      const interval = config.usageCheckMinutes * 60_000
      if (interval > 0) {
        for (const entry of [...pending.values()]) {
          const sessionID = entry.sessionID
          if (entry.mode !== "resume" || entry.resumeAt - now() <= 60_000) continue
          if (firing.has(sessionID) || checkingEarly.has(sessionID)) continue
          if (now() - (lastCheck.get(sessionID) ?? entry.createdAt ?? 0) < interval) continue
          checkingEarly.add(sessionID)
          await checkEarly(entry)
            .catch((error) => debug(`${sessionID}: ${errorText(error)}`))
            .finally(() => checkingEarly.delete(sessionID))
        }
      }
      const at = now()
      for (const entry of pending.values()) {
        if (entry.mode !== "resume" || entry.resumeAt > at || firing.has(entry.sessionID)) continue
        firing.add(entry.sessionID)
        void fire(entry)
          .catch((error) => debug(`${entry.sessionID}: ${errorText(error)}`))
          .finally(() => firing.delete(entry.sessionID))
      }
    }

    /* -- Events ----------------------------------------------------------- */

    async function onEvent(event: Event) {
      switch (event?.type) {
        case "message.updated": {
          const message = event.properties.info
          if (message?.role !== "assistant" || !message.sessionID) return
          const value = remember(message)
          if (value.completed && !value.error && !holds.has(message.sessionID) && !limited.has(message.sessionID)) streak.delete(message.sessionID)
          return
        }
        case "session.status": {
          const { sessionID, status } = event.properties
          const type = status?.type
          if (!sessionID) return
          if (status?.type === "retry") {
            if (holds.has(sessionID)) return
            const run = check(sessionID, status).catch((error) => debug(`${sessionID}: ${errorText(error)}`))
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
          const { sessionID, error } = event.properties
          if (!sessionID) return
          if (error?.name === "MessageAbortedError") {
            streak.delete(sessionID)
            limited.delete(sessionID)
            if (cancelHold(sessionID, "interrupted")) return
            if (pending.get(sessionID)?.mode === "resume") return cancelResume(sessionID, "interrupted")
            return
          }
          if (holds.has(sessionID)) return
          return onFailed(sessionID, error)
        }
        case "session.deleted": {
          const sessionID = event.properties.info?.id
          if (!sessionID) return
          cancelHold(sessionID, "session deleted")
          for (const map of [assistants, limited, streak, parents, lastCheck]) map.delete(sessionID)
          return drop(sessionID)
        }
      }
    }

    /* -- Restore and run -------------------------------------------------- */

    const state = await readState()
    const stale: [string, Note][] = []
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
    })().catch((error) => debug(`restore: ${errorText(error)}`))

    let restoring = true
    void restored.finally(() => (restoring = false))
    const timer = every(() => void tick(), TICK_MS)
    ;(timer as { unref?: () => void } | undefined)?.unref?.()

    return {
      event: async ({ event }) => {
        await onEvent(event).catch((error) => debug(`event ${event?.type}: ${errorText(error)}`))
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

// OpenCode 2 server plugin (the OpenCode 1 adapter is in v1.ts): when a ChatGPT/Codex subscription usage limit
// stops a session, wait until the limit resets (plus a small buffer) and then
// continue that same session.
//
// How the wait is chosen, most reliable first:
//   1. the reset time in the error itself (`resets_at` / `resets_in_seconds`);
//   2. `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth
//      credential OpenCode already holds (no inference request is sent);
//   3. passive `x-codex-*` rate-limit headers seen on the session's responses;
//   4. the provider's `retry-after`, else a fixed fallback wait.
//
// Two ways to wait:
//   - short waits (<= inlineMaxWaitMinutes) use OpenCode's own retry: the
//     `retry` hook sets the delay, so the session shows a retry countdown and
//     the failed request is simply sent again;
//   - longer waits, or when OpenCode gives up anyway, let the session fail,
//     persist the resume time in plugin storage and, once it has passed (by
//     the wall clock, so a sleeping laptop or a restart is fine), re-check the
//     usage and add a synthetic "continue" message that resumes the session.
//
// Sending a new message to the session, interrupting it, or running
// /autocontinue-cancel cancels a pending resume.

import {
  formatDelay,
  isUsageLimitError,
  limitsFromHeaders,
  normalizeConfig,
  planResume,
  errorText,
  resetFromError,
  type LimitError,
  type Limits,
  type Plan,
  resetFromLimits,
  usageCleared,
} from "./logic.ts"
import type { Plugin } from "@opencode/plugin"
import { createLog, defaultLogFile, type Logger } from "./log.ts"
import { createUsageReader, type Fetch } from "./usage.ts"
import { createV1Server } from "./v1.ts"

export { defaultLogFile }

export const PLUGIN_ID = "openai-autocontinue"
const PENDING_PREFIX = "pending:"
const TICK_MS = 15_000
const SEND_RETRY_MS = 60_000
const MAX_SEND_FAILURES = 5

/** Model ID of an OpenCode 2 model reference (`{ id, providerID }`). */
const modelIDOf = (ref: { id?: string; modelID?: string } | null | undefined): string | undefined => ref?.id ?? ref?.modelID

/** A pending resume, mirrored in plugin storage. */
export interface Entry extends Plan {
  sessionID: string
  directory: string | undefined
  mode: "inline" | "planned" | "resume" | "stopping"
  deadline?: number
  modelID?: string | null
  streak: number
  failures: number
  createdAt: number
}

type Context = Plugin.Context
type StorageValue = Parameters<Context["storage"]["set"]>[1]
type SessionInfo = Awaited<ReturnType<Context["session"]["get"]>>
type OpenCodeEvent = Context["event"]["subscribe"] extends (...args: any[]) => AsyncIterable<infer E> ? E : never
type SessionID = Parameters<Context["session"]["get"]>[0]["sessionID"]

export function createAutoContinuePlugin({
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  setInterval: every = globalThis.setInterval,
  clearInterval: stopEvery = globalThis.clearInterval,
  logger,
}: {
  fetch?: Fetch
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (timer: any) => void
  logger?: Logger
} = {}): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx: Context) {
      const config = normalizeConfig(ctx.options ?? {})
      const { info, debug } = createLog(config, logger)
      if (!config.enabled) return

      const directory = ctx.location?.directory
      const readUsage = createUsageReader({ ctx, config, fetch: fetcher, now, log: debug })

      /** sessionID -> pending resume, mirrored in plugin storage. */
      const pending = new Map<string, Entry>()
      /** sessionID -> consecutive automatic resumes that hit the limit again. */
      const streak = new Map<string, number>()
      /** sessionID -> last usage-limit error seen by the retry hook, with its model. */
      const lastLimit = new Map<string, { error: LimitError; model: { id?: string; providerID?: string } | undefined; at: number }>()
      /** sessionID -> passive x-codex-* limits from the latest response. */
      const headerLimits = new Map<string, Limits>()
      /** Sessions this plugin is resuming right now. */
      const resuming = new Set<string>()
      /** Sessions being processed by the ticker. */
      const firing = new Set<string>()
      const sessionInfo = new Map<string, SessionInfo>()

      const allowedProvider = (providerID: unknown): boolean => typeof providerID === "string" && config.providerIDs.includes(providerID)
      const ours = (event: { location?: { directory?: string } }) => !directory || !event?.location?.directory || event.location.directory === directory

      async function getSession(sessionID: string, fresh = false): Promise<SessionInfo | null> {
        if (!fresh && sessionInfo.has(sessionID)) return sessionInfo.get(sessionID) ?? null
        try {
          const value = await ctx.session.get({ sessionID: sessionID as SessionID })
          if (value) sessionInfo.set(sessionID, value)
          return value ?? null
        } catch {
          return null
        }
      }

      async function eligible(sessionID: string) {
        if (config.resumeSubagents) return true
        const session = await getSession(sessionID)
        return !session?.parentID
      }

      async function save(entry: Entry) {
        pending.set(entry.sessionID, entry)
        // Plain JSON: storage drops undefined fields like JSON.stringify does.
        await ctx.storage.set(PENDING_PREFIX + entry.sessionID, entry as unknown as StorageValue).catch(() => {})
      }

      async function drop(sessionID: string, reason?: string) {
        const had = pending.delete(sessionID)
        await ctx.storage.remove(PENDING_PREFIX + sessionID).catch(() => {})
        if (had && reason) info(`${sessionID}: pending resume cancelled (${reason})`)
      }

      async function plan(sessionID: string, error: LimitError, modelID: string | null | undefined, deadline: number) {
        const at = now()
        const fromError = resetFromError(error, at)
        const usage = fromError === null || fromError <= at ? await readUsage() : null
        return planResume({ error, usage, headers: headerLimits.get(sessionID), nowMs: now(), config, modelID, deadline })
      }

      function describe(entry: Entry | undefined) {
        if (!entry) return "no resume pending"
        const when = new Date(entry.resumeAt)
        return `resuming at ${when.toLocaleString()} (in ${formatDelay(entry.resumeAt - now())}, reset time from ${entry.source})`
      }

      /* -- Passive headers ---------------------------------------------- */

      await ctx.session.hook("http.response", (event) => {
        if (!allowedProvider(event.model?.providerID)) return
        const limits = limitsFromHeaders(event.response?.headers, now())
        if (limits) headerLimits.set(event.sessionID, limits)
      })

      /* -- Short waits: OpenCode's own retry ----------------------------- */

      await ctx.session.hook("retry", async (event) => {
        if (!allowedProvider(event.model?.providerID) || !isUsageLimitError(event.error)) return
        lastLimit.set(event.sessionID, { error: event.error, model: event.model, at: now() })
        if (!(await eligible(event.sessionID))) return
        const deadline = now() + config.maxWaitHours * 3_600_000
        const result = await plan(event.sessionID, event.error, modelIDOf(event.model), deadline)
        const wait = Math.max(0, result.resumeAt - now())
        if (config.inlineMaxWaitMinutes > 0 && wait <= config.inlineMaxWaitMinutes * 60_000) {
          event.decision = { retry: true, delay: wait }
          await save({
            sessionID: event.sessionID,
            directory,
            mode: "inline",
            ...result,
            deadline,
            modelID: modelIDOf(event.model) ?? null,
            streak: streak.get(event.sessionID) ?? 0,
            failures: 0,
            createdAt: now(),
          })
          info(`${event.sessionID}: ChatGPT usage limit reached; retrying in place, ${describe(pending.get(event.sessionID))}`)
          return
        }
        // A long wait: stop OpenCode's blind retries now. The failure that
        // follows schedules the durable resume with this plan.
        event.decision = { retry: false }
        await save({
          sessionID: event.sessionID,
          directory,
          mode: "planned",
          ...result,
          deadline,
          modelID: modelIDOf(event.model) ?? null,
          streak: streak.get(event.sessionID) ?? 0,
          failures: 0,
          createdAt: now(),
        })
      })

      /* -- Long waits: durable resume after the session failed ----------- */

      async function onFailed(sessionID: string, error: LimitError) {
        if (!isUsageLimitError(error)) return drop(sessionID)
        const seen = lastLimit.get(sessionID)
        const model = seen?.model ?? (await getSession(sessionID, true))?.model
        const providerID = model?.providerID
        if (!allowedProvider(providerID)) return
        if (!(await eligible(sessionID))) return
        const count = (streak.get(sessionID) ?? 0) + 1
        streak.set(sessionID, count)
        if (config.maxConsecutiveResumes > 0 && count > config.maxConsecutiveResumes) {
          streak.delete(sessionID)
          await drop(sessionID)
          info(`${sessionID}: usage limit hit ${count - 1} times in a row after resuming; giving up`)
          return
        }
        const previous = pending.get(sessionID)
        const modelID = modelIDOf(model) ?? previous?.modelID ?? null
        const deadline = previous && previous.resumeAt > now() && previous.deadline ? previous.deadline : now() + config.maxWaitHours * 3_600_000
        const result =
          previous && previous.resumeAt > now()
            ? { resumeAt: previous.resumeAt, resetAt: previous.resetAt, source: previous.source }
            : await plan(sessionID, error, modelID, deadline)
        await save({ sessionID, directory, mode: "resume", ...result, deadline, modelID, streak: count, failures: 0, createdAt: now() })
        info(`${sessionID}: ChatGPT usage limit reached; ${describe(pending.get(sessionID))}`)
      }

      async function fire(entry: Entry) {
        const sessionID = entry.sessionID
        const session = await getSession(sessionID, true)
        if (!session) return drop(sessionID, "session not found")
        const busy = session.time?.busy && (!session.time?.idle || session.time.busy > session.time.idle)
        if (busy) return drop(sessionID) // it is running again; a new limit schedules anew

        // Re-check before spending a request: resume only when the usage data
        // no longer shows a blocking window (or cannot be read).
        // Entries saved before `deadline` existed are bounded from their creation.
        const deadline = entry.deadline ?? (entry.createdAt ?? now()) + config.maxWaitHours * 3_600_000
        const usage = await readUsage()
        const blockedUntil = resetFromLimits(usage, now(), entry.modelID ?? undefined)
        if (now() < deadline && blockedUntil !== null && blockedUntil + config.bufferSeconds * 1000 > now() + 30_000) {
          const resumeAt = Math.min(blockedUntil + config.bufferSeconds * 1000, deadline)
          await save({ ...entry, resumeAt, resetAt: blockedUntil, source: "usage" })
          info(`${sessionID}: still limited; ${describe(pending.get(sessionID))}`)
          return
        }

        resuming.add(sessionID)
        try {
          await ctx.session.synthetic({
            sessionID,
            text: config.message,
            description: "Auto-continue after the ChatGPT usage limit reset",
            metadata: { autocontinue: { resetAt: entry.resetAt ?? null, source: entry.source ?? null } },
            resume: true,
          })
          await drop(sessionID)
          info(`${sessionID}: usage limit reset; session resumed`)
        } catch (error) {
          resuming.delete(sessionID)
          const failures = (entry.failures ?? 0) + 1
          if (failures >= MAX_SEND_FAILURES) {
            await drop(sessionID, `could not resume: ${errorText(error)}`)
            return
          }
          await save({ ...entry, failures, resumeAt: now() + SEND_RETRY_MS })
          debug(`${sessionID}: resume failed (${errorText(error)}); trying again in a minute`)
        }
      }

      /* -- Early resume: the limit cleared before its reset time ------------ */

      /** Sessions this plugin interrupted to resume early. */
      const stoppedEarly = new Set()
      /** sessionID -> when the usage was last checked for an early resume. */
      const lastCheck = new Map<string, number>()
      const checking = new Set<string>()

      async function checkEarly(entry: Entry) {
        const sessionID = entry.sessionID
        lastCheck.set(sessionID, now())
        if (!usageCleared(await readUsage(), now(), entry.modelID ?? undefined)) return
        const current = pending.get(sessionID)
        if (!current || current.createdAt !== entry.createdAt || current.resumeAt <= now()) return
        info(`${sessionID}: usage limit cleared before the reset time (usage reset?); continuing now`)
        if (current.mode === "inline") {
          // OpenCode is sleeping out the retry delay: stop it, then resume
          // once the interrupt has landed.
          stoppedEarly.add(sessionID)
          await save({ ...current, mode: "stopping", resumeAt: now() })
          await ctx.session.interrupt({ sessionID }).catch(async (error) => {
            stoppedEarly.delete(sessionID)
            await save({ ...current })
            debug(`${sessionID}: could not stop the retry: ${errorText(error)}`)
          })
          return
        }
        await save({ ...current, resumeAt: now() })
      }

      async function tick() {
        const at = now()
        const interval = config.usageCheckMinutes * 60_000
        if (interval > 0) {
          for (const entry of pending.values()) {
            const sessionID = entry.sessionID
            if (entry.mode !== "resume" && entry.mode !== "inline") continue
            if (entry.resumeAt - at <= 60_000 || firing.has(sessionID) || checking.has(sessionID)) continue
            if (at - (lastCheck.get(sessionID) ?? entry.createdAt ?? 0) < interval) continue
            checking.add(sessionID)
            await checkEarly(entry)
              .catch((error) => debug(`${sessionID}: ${errorText(error)}`))
              .finally(() => checking.delete(sessionID))
          }
        }
        for (const entry of pending.values()) {
          if (entry.mode !== "resume" || entry.resumeAt > at || firing.has(entry.sessionID)) continue
          firing.add(entry.sessionID)
          void fire(entry)
            .catch((error) => debug(`${entry.sessionID}: ${errorText(error)}`))
            .finally(() => firing.delete(entry.sessionID))
        }
      }

      /* -- Session lifecycle --------------------------------------------- */

      async function onEvent(event: OpenCodeEvent) {
        if (!ours(event)) return
        switch (event.type) {
          case "session.execution.failed":
            return onFailed(event.data.sessionID, event.data.error)
          case "session.execution.succeeded": {
            const sessionID = event.data.sessionID
            streak.delete(sessionID)
            lastLimit.delete(sessionID)
            return drop(sessionID)
          }
          case "session.execution.interrupted": {
            const sessionID = event.data.sessionID
            if (event.data.reason === "shutdown") {
              // An in-place retry dies with the process; resume it next start.
              const entry = pending.get(sessionID)
              if (entry && entry.mode !== "resume") await save({ ...entry, mode: "resume" })
              return
            }
            // Our own stop to resume early: resume on the next tick.
            if (stoppedEarly.delete(sessionID)) {
              const entry = pending.get(sessionID)
              if (entry?.mode === "stopping") await save({ ...entry, mode: "resume" })
              return
            }
            streak.delete(sessionID)
            return drop(sessionID, `interrupted: ${event.data.reason}`)
          }
          case "session.execution.started": {
            const sessionID = event.data.sessionID
            if (resuming.delete(sessionID)) return
            // New input while a resume was waiting: the user took over.
            if (pending.get(sessionID)?.mode === "resume") {
              streak.delete(sessionID)
              return drop(sessionID, "new input")
            }
            return
          }
          case "session.deleted": {
            const sessionID = event.data.sessionID
            streak.delete(sessionID)
            sessionInfo.delete(sessionID)
            headerLimits.delete(sessionID)
            lastLimit.delete(sessionID)
            lastCheck.delete(sessionID)
            return drop(sessionID)
          }
        }
      }

      /* -- Cancel command -------------------------------------------------- */

      await ctx.command
        ?.transform?.((editor) => {
          editor.add({
            name: "autocontinue-cancel",
            description: "Cancel the pending automatic continue after a ChatGPT usage limit",
            execute: async ({ sessionID }) => {
              const entry = pending.get(sessionID)
              streak.delete(sessionID)
              await drop(sessionID, "cancelled by command")
              if (entry?.mode === "inline") await ctx.session.interrupt({ sessionID }).catch(() => {})
            },
          })
        })
        ?.catch?.((error) => debug(`could not register the cancel command: ${errorText(error)}`))

      /* -- Restore and run ------------------------------------------------- */

      try {
        let after: string | undefined
        do {
          const page = await ctx.storage.scan({ prefix: PENDING_PREFIX, after, limit: 100 })
          for (const { value: stored } of page.entries ?? []) {
            if (!stored || typeof stored !== "object" || Array.isArray(stored)) continue
            const value = stored as unknown as Partial<Entry>
            if (typeof value.sessionID !== "string") continue
            if (directory && value.directory && value.directory !== directory) continue
            // Whatever was waiting before the restart is resumed by the clock now.
            pending.set(value.sessionID, { ...(value as Entry), mode: "resume" })
            if (typeof value.streak === "number" && Number.isFinite(value.streak)) streak.set(value.sessionID, value.streak)
          }
          after = page.next
        } while (after)
        if (pending.size) info(`restored ${pending.size} pending resume(s)`)
      } catch (error) {
        debug(`could not restore pending resumes: ${errorText(error)}`)
      }

      const events = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          await onEvent(event).catch((error) => debug(`event ${event?.type}: ${errorText(error)}`))
        }
      })().catch(() => {})

      const timer = every(() => void tick(), TICK_MS)
      ;(timer as { unref?: () => void } | undefined)?.unref?.()

      return async () => {
        stopEvery(timer)
        events.abort()
      }
    },
  }
}

// One default export for both major versions: OpenCode 2 calls `setup(ctx)`
// (its loader ignores other keys), OpenCode 1 calls `server(input, options)`.
export default { ...createAutoContinuePlugin(), server: createV1Server() }

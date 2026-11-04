// OpenCode 2 server plugin: when a ChatGPT/Codex subscription usage limit
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
  resetFromError,
  resetFromLimits,
} from "./logic.js"
import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createUsageReader } from "./usage.js"

export const PLUGIN_ID = "openai-autocontinue"
const PENDING_PREFIX = "pending:"
const TICK_MS = 15_000
const SEND_RETRY_MS = 60_000
const MAX_SEND_FAILURES = 5

const unwrap = (value) => (value && typeof value === "object" && "data" in value && !("id" in value) ? value.data : value)

/** Default log file: OpenCode discards a background server's console output. */
export function defaultLogFile(env = process.env, home = os.homedir()) {
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state")
  return path.join(state, "opencode", "openai-autocontinue.log")
}

function fileLogger(file) {
  let ready
  return (message) => {
    ready ??= mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    void ready.then(() => appendFile(file, `${new Date().toISOString()} ${message}\n`)).catch(() => {})
  }
}

export function createAutoContinuePlugin({
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  setInterval: every = globalThis.setInterval,
  clearInterval: stopEvery = globalThis.clearInterval,
  logger,
} = {}) {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const config = normalizeConfig(ctx.options ?? {})
      const toFile = config.logFile === false ? null : fileLogger(config.logFile ?? defaultLogFile())
      const write =
        logger ??
        ((message) => {
          console.warn(`[autocontinue] ${message}`)
          toFile?.(message)
        })
      const info = (message) => write(message)
      const debug = (message) => {
        if (config.debug) write(message)
      }
      if (!config.enabled) return

      const directory = ctx.location?.directory
      const readUsage = createUsageReader({ ctx, config, fetch: fetcher, now, log: debug })

      /** sessionID -> pending resume, mirrored in plugin storage. */
      const pending = new Map()
      /** sessionID -> consecutive automatic resumes that hit the limit again. */
      const streak = new Map()
      /** sessionID -> last usage-limit error seen by the retry hook, with its model. */
      const lastLimit = new Map()
      /** sessionID -> passive x-codex-* limits from the latest response. */
      const headerLimits = new Map()
      /** Sessions this plugin is resuming right now. */
      const resuming = new Set()
      /** Sessions being processed by the ticker. */
      const firing = new Set()
      const sessionInfo = new Map()

      const allowedProvider = (providerID) => typeof providerID === "string" && config.providerIDs.includes(providerID)
      const ours = (event) => !directory || !event?.location?.directory || event.location.directory === directory

      async function getSession(sessionID, fresh = false) {
        if (!fresh && sessionInfo.has(sessionID)) return sessionInfo.get(sessionID)
        try {
          const value = unwrap(await ctx.session.get({ sessionID }))
          if (value) sessionInfo.set(sessionID, value)
          return value ?? null
        } catch {
          return null
        }
      }

      async function eligible(sessionID) {
        if (config.resumeSubagents) return true
        const session = await getSession(sessionID)
        return !session?.parentID
      }

      async function save(entry) {
        pending.set(entry.sessionID, entry)
        await ctx.storage.set(PENDING_PREFIX + entry.sessionID, entry).catch(() => {})
      }

      async function drop(sessionID, reason) {
        const had = pending.delete(sessionID)
        await ctx.storage.remove(PENDING_PREFIX + sessionID).catch(() => {})
        if (had && reason) info(`${sessionID}: pending resume cancelled (${reason})`)
      }

      async function plan(sessionID, error) {
        const at = now()
        const fromError = resetFromError(error, at)
        const usage = fromError === null || fromError <= at ? await readUsage() : null
        return planResume({ error, usage, headers: headerLimits.get(sessionID), nowMs: now(), config })
      }

      function describe(entry) {
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
        const result = await plan(event.sessionID, event.error)
        const wait = Math.max(0, result.resumeAt - now())
        if (config.inlineMaxWaitMinutes > 0 && wait <= config.inlineMaxWaitMinutes * 60_000) {
          event.decision = { retry: true, delay: wait }
          await save({
            sessionID: event.sessionID,
            directory,
            mode: "inline",
            ...result,
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
          streak: streak.get(event.sessionID) ?? 0,
          failures: 0,
          createdAt: now(),
        })
      })

      /* -- Long waits: durable resume after the session failed ----------- */

      async function onFailed(sessionID, error) {
        if (!isUsageLimitError(error)) return drop(sessionID)
        const seen = lastLimit.get(sessionID)
        const providerID = seen?.model?.providerID ?? (await getSession(sessionID, true))?.model?.providerID
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
        const result =
          previous && previous.resumeAt > now() ? { resumeAt: previous.resumeAt, resetAt: previous.resetAt, source: previous.source } : await plan(sessionID, error)
        await save({ sessionID, directory, mode: "resume", ...result, streak: count, failures: 0, createdAt: now() })
        info(`${sessionID}: ChatGPT usage limit reached; ${describe(pending.get(sessionID))}`)
      }

      async function fire(entry) {
        const sessionID = entry.sessionID
        const session = await getSession(sessionID, true)
        if (!session) return drop(sessionID, "session not found")
        const busy = session.time?.busy && (!session.time?.idle || session.time.busy > session.time.idle)
        if (busy) return drop(sessionID) // it is running again; a new limit schedules anew

        // Re-check before spending a request: resume only when the usage data
        // no longer shows a blocking window (or cannot be read).
        const usage = await readUsage()
        const blockedUntil = resetFromLimits(usage, now())
        if (blockedUntil !== null && blockedUntil + config.bufferSeconds * 1000 > now() + 30_000) {
          const resumeAt = Math.min(blockedUntil + config.bufferSeconds * 1000, now() + config.maxWaitHours * 3_600_000)
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
            await drop(sessionID, `could not resume: ${error?.message ?? error}`)
            return
          }
          await save({ ...entry, failures, resumeAt: now() + SEND_RETRY_MS })
          debug(`${sessionID}: resume failed (${error?.message ?? error}); trying again in a minute`)
        }
      }

      async function tick() {
        const at = now()
        for (const entry of pending.values()) {
          if (entry.mode !== "resume" || entry.resumeAt > at || firing.has(entry.sessionID)) continue
          firing.add(entry.sessionID)
          void fire(entry)
            .catch((error) => debug(`${entry.sessionID}: ${error?.message ?? error}`))
            .finally(() => firing.delete(entry.sessionID))
        }
      }

      /* -- Session lifecycle --------------------------------------------- */

      async function onEvent(event) {
        const sessionID = event?.data?.sessionID
        if (!sessionID || !ours(event)) return
        switch (event.type) {
          case "session.execution.failed":
            return onFailed(sessionID, event.data.error)
          case "session.execution.succeeded":
            streak.delete(sessionID)
            lastLimit.delete(sessionID)
            return drop(sessionID)
          case "session.execution.interrupted":
            if (event.data.reason === "shutdown") {
              // An in-place retry dies with the process; resume it next start.
              const entry = pending.get(sessionID)
              if (entry && entry.mode !== "resume") await save({ ...entry, mode: "resume" })
              return
            }
            streak.delete(sessionID)
            return drop(sessionID, `interrupted: ${event.data.reason}`)
          case "session.execution.started":
            if (resuming.delete(sessionID)) return
            // New input while a resume was waiting: the user took over.
            if (pending.get(sessionID)?.mode === "resume") {
              streak.delete(sessionID)
              return drop(sessionID, "new input")
            }
            return
          case "session.deleted":
            streak.delete(sessionID)
            sessionInfo.delete(sessionID)
            headerLimits.delete(sessionID)
            lastLimit.delete(sessionID)
            return drop(sessionID)
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
        ?.catch?.((error) => debug(`could not register the cancel command: ${error?.message ?? error}`))

      /* -- Restore and run ------------------------------------------------- */

      try {
        let after
        do {
          const page = await ctx.storage.scan({ prefix: PENDING_PREFIX, after, limit: 100 })
          for (const { value } of page.entries ?? []) {
            if (!value || typeof value !== "object" || typeof value.sessionID !== "string") continue
            if (directory && value.directory && value.directory !== directory) continue
            // Whatever was waiting before the restart is resumed by the clock now.
            pending.set(value.sessionID, { ...value, mode: "resume" })
            if (Number.isFinite(value.streak)) streak.set(value.sessionID, value.streak)
          }
          after = page.next
        } while (after)
        if (pending.size) info(`restored ${pending.size} pending resume(s)`)
      } catch (error) {
        debug(`could not restore pending resumes: ${error?.message ?? error}`)
      }

      const events = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          await onEvent(event).catch((error) => debug(`event ${event?.type}: ${error?.message ?? error}`))
        }
      })().catch(() => {})

      const timer = every(() => void tick(), TICK_MS)
      timer?.unref?.()

      return async () => {
        stopEvery(timer)
        events.abort()
      }
    },
  }
}

export default createAutoContinuePlugin()

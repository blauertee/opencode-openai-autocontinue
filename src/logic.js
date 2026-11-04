// Pure helpers: usage-limit detection, reset-time extraction and option
// normalisation. Nothing here does I/O, so it is all unit-tested.

export const DEFAULTS = Object.freeze({
  enabled: true,
  providerIDs: ["openai"],
  bufferSeconds: 60,
  fallbackWaitMinutes: 15,
  inlineMaxWaitMinutes: 60,
  maxWaitHours: 8 * 24,
  maxConsecutiveResumes: 8,
  usageCheckMinutes: 5,
  resumeSubagents: false,
  usageURL: "https://chatgpt.com/backend-api/wham/usage",
  usageIntegrationID: "openai",
  message:
    "The usage limit that stopped the previous response has reset. Continue the task from where you left off. Do not repeat work that is already complete.",
  debug: false,
  logFile: null,
})

const finite = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const positive = (value, fallback) => {
  const parsed = finite(value)
  return parsed !== null && parsed >= 0 ? parsed : fallback
}

export function normalizeConfig(options = {}) {
  const input = options && typeof options === "object" ? options : {}
  const providerIDs = Array.isArray(input.providerIDs)
    ? input.providerIDs.filter((id) => typeof id === "string" && id)
    : DEFAULTS.providerIDs
  return {
    enabled: input.enabled !== false,
    providerIDs: providerIDs.length ? providerIDs : DEFAULTS.providerIDs,
    bufferSeconds: positive(input.bufferSeconds, DEFAULTS.bufferSeconds),
    fallbackWaitMinutes: positive(input.fallbackWaitMinutes, DEFAULTS.fallbackWaitMinutes) || DEFAULTS.fallbackWaitMinutes,
    inlineMaxWaitMinutes: positive(input.inlineMaxWaitMinutes, DEFAULTS.inlineMaxWaitMinutes),
    maxWaitHours: positive(input.maxWaitHours, DEFAULTS.maxWaitHours) || DEFAULTS.maxWaitHours,
    maxConsecutiveResumes: Math.floor(positive(input.maxConsecutiveResumes, DEFAULTS.maxConsecutiveResumes)),
    usageCheckMinutes: positive(input.usageCheckMinutes, DEFAULTS.usageCheckMinutes),
    resumeSubagents: input.resumeSubagents === true,
    usageURL: typeof input.usageURL === "string" && input.usageURL ? input.usageURL : DEFAULTS.usageURL,
    usageIntegrationID:
      typeof input.usageIntegrationID === "string" && input.usageIntegrationID
        ? input.usageIntegrationID
        : DEFAULTS.usageIntegrationID,
    message: typeof input.message === "string" && input.message.trim() ? input.message : DEFAULTS.message,
    debug: input.debug === true,
    // null: the default file; false: no file; a string: that file.
    logFile: input.logFile === false ? false : typeof input.logFile === "string" && input.logFile ? input.logFile : null,
  }
}

/* -- Detection -------------------------------------------------------------- */

// Error codes the ChatGPT subscription backends use for an exhausted plan
// allowance. `usage_limit_reached` comes from the Codex backend
// (chatgpt.com/backend-api/codex, used by the "ChatGPT browser/headless"
// sign-in); `subscription_sharing_usage_limit_exceeded` from ChatGPT token
// sharing on api.openai.com. OpenCode maps the latter to the session error type
// `provider.chatgpt-limit`.
const LIMIT_CODES = ["usage_limit_reached", "subscription_sharing_usage_limit_exceeded"]

// Codes that look similar but are not cured by waiting.
const NOT_WAITABLE = ["usage_not_included", "insufficient_quota", "subscription_sharing_user_not_eligible"]

/** Whether a structured OpenCode session error is a ChatGPT plan usage limit. */
export function isUsageLimitError(error) {
  if (!error || typeof error !== "object") return false
  const body = typeof error.response?.body === "string" ? error.response.body : ""
  if (NOT_WAITABLE.some((code) => body.includes(code))) return false
  if (error.type === "provider.chatgpt-limit") return true
  return LIMIT_CODES.some((code) => body.includes(code))
}

/* -- Reset times ------------------------------------------------------------ */

const parseJSON = (text) => {
  if (typeof text !== "string" || !text) return null
  try {
    return JSON.parse(text)
  } catch {
    // Stream errors can arrive as an SSE frame: `data: {...}`.
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

/** Epoch seconds from a seconds or milliseconds timestamp. */
const epochSeconds = (value) => {
  const parsed = finite(value)
  if (parsed === null || parsed <= 0) return null
  return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed)
}

/**
 * Reset time (epoch ms) carried in the error body itself, as the Codex backend
 * sends it: `{"error":{"type":"usage_limit_reached","resets_at":<s>}}` or
 * `resets_in_seconds`. Returns null when the body has none.
 */
export function resetFromError(error, nowMs = Date.now()) {
  const parsed = parseJSON(error?.response?.body)
  const candidates = [parsed?.error, parsed, parsed?.response?.error].filter((item) => item && typeof item === "object")
  for (const item of candidates) {
    const at = epochSeconds(item.resets_at ?? item.reset_at ?? item.resetsAt)
    if (at !== null) return at * 1000
    const after = finite(item.resets_in_seconds ?? item.reset_after_seconds ?? item.resetsInSeconds)
    if (after !== null && after >= 0) return nowMs + after * 1000
  }
  return null
}

function windowFrom(raw, nowSec) {
  if (!raw || typeof raw !== "object") return null
  const used = finite(raw.used_percent ?? raw.usedPercent)
  let resetAt = epochSeconds(raw.reset_at ?? raw.resets_at ?? raw.resetsAt)
  if (resetAt === null) {
    const after = finite(raw.reset_after_seconds ?? raw.resets_in_seconds)
    if (after !== null && after >= 0) resetAt = nowSec + Math.ceil(after)
  }
  if (used === null && resetAt === null) return null
  return { usedPercent: used, resetAt }
}

function limitFrom(raw, nowSec, name) {
  if (!raw || typeof raw !== "object") return null
  const windows = [raw.primary_window ?? raw.primary, raw.secondary_window ?? raw.secondary]
    .map((item) => windowFrom(item, nowSec))
    .filter(Boolean)
  const reached = raw.limit_reached === true || raw.allowed === false
  if (!windows.length && !reached) return null
  return { name, reached, windows }
}

/**
 * Normalises a `GET /backend-api/wham/usage` payload into
 * `{ main, additional[] }` limits with `{ usedPercent, resetAt (epoch s) }`
 * windows. The endpoint is undocumented, so every field is optional.
 */
export function limitsFromUsage(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object") return null
  const nowSec = Math.floor(nowMs / 1000)
  const main = limitFrom(payload.rate_limit ?? payload.rateLimit, nowSec, "codex")
  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
        .map((item) =>
          limitFrom(item?.rate_limit ?? item?.rateLimit, nowSec, String(item?.limit_name ?? item?.metered_feature ?? "additional")),
        )
        .filter(Boolean)
    : []
  if (!main && !additional.length) return null
  return { main, additional }
}

/**
 * Passive `x-codex-*` rate-limit headers (sent by the Codex backend on every
 * response, including the 429) as the same limit shape.
 */
export function limitsFromHeaders(headers, nowMs = Date.now()) {
  if (!headers) return null
  const get = (name) => {
    if (typeof headers.get === "function") return headers.get(name)
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name)
    return key === undefined ? null : headers[key]
  }
  const nowSec = Math.floor(nowMs / 1000)
  const windows = ["primary", "secondary"]
    .map((slot) =>
      windowFrom(
        {
          used_percent: get(`x-codex-${slot}-used-percent`),
          reset_at: get(`x-codex-${slot}-reset-at`),
          reset_after_seconds: get(`x-codex-${slot}-reset-after-seconds`),
        },
        nowSec,
      ),
    )
    .filter(Boolean)
  if (!windows.length) return null
  return { main: { name: "codex", reached: false, windows }, additional: [] }
}

const exhausted = (window) => window.usedPercent !== null && window.usedPercent >= 100

function blockingReset(limit, nowSec) {
  if (!limit) return null
  const future = limit.windows.filter((window) => window.resetAt !== null && window.resetAt > nowSec)
  const full = future.filter(exhausted)
  // Every exhausted window has to reset before requests are allowed again.
  if (full.length) return Math.max(...full.map((window) => window.resetAt))
  // Reported as blocked without a full window: wait for the nearest reset and
  // check again then.
  if (limit.reached && future.length) return Math.min(...future.map((window) => window.resetAt))
  return null
}

/**
 * When the account is allowed to make requests again (epoch ms), or null when
 * the usage data shows nothing blocking. The account-wide limit decides; a
 * model-scoped additional limit is used only when the account-wide one is not
 * blocking, so a reserve pool never stretches the wait for other models.
 */
export function resetFromLimits(limits, nowMs = Date.now()) {
  if (!limits) return null
  const nowSec = Math.floor(nowMs / 1000)
  const main = blockingReset(limits.main, nowSec)
  if (main !== null) return main * 1000
  const extra = limits.additional.map((limit) => blockingReset(limit, nowSec)).filter((value) => value !== null)
  return extra.length ? Math.min(...extra) * 1000 : null
}

/**
 * Whether usage data was read and shows nothing blocking, for example after
 * the user redeemed a usage reset. Unreadable usage (null) is not "cleared".
 */
export function usageCleared(limits, nowMs = Date.now()) {
  return Boolean(limits) && resetFromLimits(limits, nowMs) === null
}

/** Whether the usage data says the account is still blocked. */
export function stillBlocked(limits, nowMs = Date.now()) {
  return resetFromLimits(limits, nowMs) !== null
}

/**
 * Picks the moment to resume (epoch ms): the first known reset among the
 * sources, in order of reliability, plus the buffer; else `retryAfterMs`; else
 * the fallback wait. The result is clamped to `maxWaitHours`.
 */
export function planResume({ error, usage, headers, nowMs = Date.now(), config }) {
  const sources = [
    ["error", () => resetFromError(error, nowMs)],
    ["usage", () => resetFromLimits(usage, nowMs)],
    ["headers", () => resetFromLimits(headers, nowMs)],
  ]
  let resetAt = null
  let source = "fallback"
  for (const [name, read] of sources) {
    const value = read()
    if (value !== null && value > nowMs - 5_000) {
      resetAt = value
      source = name
      break
    }
  }
  let resumeAt
  if (resetAt !== null) resumeAt = Math.max(resetAt, nowMs) + config.bufferSeconds * 1000
  else if (finite(error?.retryAfterMs) !== null && error.retryAfterMs > 0) {
    resumeAt = nowMs + error.retryAfterMs + config.bufferSeconds * 1000
    source = "retry-after"
  } else resumeAt = nowMs + config.fallbackWaitMinutes * 60_000
  const latest = nowMs + config.maxWaitHours * 3_600_000
  return { resumeAt: Math.min(resumeAt, latest), resetAt, source }
}

export function formatDelay(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

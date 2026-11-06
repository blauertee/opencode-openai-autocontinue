import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isUsageLimitError,
  limitsFromHeaders,
  limitsFromUsage,
  normalizeConfig,
  planResume,
  resetFromError,
  resetFromLimits,
  retryMayBeLimit,
  usageCleared,
} from "../src/logic.ts"

const NOW = 1_800_000_000_000
const NOW_S = NOW / 1000
const config = normalizeConfig({})

const codexError = (body) => ({ type: "provider.quota", message: "The usage limit has been reached", status: 429, response: { body: JSON.stringify(body) } })

test("detects both ChatGPT subscription limit shapes and nothing else", () => {
  assert.equal(isUsageLimitError({ type: "provider.chatgpt-limit", message: "x" }), true)
  assert.equal(isUsageLimitError(codexError({ error: { type: "usage_limit_reached", resets_at: NOW_S + 60 } })), true)
  assert.equal(
    isUsageLimitError({ type: "provider.chatgpt-limit", message: "x", response: { body: '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}' } }),
    true,
  )
  assert.equal(isUsageLimitError({ type: "provider.rate-limit", message: "slow down", status: 429 }), false)
  assert.equal(isUsageLimitError(codexError({ error: { type: "insufficient_quota" } })), false)
  assert.equal(isUsageLimitError(codexError({ error: { type: "usage_not_included" } })), false)
  assert.equal(isUsageLimitError(null), false)
})

test("reads the reset from the error body", () => {
  assert.equal(resetFromError(codexError({ error: { type: "usage_limit_reached", resets_at: NOW_S + 600 } }), NOW), NOW + 600_000)
  assert.equal(resetFromError(codexError({ error: { type: "usage_limit_reached", resets_in_seconds: 90 } }), NOW), NOW + 90_000)
  assert.equal(resetFromError({ response: { body: `data: ${JSON.stringify({ error: { resets_at: NOW_S + 5 } })}\n\n` } }, NOW), NOW + 5_000)
  assert.equal(resetFromError({ type: "provider.chatgpt-limit" }, NOW), null)
})

test("normalises the wham usage payload and picks the blocking reset", () => {
  const payload = {
    plan_type: "plus",
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: NOW_S + 3600 },
      secondary_window: { used_percent: 73, limit_window_seconds: 604800, reset_at: NOW_S + 86400 },
    },
  }
  const limits = limitsFromUsage(payload, NOW)
  assert.equal(limits.main.windows.length, 2)
  assert.equal(resetFromLimits(limits, NOW), (NOW_S + 3600) * 1000)

  // Weekly exhausted too: wait for the later of the two.
  payload.rate_limit.secondary_window.used_percent = 100
  assert.equal(resetFromLimits(limitsFromUsage(payload, NOW), NOW), (NOW_S + 86400) * 1000)

  // Nothing blocking.
  const fine = limitsFromUsage({ rate_limit: { allowed: true, primary_window: { used_percent: 12, reset_at: NOW_S + 10 } } }, NOW)
  assert.equal(resetFromLimits(fine, NOW), null)
})

test("blocked without a full window waits for the nearest reset", () => {
  const limits = limitsFromUsage(
    {
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 99.6, reset_at: NOW_S + 100 },
        secondary_window: { used_percent: 50, reset_at: NOW_S + 5000 },
      },
    },
    NOW,
  )
  assert.equal(resetFromLimits(limits, NOW), (NOW_S + 100) * 1000)
})

test("a model-scoped limit blocks only the model it names", () => {
  const limits = limitsFromUsage(
    {
      rate_limit: { allowed: true, primary_window: { used_percent: 10, reset_at: NOW_S + 100 } },
      additional_rate_limits: [
        { limit_name: "GPT-5.3-Codex-Spark", rate_limit: { limit_reached: true, primary_window: { used_percent: 100, reset_at: NOW_S + 7200 } } },
      ],
    },
    NOW,
  )
  assert.equal(resetFromLimits(limits, NOW, "gpt-5.3-codex-spark"), (NOW_S + 7200) * 1000)
  assert.equal(resetFromLimits(limits, NOW, "openai/gpt-5.3-codex-spark"), (NOW_S + 7200) * 1000)
  // Another model, or no model at all, is not held by it.
  assert.equal(resetFromLimits(limits, NOW, "gpt-5.3-codex"), null)
  assert.equal(resetFromLimits(limits, NOW), null)
  assert.equal(usageCleared(limits, NOW, "gpt-5.5"), true)
  assert.equal(planResume({ error: null, usage: limits, nowMs: NOW, config: normalizeConfig({}), modelID: "gpt-5.5" }).source, "fallback")
})

test("a retry message is checked against the usage only when it can be a limit", () => {
  assert.equal(retryMayBeLimit("The usage limit has been reached"), true)
  assert.equal(retryMayBeLimit("Too Many Requests"), true)
  assert.equal(retryMayBeLimit("Rate limit reached"), true)
  assert.equal(retryMayBeLimit("Provider response headers timed out after 300000ms"), false)
  assert.equal(retryMayBeLimit("Provider is overloaded"), false)
  assert.equal(retryMayBeLimit("fetch failed"), false)
  assert.equal(retryMayBeLimit(undefined), false)
})

test("planResume respects an absolute deadline", () => {
  const usage = limitsFromUsage({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100, reset_at: NOW_S + 86400 } } }, NOW)
  assert.equal(planResume({ error: null, usage, nowMs: NOW, config: normalizeConfig({}), deadline: NOW + 3_600_000 }).resumeAt, NOW + 3_600_000)
})

test("reads passive x-codex headers", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-reset-after-seconds": "120",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-reset-at": String(NOW_S + 9999),
  })
  const limits = limitsFromHeaders(headers, NOW)
  assert.equal(resetFromLimits(limits, NOW), NOW + 120_000)
  assert.equal(limitsFromHeaders(new Headers(), NOW), null)
})

test("plans with source priority, buffer, fallback and cap", () => {
  const error = codexError({ error: { type: "usage_limit_reached", resets_at: NOW_S + 600 } })
  const usage = limitsFromUsage({ rate_limit: { primary_window: { used_percent: 100, reset_at: NOW_S + 1200 } } }, NOW)
  assert.deepEqual(planResume({ error, usage, nowMs: NOW, config }), { resumeAt: NOW + 660_000, resetAt: NOW + 600_000, source: "error" })
  assert.equal(planResume({ error: { type: "provider.chatgpt-limit" }, usage, nowMs: NOW, config }).source, "usage")
  assert.deepEqual(planResume({ error: { type: "provider.chatgpt-limit" }, nowMs: NOW, config }), {
    resumeAt: NOW + 15 * 60_000,
    resetAt: null,
    source: "fallback",
  })
  assert.equal(
    planResume({ error: { type: "provider.chatgpt-limit", retryAfterMs: 30_000 }, nowMs: NOW, config }).resumeAt,
    NOW + 90_000,
  )
  const far = codexError({ error: { type: "usage_limit_reached", resets_at: NOW_S + 30 * 86400 } })
  assert.equal(planResume({ error: far, nowMs: NOW, config }).resumeAt, NOW + 8 * 24 * 3_600_000)
})

test("normalises options", () => {
  const value = normalizeConfig({ providerIDs: ["openai", "", 3, "chatgpt"], bufferSeconds: "30", inlineMaxWaitMinutes: 0, enabled: false })
  assert.deepEqual(value.providerIDs, ["openai", "chatgpt"])
  assert.equal(value.bufferSeconds, 30)
  assert.equal(value.inlineMaxWaitMinutes, 0)
  assert.equal(value.enabled, false)
  assert.equal(normalizeConfig({ bufferSeconds: -5 }).bufferSeconds, 60)
})

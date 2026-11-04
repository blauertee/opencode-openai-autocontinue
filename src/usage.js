// Reads the ChatGPT plan usage (`GET /backend-api/wham/usage`, the endpoint
// the Codex CLI uses) with the OAuth credential OpenCode already holds for the
// OpenAI integration. OpenCode owns that credential and refreshes it when it is
// resolved, so nothing is refreshed or written here. The endpoint is not a
// public API: every failure returns null and the caller falls back.

import { limitsFromUsage } from "./logic.js"

/** Bearer token and account ID from an OpenCode 2 credential value. */
export function bearerFrom(credential) {
  if (!credential || credential.type !== "oauth") return null
  if (typeof credential.access !== "string" || !credential.access) return null
  const accountID = credential.metadata?.accountID ?? credential.metadata?.accountId
  return { access: credential.access, accountID: typeof accountID === "string" && accountID ? accountID : null }
}

/**
 * `credential` overrides how the bearer is found (OpenCode 1 has no
 * integration API); it returns `{ access, accountID }` or null.
 */
export function createUsageReader({ ctx, config, fetch: fetcher = globalThis.fetch, now = Date.now, log, credential: findCredential }) {
  let cached
  async function credential() {
    if (findCredential) return findCredential()
    const connection = await ctx.integration?.connection?.active?.(config.usageIntegrationID)
    if (!connection) return null
    return bearerFrom(await ctx.integration.connection.resolve(connection))
  }

  /** Normalised limits, or null. Results are reused for 30 seconds. */
  return async function readUsage() {
    if (cached && now() - cached.at < 30_000) return cached.value
    let value = null
    try {
      const auth = await credential()
      if (!auth) return null
      const headers = { Authorization: `Bearer ${auth.access}`, Accept: "application/json" }
      if (auth.accountID) headers["ChatGPT-Account-Id"] = auth.accountID
      const response = await fetcher(config.usageURL, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        log?.(`usage endpoint answered HTTP ${response.status}`)
        return null
      }
      value = limitsFromUsage(await response.json(), now())
    } catch (error) {
      log?.(`usage endpoint failed: ${error?.message ?? error}`)
      return null
    }
    cached = { at: now(), value }
    return value
  }
}

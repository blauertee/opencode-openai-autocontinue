// Reads the ChatGPT plan usage (`GET /backend-api/wham/usage`, the endpoint
// the Codex CLI uses) with the OAuth credential OpenCode already holds for the
// OpenAI integration. OpenCode owns that credential and refreshes it when it is
// resolved, so nothing is refreshed or written here. The endpoint is not a
// public API: every failure returns null and the caller falls back.

import type { Credential, Plugin } from "@opencode/plugin"
import { errorText, limitsFromUsage, type Config, type Limits } from "./logic.ts"
import type { Logger } from "./log.ts"

export interface Bearer {
  access: string
  accountID: string | null
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Bearer token and account ID from an OpenCode 2 credential value. */
export function bearerFrom(credential: Credential.Value | null | undefined): Bearer | null {
  if (!credential || credential.type !== "oauth") return null
  if (typeof credential.access !== "string" || !credential.access) return null
  const metadata: Record<string, unknown> = credential.metadata ?? {}
  const accountID = metadata.accountID ?? metadata.accountId
  return { access: credential.access, accountID: typeof accountID === "string" && accountID ? accountID : null }
}

/**
 * `credential` overrides how the bearer is found (OpenCode 1 has no
 * integration API); it returns `{ access, accountID }` or null.
 */
export function createUsageReader({
  ctx,
  config,
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  log,
  credential: findCredential,
}: {
  ctx?: Pick<Plugin.Context, "integration">
  config: Pick<Config, "usageURL" | "usageIntegrationID">
  fetch?: Fetch
  now?: () => number
  log?: Logger
  credential?: () => Promise<Bearer | null>
}): () => Promise<Limits | null> {
  let cached: { at: number; value: Limits | null } | undefined
  async function credential(): Promise<Bearer | null> {
    if (findCredential) return findCredential()
    if (!ctx) return null
    const connection = await ctx.integration.connection.active(config.usageIntegrationID)
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
      const headers: Record<string, string> = { Authorization: `Bearer ${auth.access}`, Accept: "application/json" }
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
      log?.(`usage endpoint failed: ${errorText(error)}`)
      return null
    }
    cached = { at: now(), value }
    return value
  }
}

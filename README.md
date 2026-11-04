# opencode-openai-autocontinue

An [OpenCode 2](https://opencode.ai) plugin for OpenAI models used through a
**ChatGPT/Codex subscription** (ChatGPT sign-in, not an API key). When the plan's
usage limit stops a session, it works out when the limit resets, waits until then
plus a small buffer, and continues the same session. It sends no extra model
requests while it waits.

## What it does

1. **Detects a real usage limit.** It only acts on the subscription's
   usage-limit errors. These are `usage_limit_reached` from the Codex backend
   (ChatGPT browser or headless sign-in) and
   `subscription_sharing_usage_limit_exceeded` / `provider.chatgpt-limit` from
   ChatGPT token sharing. Ordinary throttling (`provider.rate-limit`), API-key
   quota (`insufficient_quota`) and plans without Codex (`usage_not_included`)
   are left to OpenCode.
2. **Finds the reset time.** It checks these sources in order:
   - the `resets_at` / `resets_in_seconds` in the error itself;
   - `GET https://chatgpt.com/backend-api/wham/usage`, called with the OAuth
     credential OpenCode already holds for OpenAI. This is the endpoint the
     Codex CLI uses. If both the 5-hour and the weekly window are exhausted, it
     waits for the later reset;
   - the passive `x-codex-*` rate-limit headers on the session's last response;
   - the provider's `retry-after`, else a 15 minute fallback.
3. **Waits.**
   - Short waits (60 minutes or less by default) go through OpenCode's own
     `retry` hook. The session shows its normal retry countdown, and the failed
     request is sent once more when the limit resets.
   - Longer waits, such as a weekly limit, let the session stop with the usage
     error. The resume time is saved in plugin storage and checked against the
     wall clock, so it still fires after a laptop sleeps or OpenCode restarts.
4. **Checks again, then continues.** When the time comes it reads the usage
   endpoint once more. If the account is still limited, it waits for the new
   reset. Otherwise it adds a short synthetic "continue where you left off"
   message that resumes the session, so finished work is not repeated.

### Cancelling

Any of these cancels a pending resume:

- sending the session a new message;
- interrupting it (Esc);
- running `/autocontinue-cancel` in it.

Subagent sessions are not resumed on their own (their parent is), and after 8
limits in a row right after resuming, the plugin stops trying.

## Install

```sh
opencode plugin add 'git+https://github.com/blauertee/opencode-openai-autocontinue.git'
```

Or add a local checkout to `plugins` in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-openai-autocontinue"]
}
```

Sign in to OpenAI with your ChatGPT account (`opencode auth`, or `/connect` in
the TUI). The plugin has no dependencies and no build step.

## Options

Options go on the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "git+https://github.com/blauertee/opencode-openai-autocontinue.git",
      "options": { "bufferSeconds": 120 }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the plugin off without uninstalling it. |
| `providerIDs` | `["openai"]` | Providers whose usage-limit errors are handled. |
| `bufferSeconds` | `60` | Extra wait after the reported reset. |
| `inlineMaxWaitMinutes` | `60` | Longest wait handled by retrying in place. `0` always uses the durable resume. |
| `fallbackWaitMinutes` | `15` | Wait used when no reset time can be found. |
| `maxWaitHours` | `192` | Upper bound on any single wait. |
| `maxConsecutiveResumes` | `8` | Stop after this many limits in a row right after resuming. `0` means no limit. |
| `resumeSubagents` | `false` | Also resume subagent sessions. |
| `message` | *(see `src/logic.js`)* | Text of the synthetic continue message. |
| `usageURL` | `https://chatgpt.com/backend-api/wham/usage` | Usage endpoint. |
| `usageIntegrationID` | `openai` | Integration whose OAuth credential is used for the usage endpoint. |
| `logFile` | `$XDG_STATE_HOME/opencode/openai-autocontinue.log` | Where the plugin writes what it is doing. `false` turns it off. |
| `debug` | `false` | Also log usage-endpoint failures and other details. |

OpenCode's background server discards plugin console output, so to see what the
plugin is waiting for, run:

```sh
tail -f ~/.local/state/opencode/openai-autocontinue.log
```

## Caveats

- `backend-api/wham/usage` is a real first-party endpoint, but it is not a
  documented public API, so its schema or authentication can change. Every
  failure falls back to the next source. With ChatGPT *token sharing* sign-in,
  the token may not be accepted there; the error's own reset time or the
  fallback wait is used instead, and the usage check is repeated before
  resuming.
- OpenCode loads plugins per project when a client opens it. After a restart,
  a saved resume fires once OpenCode is opened in that project again.
- Retrying in place uses one of OpenCode's built-in retry attempts (10 at most).
  If those run out, the durable resume takes over.

## Development

```sh
npm test   # node:test, no dependencies
```

`test/e2e/mock-openai.mjs` imitates a limited subscription backend, so the
plugin can be checked against a real OpenCode. Run `RESET_IN=40 node
test/e2e/mock-openai.mjs`, then point the `openai` provider at it
(`"providers": {"openai": {"settings": {"baseURL": "http://127.0.0.1:18080/v1",
"apiKey": "sk-test"}}}`) and set `usageURL` to
`http://127.0.0.1:18080/backend-api/wham/usage`. Then run `opencode run -m
openai/gpt-5.5 "Say hi"`. This was checked against OpenCode 2.2.5 for retrying
in place, for the durable resume, and for a resume that survives a service
restart.

## Credits and license

The detection and reset logic were written for this plugin after reading
[e-kotov/opencode-chatgpt-status](https://github.com/e-kotov/opencode-chatgpt-status)
(MIT), which also reads the ChatGPT usage endpoint in OpenCode 2, and the
[OpenAI Codex CLI](https://github.com/openai/codex) (Apache-2.0), which defines
the `usage_limit_reached` error and the `x-codex-*` headers. No code is copied
from either project. Both licenses are compatible with this project's license
in any case.

[azumag/opencode-rate-limit-fallback](https://github.com/azumag/opencode-rate-limit-fallback)
(MIT) was considered as a base, since its `wait` mode resumes sessions after a
cooldown. Its session recovery is built on the OpenCode 1 plugin API
(`@opencode-ai/plugin` 1.x), and OpenCode 2 replaced that API, so it could not be
extended here.

GPL-3.0. See [LICENSE](LICENSE).

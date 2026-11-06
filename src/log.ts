// File logging shared by the OpenCode 1.x and 2.x entry points: OpenCode
// discards a background server's console output.

import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import type { Config } from "./logic.ts"
import path from "node:path"

/** Default log file under the XDG state directory. */
export function defaultLogFile(env = process.env, home = os.homedir()) {
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state")
  return path.join(state, "opencode", "openai-autocontinue.log")
}

export type Logger = (message: string) => void

export interface Log {
  info: Logger
  debug: Logger
}

export function fileLogger(file: string): Logger {
  let ready: Promise<unknown> | undefined
  return (message) => {
    ready ??= mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    void ready.then(() => appendFile(file, `${new Date().toISOString()} ${message}\n`)).catch(() => {})
  }
}

/** `{ info, debug }` writing to `logger` if given, else console and the log file. */
export function createLog(config: Pick<Config, "logFile" | "debug">, logger?: Logger): Log {
  const toFile = config.logFile === false ? null : fileLogger(config.logFile ?? defaultLogFile())
  const write =
    logger ??
    ((message: string) => {
      console.warn(`[autocontinue] ${message}`)
      toFile?.(message)
    })
  return {
    info: (message) => write(message),
    debug: (message) => {
      if (config.debug) write(message)
    },
  }
}

import { format } from "node:util"
import type { LogLevel } from "./structured-log-telemetry.ts"

/** Mirrors host-console calls into structured logging while preserving console ownership. */
export function installHostConsoleBridge(
  reportLine: (level: LogLevel, line: string) => void,
): () => void {
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  let forwarding = false
  const wrap = (original: (...args: unknown[]) => void, level: LogLevel) => (...args: unknown[]) => {
    original(...args)
    if (forwarding) return
    forwarding = true
    try {
      reportLine(level, format(...args))
    } catch {
    } finally {
      forwarding = false
    }
  }
  const wrapped = {
    log: wrap(originals.log, "info"),
    info: wrap(originals.info, "info"),
    warn: wrap(originals.warn, "warn"),
    error: wrap(originals.error, "error"),
  }
  Object.assign(console, wrapped)
  return () => {
    for (const method of ["log", "info", "warn", "error"] as const) {
      if (console[method] === wrapped[method]) console[method] = originals[method]
    }
  }
}

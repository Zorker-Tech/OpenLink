/**
 * What the process does when something crashes it.
 *
 * A crash is reported and the process is kept alive rather than taken down with it: the error is logged, the reporter is
 * told, and a reporter that throws does not become the crash it was reporting. The reporter can be replaced later, which
 * is what lets a host install its own once it is up.
 */
export type ProcessCrashKind = "uncaughtException" | "unhandledRejection";
export function toError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
export function handleProcessCrash(options: { scope: string; onError?: (error: Error, kind: ProcessCrashKind) => void }, kind: ProcessCrashKind, value: unknown): void { const error = toError(value); console.error(`[${options.scope}] ${kind} (kept alive):`, error); try { options.onError?.(error, kind); } catch {} }
export function installProcessCrashGuards(options: { scope: string; onError?: (error: Error, kind: ProcessCrashKind) => void }) { let reporter = options.onError; const report = (kind: ProcessCrashKind, value: unknown) => handleProcessCrash({ scope: options.scope, ...(reporter === undefined ? {} : { onError: reporter }) }, kind, value); process.on("uncaughtException", (value) => report("uncaughtException", value)); process.on("unhandledRejection", (value) => report("unhandledRejection", value)); return { setReporter(onError: ((error: Error, kind: ProcessCrashKind) => void) | undefined) { reporter = onError; } }; }

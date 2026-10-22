/**
 * What the process does when something crashes it.
 *
 * A crash is reported and the process is kept alive rather than taken down with it: the error is logged, the reporter is
 * told, and a reporter that throws does not become the crash it was reporting. The reporter can be replaced later, which
 * is what lets a host install its own once it is up.
 */

/** The two ways the process can be crashed. */
export type ProcessCrashKind = "uncaughtException" | "unhandledRejection";

/** The function a crash is reported to. */
type ProcessCrashReporter = (error: Error, kind: ProcessCrashKind) => void;

/** What the guards are installed with: the scope they log under, and where crashes are reported. */
interface ProcessCrashGuardOptions {
  scope: string;
  onError?: ProcessCrashReporter;
}

/** What installing the guards answers: the one way to replace the reporter afterwards. */
interface ProcessCrashGuards {
  setReporter(onError: ProcessCrashReporter | undefined): void;
}

/** The error behind a thrown value, wrapped when it was not an Error already. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

/** The line a crash is logged under: the scope, the kind, and the fact that the process is still alive. */
function crashLogLine(scope: string, kind: ProcessCrashKind): string {
  return `[${scope}] ${kind} (kept alive):`;
}

/** Report one crash and keep the process alive: log it, then tell the reporter without letting it throw further. */
export function handleProcessCrash(options: ProcessCrashGuardOptions, kind: ProcessCrashKind, value: unknown): void {
  const error = toError(value);
  console.error(crashLogLine(options.scope, kind), error);
  try {
    options.onError?.(error, kind);
  } catch {}
}

/** Install the process's crash guards, and answer the one way to replace their reporter. */
export function installProcessCrashGuards(options: ProcessCrashGuardOptions): ProcessCrashGuards {
  let reporter = options.onError;
  const report = (kind: ProcessCrashKind, value: unknown): void => {
    const onError = reporter;
    handleProcessCrash(onError === undefined ? { scope: options.scope } : { scope: options.scope, onError }, kind, value);
  };
  const listen = (kind: ProcessCrashKind): void => {
    process.on(kind, (value: unknown) => report(kind, value));
  };
  listen("uncaughtException");
  listen("unhandledRejection");
  return {
    setReporter(onError: ProcessCrashReporter | undefined): void {
      reporter = onError;
    },
  };
}

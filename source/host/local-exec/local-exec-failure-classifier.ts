/**
 * What a failed local-exec operation failed at.
 *
 * A failure that came from spawning is told apart from everything else, and the errno token in the message decides
 * whether the program was missing or the platform refused to run it; anything without a recognizable errno is left as
 * other.
 */
const ERRNO_TOKEN = /\b(E[A-Z0-9]+)\b/;
const SPAWN_MENTION = /\bspawn(?:Sync)?\b/i;

/** The errno a spawn reports when the program is not on the machine. */
const MISSING_PROGRAM_ERRNOS: ReadonlySet<string> = new Set(["ENOENT"]);

/** The errnos a spawn reports when the platform refused to run the program. */
const REFUSED_ERRNOS: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

export type LocalExecFailureClass = "other" | "spawn_enoent" | "spawn_permissions" | "spawn_other";
export interface LocalExecFailureClassification { readonly errorClass: LocalExecFailureClass; readonly errno?: string; }

/** The answer for one class, carrying the errno only when the message had a recognizable one. */
const classified = (errorClass: LocalExecFailureClass, errno: string | undefined): LocalExecFailureClassification =>
  errno === undefined ? { errorClass } : { errorClass, errno };

export function classifyLocalExecFailure(message: string): LocalExecFailureClassification {
  const errno = ERRNO_TOKEN.exec(message)?.[1];
  if (!SPAWN_MENTION.test(message)) return classified("other", errno);
  if (errno !== undefined && MISSING_PROGRAM_ERRNOS.has(errno)) return classified("spawn_enoent", errno);
  if (errno !== undefined && REFUSED_ERRNOS.has(errno)) return classified("spawn_permissions", errno);
  return classified("spawn_other", errno);
}

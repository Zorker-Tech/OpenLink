/**
 * What a failed local-exec operation failed at.
 *
 * A failure that came from spawning is told apart from everything else, and the errno token in the message decides
 * whether the program was missing or the platform refused to run it; anything without a recognizable errno is left as
 * other.
 */
const ERRNO_TOKEN = /\b(E[A-Z0-9]+)\b/;

export type LocalExecFailureClass = "other" | "spawn_enoent" | "spawn_permissions" | "spawn_other";
export interface LocalExecFailureClassification { readonly errorClass: LocalExecFailureClass; readonly errno?: string; }

export function classifyLocalExecFailure(message: string): LocalExecFailureClassification {
  const isSpawn = /\bspawn(?:Sync)?\b/i.test(message);
  const errno = ERRNO_TOKEN.exec(message)?.[1];
  if (!isSpawn) return errno === undefined ? { errorClass: "other" } : { errorClass: "other", errno };
  if (errno === "ENOENT") return { errorClass: "spawn_enoent", errno };
  if (errno === "EACCES" || errno === "EPERM") return { errorClass: "spawn_permissions", errno };
  return errno === undefined ? { errorClass: "spawn_other" } : { errorClass: "spawn_other", errno };
}


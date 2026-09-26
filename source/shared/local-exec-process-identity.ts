/**
 * Telling one local-exec process from another.
 *
 * A daemon may be replaced while a client still holds a handle to the old one, so each process carries a generation
 * token: the token travels as an argument, and a client that is handed a process compares what it finds with what it
 * expected rather than trusting the process it happens to be talking to.
 */
export const LOCAL_EXEC_GENERATION_TOKEN_ENV = "SLATE_LOCAL_EXEC_GENERATION_TOKEN";
export const LOCAL_EXEC_GENERATION_TOKEN_ARG = "--slate-local-exec-generation=";
export const LOCAL_EXEC_DAEMON_PUBLICATION_LAG_MS = 60_000;

export interface LocalExecProcessIdentity {
  readonly pid: number;
  readonly startEpochMs: number;
  readonly command: string;
  readonly entryRealpath: string;
  readonly generationToken: string;
}

export interface ExpectedLocalExecProcessIdentity {
  readonly pid: number;
  readonly entryRealpath: string;
  readonly generationToken: string;
  readonly startEpochMs?: number;
  readonly command?: string;
  readonly discoveryStartedAt?: number;
}

function containsExactArgument(command: string, argument: string): boolean {
  let offset = command.indexOf(argument);
  while (offset >= 0) {
    const before = offset === 0 || /\s/.test(command[offset - 1]!);
    const end = offset + argument.length;
    const after = end === command.length || /\s/.test(command[end]!);
    if (before && after) return true;
    offset = command.indexOf(argument, offset + 1);
  }
  return false;
}

export function commandCarriesLocalExecGeneration(
  command: string,
  entryRealpath: string,
  generationToken: string,
): boolean {
  return entryRealpath.length > 0
    && generationToken.length > 0
    && containsExactArgument(command, entryRealpath)
    && containsExactArgument(command, `${LOCAL_EXEC_GENERATION_TOKEN_ARG}${generationToken}`);
}

export function sameLocalExecProcessIdentity(
  left: LocalExecProcessIdentity,
  right: LocalExecProcessIdentity,
): boolean {
  return left.pid === right.pid
    && left.startEpochMs === right.startEpochMs
    && left.command === right.command
    && left.entryRealpath === right.entryRealpath
    && left.generationToken === right.generationToken;
}

export function localExecDiscoveryTimeMatchesProcess(
  discoveryStartedAt: number,
  processStartEpochMs: number,
  observedAtMs: number,
): boolean {
  return Number.isFinite(discoveryStartedAt)
    && Number.isFinite(processStartEpochMs)
    && Number.isFinite(observedAtMs)
    && discoveryStartedAt >= processStartEpochMs
    && discoveryStartedAt - processStartEpochMs <= LOCAL_EXEC_DAEMON_PUBLICATION_LAG_MS
    && discoveryStartedAt <= observedAtMs;
}

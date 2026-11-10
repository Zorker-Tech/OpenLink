import {
  DAEMON_DISCOVERY_PUBLICATION_WINDOW_MS,
  LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX,
  type LocalExecProcessIdentity,
} from "./local-exec-process-contracts.ts";

function containsWholeArgument(commandLine: string, expected: string): boolean {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(commandLine);
}

export function processCommandHasExpectedIdentity(
  commandLine: string,
  entryPath: string,
  generation: string,
): boolean {
  return entryPath.length > 0
    && generation.length > 0
    && containsWholeArgument(commandLine, entryPath)
    && containsWholeArgument(commandLine, `${LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX}${generation}`);
}

export function processIdentitiesMatch(
  first: LocalExecProcessIdentity,
  second: LocalExecProcessIdentity,
): boolean {
  return first.pid === second.pid
    && first.startEpochMs === second.startEpochMs
    && first.command === second.command
    && first.entryRealpath === second.entryRealpath
    && first.generationToken === second.generationToken;
}

export function discoveryBelongsToProcessWindow(
  discoveredAt: number,
  processStartedAt: number,
  observedAt: number,
): boolean {
  if (![discoveredAt, processStartedAt, observedAt].every(Number.isFinite)) return false;
  const publicationAge = discoveredAt - processStartedAt;
  return publicationAge >= 0
    && publicationAge <= DAEMON_DISCOVERY_PUBLICATION_WINDOW_MS
    && discoveredAt <= observedAt;
}

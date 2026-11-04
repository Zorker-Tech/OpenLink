/** Restore the conversation log before the host begins serving requests. */

import { isSqliteBusyError, retrySqliteBusy } from "./storage/sqlite-busy.ts";

export interface InitialTranscriptLoader<Entry = unknown> {
  ensureLoaded(): Promise<readonly Entry[]>;
}

export interface InitialTranscriptLoadOptions {
  readonly isAgentLimitError?: (error: unknown) => boolean;
  readonly logError?: (message: string, error?: unknown) => void;
}

type DegradedStartup =
  | { readonly kind: "locked-store"; readonly message: string; readonly error: unknown }
  | { readonly kind: "agent-capacity"; readonly message: string };

const DEFAULT_REPORTER: NonNullable<InitialTranscriptLoadOptions["logError"]> = (message, error) => {
  if (error === undefined) console.error(message);
  else console.error(message, error);
};

function recoveryForLoadFailure(
  error: unknown,
  isAgentLimitError: (error: unknown) => boolean,
): DegradedStartup | undefined {
  if (isSqliteBusyError(error)) {
    return {
      kind: "locked-store",
      message: "[slate-host] transcript store stayed locked; continuing without restored entries",
      error,
    };
  }
  if (isAgentLimitError(error)) {
    return {
      kind: "agent-capacity",
      message: "[slate-host] account capacity is full; transcript restore was skipped so agents remain manageable",
    };
  }
  return undefined;
}

function reportDegradedStartup(
  recovery: DegradedStartup,
  reportError: NonNullable<InitialTranscriptLoadOptions["logError"]>,
): void {
  if (recovery.kind === "locked-store") reportError(recovery.message, recovery.error);
  else reportError(recovery.message);
}

/** Expected lock contention and an exhausted account limit leave the host available with no restored entries. */
export async function loadInitialTranscriptResiliently<Entry>(
  transcript: InitialTranscriptLoader<Entry>,
  options: InitialTranscriptLoadOptions = {},
): Promise<number> {
  try {
    const entries = await retrySqliteBusy(() => transcript.ensureLoaded());
    return entries.length;
  } catch (error) {
    const recovery = recoveryForLoadFailure(error, options.isAgentLimitError ?? (() => false));
    if (recovery === undefined) throw error;
    reportDegradedStartup(recovery, options.logError ?? DEFAULT_REPORTER);
    return 0;
  }
}

/** Small host-side decisions shared by the automation extension's lifecycle. */

export const SLATE_BOX_BOOT_STARTED_AT_MS_ENV = "SLATE_BOX_BOOT_STARTED_AT_MS";

/** A missing, invalid or future boot timestamp has no meaningful positive age. */
export function getBoxUptimeMs(
  nowMs: number = Date.now(),
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const rawTimestamp = environment[SLATE_BOX_BOOT_STARTED_AT_MS_ENV]?.trim();
  if (rawTimestamp == null || rawTimestamp.length === 0) return undefined;
  const bootTimestamp = Number(rawTimestamp);
  if (!Number.isFinite(bootTimestamp) || bootTimestamp <= 0) return undefined;
  return Math.max(0, nowMs - bootTimestamp);
}

export interface AuthenticationReconcilePort {
  readonly auth: {
    peekAccessToken(): string | null;
    subscribeToRenewal(listener: () => void): () => void;
  };
  readonly reconcile: () => void;
}

/** Runs the first reconciliation once a credential exists, whether it is already present or arrives later. */
export function reconcileWhenAuthenticated(port: AuthenticationReconcilePort): () => void {
  let awaitingCredential = true;
  const reconcileOnSignIn = (): void => {
    if (!awaitingCredential || port.auth.peekAccessToken() == null) return;
    awaitingCredential = false;
    port.reconcile();
  };

  const stopWatching = port.auth.subscribeToRenewal(reconcileOnSignIn);
  reconcileOnSignIn();
  return stopWatching;
}

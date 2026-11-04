import { EMPTY_SLATE_SHARING_STATE } from "../../shared/agents/sharing.ts";
import type { CrossUserSharingLifecycle, CrossUserSharingLifecycleOptions, SharingEnabledState } from "./xuser-sharing-extension-contracts.ts";

/** The single gate value shared by service callbacks and the extension's public API. */
export function createCrossUserSharingEnabledState(): SharingEnabledState {
  let value = false;
  return {
    get isEnabled() { return value; },
    set(isEnabled) { value = isEnabled; },
  };
}

/** Coordinates feature-gate edges, environment refusal, delegate ownership, and stop behavior. */
export function createCrossUserSharingLifecycle(args: CrossUserSharingLifecycleOptions): CrossUserSharingLifecycle {
  const delegate = args.service.buildManagerDelegate();
  const warn = args.warn ?? ((message: string) => console.warn(message));
  let stopped = false;
  let hasAppliedGate = false;

  function emit(state: unknown): void {
    for (const listener of args.listeners) listener(state);
  }

  function applyGate(on: boolean): void {
    if (stopped || (hasAppliedGate && on === args.enabledState.isEnabled)) return;
    hasAppliedGate = true;
    args.enabledState.set(on);

    if (!on) {
      args.transcript.setXuserDelegate(null);
      args.service.stop();
      emit(EMPTY_SLATE_SHARING_STATE);
      return;
    }

    args.transcript.setXuserDelegate(delegate);
    void args.service.start().catch((error: unknown) => {
      args.host.log(`[slate:sharing] failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function applyGuardedGate(on: boolean): void {
    if (on && !args.environment.isAllowed) {
      warn(`[slate:sharing] ${args.environment.reason}`);
      applyGate(false);
      return;
    }
    applyGate(on);
  }

  return {
    get isEnabled() { return args.enabledState.isEnabled; },
    get isStopped() { return stopped; },
    applyGate,
    applyGuardedGate,
    requestRelayDrain() {
      if (args.enabledState.isEnabled) args.service.requestRelayDrain();
    },
    emit,
    stop() {
      stopped = true;
      args.transcript.setXuserDelegate(null);
      args.service.stop();
      args.listeners.clear();
    },
  };
}

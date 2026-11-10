import type { TurnStreamCallbacks } from "./turn-run-shell.ts";

interface TurnLease<Prepared extends object, Owner> {
  readonly prepared: Prepared;
  readonly owner: Owner;
  readonly disposeRunContext: () => void;
  callbacks?: TurnStreamCallbacks;
}

/** Owns the active production turn and routes only that turn's updates into its settle callbacks. */
export class ProductionTurnRunLease<Prepared extends object, Owner> {
  private readonly byPreparedTurn = new WeakMap<object, TurnLease<Prepared, Owner>>();
  private activeLease: TurnLease<Prepared, Owner> | undefined;

  attach(prepared: Prepared, owner: Owner, disposeRunContext: () => void): void {
    const lease: TurnLease<Prepared, Owner> = { prepared, owner, disposeRunContext };
    this.byPreparedTurn.set(prepared, lease);
    this.activeLease = lease;
  }

  forPrepared(prepared: object): TurnLease<Prepared, Owner> | undefined {
    return this.byPreparedTurn.get(prepared);
  }

  acceptCallbacks(prepared: object, callbacks: TurnStreamCallbacks): boolean {
    const lease = this.byPreparedTurn.get(prepared);
    if (lease === undefined) return false;
    lease.callbacks = callbacks;
    return true;
  }

  activeCallbacksFor(prepared: object | undefined): TurnStreamCallbacks | undefined {
    if (prepared === undefined || this.activeLease?.prepared !== prepared) return undefined;
    return this.activeLease.callbacks;
  }

  releaseActive(): TurnLease<Prepared, Owner> | undefined {
    const lease = this.activeLease;
    this.activeLease = undefined;
    if (lease !== undefined) delete lease.callbacks;
    return lease;
  }
}

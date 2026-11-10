import type { XuserDepartureHost, XuserDepartureObligationStores } from "./xuser-departure-contracts.ts";
import type { XuserDeparture } from "./xuser-pending-departure-store.ts";
import { resolveActingXuserAuthId, deliverXuserDeparture } from "./xuser-departure-resolution.ts";
import { markXuserRoomAbandonedLocally } from "./xuser-departure-room-state.ts";

/** Serialize retries so overlapping wakeups cannot deliver the same outstanding batch twice. */
export class XuserDepartureFlushLane {
  #isFlushing = false;

  constructor(
    private readonly host: XuserDepartureHost,
    private readonly stores: XuserDepartureObligationStores,
  ) {}

  async flush(): Promise<void> {
    if (this.#isFlushing) return;
    const pending = this.stores.pendingDepartures.list();
    if (pending.length === 0) return;

    this.#isFlushing = true;
    try {
      const ownerAuthId = await resolveActingXuserAuthId(this.host);
      if (ownerAuthId == null) return;
      await this.#deliverOwned(pending, ownerAuthId);
    } finally {
      this.#isFlushing = false;
    }
  }

  async #deliverOwned(pending: readonly XuserDeparture[], ownerAuthId: string): Promise<void> {
    for (const stored of pending) {
      if (stored.ownerAuthId != null && stored.ownerAuthId !== ownerAuthId) continue;
      const departure = this.#claimLegacyOwner(stored, ownerAuthId);
      if (!await deliverXuserDeparture(this.host, departure)) continue;

      this.stores.pendingDepartures.clear(departure);
      if (departure.kind === "leave-room") {
        markXuserRoomAbandonedLocally(this.host, this.stores.roomTombstones, departure.roomId);
      }
    }
  }

  #claimLegacyOwner(departure: XuserDeparture, ownerAuthId: string): XuserDeparture {
    if (departure.ownerAuthId != null) return departure;
    const claimed = { ...departure, ownerAuthId };
    this.stores.pendingDepartures.clear(departure);
    this.stores.pendingDepartures.record(claimed);
    return claimed;
  }
}

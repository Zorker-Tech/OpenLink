/** Keep room departures durable until the remote service acknowledges them. */
import type { XuserDepartureHost } from "./xuser-departure-contracts.ts";
import type { XuserDeparture, XuserPendingDepartureStore } from "./xuser-pending-departure-store.ts";
import type { XuserRoomTombstoneStore } from "./xuser-room-tombstone-store.ts";
import { resolveActingXuserAuthId, resolveXuserDeparture, deliverXuserDeparture } from "./xuser-departure-resolution.ts";
import {
  hasOwedRoomDeparture,
  isXuserRoomAbandoned,
  markXuserRoomAbandonedLocally,
  clearOwnedRoomTombstones,
  pruneObsoleteRoomTombstones,
} from "./xuser-departure-room-state.ts";
import { XuserDepartureFlushLane } from "./xuser-departure-flush.ts";

export { ROOM_TOMBSTONE_MIN_RETENTION_MS } from "./xuser-departure-contracts.ts";
export type { XuserDepartureHost } from "./xuser-departure-contracts.ts";

/** Record deletion work, settle it when possible, and track rooms already abandoned locally. */
export class SlateXuserDepartureObligations {
  readonly #flushLane: XuserDepartureFlushLane;

  constructor(
    readonly host: XuserDepartureHost,
    readonly pendingDepartures: XuserPendingDepartureStore,
    readonly roomTombstones: XuserRoomTombstoneStore,
  ) {
    this.#flushLane = new XuserDepartureFlushLane(host, { pendingDepartures, roomTombstones });
  }

  async noteAgentDeleted(agentId: string): Promise<void> {
    if (!this.host.isEnabled()) return;
    const ownerAuthId = await this.resolveActingAuthId();
    const departure = await this.resolveDeparture(agentId, ownerAuthId);
    if (departure == null) return;

    this.pendingDepartures.record(departure);
    if (departure.kind === "leave-room") {
      await this.host.manager.markMirrorRoomRevoked(departure.roomId).catch(() => {});
    }
    await this.flushPendingDepartures();
  }

  resolveActingAuthId(): Promise<string | null> {
    return resolveActingXuserAuthId(this.host);
  }

  resolveDeparture(agentId: string, ownerAuthId: string | null): Promise<XuserDeparture | null> {
    return resolveXuserDeparture(this.host, agentId, ownerAuthId);
  }

  isDepartureOwed(roomId: string): boolean {
    return hasOwedRoomDeparture(this.host, this.pendingDepartures, roomId);
  }

  isRoomAbandoned(roomId: string): boolean {
    return isXuserRoomAbandoned(this.host, this.pendingDepartures, this.roomTombstones, roomId);
  }

  abandonRoomLocally(roomId: string): void {
    markXuserRoomAbandonedLocally(this.host, this.roomTombstones, roomId);
  }

  clearRoomTombstones(roomId: string): void {
    clearOwnedRoomTombstones(this.host, this.roomTombstones, roomId);
  }

  pruneRoomTombstones(registryRoomIds: ReadonlySet<string>): void {
    pruneObsoleteRoomTombstones(this.host, this.roomTombstones, registryRoomIds);
  }

  flushPendingDepartures(): Promise<void> {
    return this.#flushLane.flush();
  }

  landDeparture(departure: XuserDeparture): Promise<boolean> {
    return deliverXuserDeparture(this.host, departure);
  }
}

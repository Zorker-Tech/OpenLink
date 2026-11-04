import { ROOM_TOMBSTONE_MIN_RETENTION_MS } from "./xuser-departure-contracts.ts";
import type { XuserDepartureHost } from "./xuser-departure-contracts.ts";
import type { XuserPendingDepartureStore } from "./xuser-pending-departure-store.ts";
import type { XuserRoomTombstoneStore } from "./xuser-room-tombstone-store.ts";

function isOwnedByCurrentAccount(host: XuserDepartureHost, ownerAuthId: string | undefined): boolean {
  return ownerAuthId == null || ownerAuthId === host.getSelfAuthId();
}

export function hasOwedRoomDeparture(
  host: XuserDepartureHost,
  pendingDepartures: XuserPendingDepartureStore,
  roomId: string,
): boolean {
  return pendingDepartures.list().some((departure) =>
    departure.kind === "leave-room"
      && departure.roomId === roomId
      && isOwnedByCurrentAccount(host, departure.ownerAuthId),
  );
}

export function isXuserRoomAbandoned(
  host: XuserDepartureHost,
  pendingDepartures: XuserPendingDepartureStore,
  roomTombstones: XuserRoomTombstoneStore,
  roomId: string,
): boolean {
  const hasOwnedTombstone = roomTombstones.list().some((tombstone) =>
    tombstone.roomId === roomId && isOwnedByCurrentAccount(host, tombstone.ownerAuthId),
  );
  return hasOwnedTombstone || hasOwedRoomDeparture(host, pendingDepartures, roomId);
}

export function markXuserRoomAbandonedLocally(
  host: XuserDepartureHost,
  roomTombstones: XuserRoomTombstoneStore,
  roomId: string,
): void {
  const ownerAuthId = host.getSelfAuthId();
  roomTombstones.record({
    roomId,
    ...(ownerAuthId == null ? {} : { ownerAuthId }),
    tornDownAtMs: host.clock.now(),
  });
  const rooms = host.getRooms();
  const remaining = rooms.filter((room) => room.roomId !== roomId);
  if (remaining.length === rooms.length) return;
  host.setRooms(remaining);
  host.emit();
}

export function clearOwnedRoomTombstones(
  host: XuserDepartureHost,
  roomTombstones: XuserRoomTombstoneStore,
  roomId: string,
): void {
  for (const tombstone of roomTombstones.list()) {
    if (tombstone.roomId === roomId && isOwnedByCurrentAccount(host, tombstone.ownerAuthId)) roomTombstones.clear(tombstone);
  }
}

export function pruneObsoleteRoomTombstones(
  host: XuserDepartureHost,
  roomTombstones: XuserRoomTombstoneStore,
  registryRoomIds: ReadonlySet<string>,
): void {
  const now = host.clock.now();
  for (const tombstone of roomTombstones.list()) {
    const oldEnough = now - tombstone.tornDownAtMs >= ROOM_TOMBSTONE_MIN_RETENTION_MS;
    if (isOwnedByCurrentAccount(host, tombstone.ownerAuthId) && !registryRoomIds.has(tombstone.roomId) && oldEnough) {
      roomTombstones.clear(tombstone);
    }
  }
}

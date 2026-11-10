import type { XuserDeparture, XuserPendingDepartureStore } from "./xuser-pending-departure-store.ts";
import type { XuserRoomTombstoneStore } from "./xuser-room-tombstone-store.ts";

export const ROOM_TOMBSTONE_MIN_RETENTION_MS = 48 * 60 * 60_000;

export interface XuserDepartureRoom {
  roomId: string;
  members: Array<{ kind: string; authId: string; agentId?: string }>;
}

export interface XuserDepartureHost {
  readonly relay: {
    leaveRoom(roomId: string): Promise<unknown>;
    removeDeletedAgent(agentId: string): Promise<{ rooms: XuserDepartureRoom[] }>;
  };
  readonly manager: {
    getSharedRoomIdForAgent(agentId: string): Promise<string | null>;
    listRoomAgentIds(roomId: string): Promise<string[]>;
    markMirrorRoomRevoked(roomId: string): Promise<void>;
  };
  readonly clock: { now(): number };
  readonly isEnabled: () => boolean;
  readonly getSelfAuthId: () => string | null;
  readonly setSelfAuthId: (id: string) => void;
  readonly readSelfAuthId: (operation: string) => Promise<string | null>;
  readonly getRooms: () => XuserDepartureRoom[];
  readonly setRooms: (rooms: XuserDepartureRoom[]) => void;
  readonly emit: () => void;
  readonly installRoom: (room: XuserDepartureRoom) => Promise<void>;
}

export interface XuserDepartureObligationStores {
  readonly pendingDepartures: XuserPendingDepartureStore;
  readonly roomTombstones: XuserRoomTombstoneStore;
}

export type { XuserDeparture, XuserPendingDepartureStore, XuserRoomTombstoneStore };

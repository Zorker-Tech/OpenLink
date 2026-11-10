import { SlateXuserRelayHttpError } from "./xuser-relay.ts";
import type { XuserDeparture } from "./xuser-pending-departure-store.ts";
import type { XuserDepartureHost } from "./xuser-departure-contracts.ts";

/** Read the acting account and refresh the host's cached identity when one is available. */
export async function resolveActingXuserAuthId(host: XuserDepartureHost): Promise<string | null> {
  const authId = await host.readSelfAuthId("acting-identity resolve");
  if (authId != null) host.setSelfAuthId(authId);
  return authId;
}

/** Identify whether deleting an agent owes a room departure or a private-agent removal. */
export async function resolveXuserDeparture(
  host: XuserDepartureHost,
  agentId: string,
  ownerAuthId: string | null,
): Promise<XuserDeparture | null> {
  const owner = ownerAuthId == null ? {} : { ownerAuthId };
  const roomId = await host.manager.getSharedRoomIdForAgent(agentId).catch(() => null);

  if (roomId != null) {
    const boundAgentIds = await host.manager.listRoomAgentIds(roomId).catch(() => []);
    if (boundAgentIds.every((boundId) => boundId === agentId)) {
      return { kind: "leave-room", ...owner, roomId, agentId };
    }
    return null;
  }

  const wasRoomMember = ownerAuthId != null && host.getRooms().some((room) =>
    room.members.some((member) => member.kind === "agent" && member.authId === ownerAuthId && member.agentId === agentId),
  );
  return wasRoomMember ? { kind: "remove-agent", ...owner, agentId } : null;
}

/** Treat success and an already-gone remote object as acknowledged work. */
export async function deliverXuserDeparture(host: XuserDepartureHost, departure: XuserDeparture): Promise<boolean> {
  try {
    if (departure.kind === "leave-room") {
      await host.relay.leaveRoom(departure.roomId);
    } else {
      const result = await host.relay.removeDeletedAgent(departure.agentId);
      for (const room of result.rooms) await host.installRoom(room);
    }
    return true;
  } catch (error) {
    return error instanceof SlateXuserRelayHttpError && error.status === 404;
  }
}

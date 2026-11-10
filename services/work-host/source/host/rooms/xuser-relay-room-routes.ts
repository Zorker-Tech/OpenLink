import { SlateXuserRelayHttpError } from "./xuser-relay-contracts.ts";

type RelayCall = <Result>(path: string, body: unknown) => Promise<Result>;

const ROOM_ROUTES = {
  create: "/slate/share-rooms",
  createFromAgent: "/slate/share-rooms/from-agent",
  invite: "/slate/share-rooms/invite-links",
  join: "/slate/share-rooms/join",
  answerJoin: "/slate/share-rooms/join/respond",
  addAgent: "/slate/share-rooms/agents/add",
  changePicture: "/slate/share-rooms/picture",
  removeAgent: "/slate/share-rooms/agents/remove",
  forgetAgent: "/slate/share-rooms/agents/remove-deleted",
  leave: "/slate/share-rooms/leave",
  state: "/slate/share-state",
  send: "/slate/xuser/send",
} as const;

interface RoomLinkReply {
  readonly shareUrl: string;
  readonly expiresAtMs: number;
  readonly room: { readonly roomId: string };
}

function errorResult(error: unknown): Record<string, unknown> {
  return { status: "error", message: describeRelayError(error) };
}

async function roomLink(call: RelayCall, route: string, body: unknown): Promise<Record<string, unknown>> {
  try {
    const reply = await call<RoomLinkReply>(route, body);
    return {
      status: "ok",
      shareUrl: reply.shareUrl,
      expiresAtMs: reply.expiresAtMs,
      roomId: reply.room.roomId,
    };
  } catch (error) {
    return errorResult(error);
  }
}

function joinResult(reply: Record<string, unknown>): Record<string, unknown> {
  if (reply.status === "pending") return { status: "pending", roomName: reply.roomName ?? "the shared room" };
  if (reply.status === "already-member") {
    const room = typeof reply.room === "object" && reply.room !== null
      ? reply.room as Record<string, unknown>
      : undefined;
    return {
      status: "already-member",
      roomName: room?.name ?? "the shared room",
      ...(room?.roomId != null ? { roomId: room.roomId } : {}),
    };
  }
  if (reply.status === "invalid" || reply.status === "denied" || reply.status === "rate-limited") {
    return { status: reply.status };
  }
  return { status: "error", message: "Unexpected response." };
}

/** Route descriptions and result projections for room operations, without transport policy. */
export class XuserRelayRoomRoutes {
  constructor(private readonly call: RelayCall) {}

  createFromAgent(args: unknown): Promise<Record<string, unknown>> {
    return roomLink(this.call, ROOM_ROUTES.createFromAgent, args);
  }

  create<Result>(args: unknown): Promise<Result> {
    return this.call(ROOM_ROUTES.create, args);
  }

  invite(roomId: string): Promise<Record<string, unknown>> {
    return roomLink(this.call, ROOM_ROUTES.invite, { roomId });
  }

  async join(link: string): Promise<Record<string, unknown>> {
    try {
      const reply = await this.call<Record<string, unknown>>(ROOM_ROUTES.join, { link });
      return joinResult(reply);
    } catch (error) {
      return errorResult(error);
    }
  }

  answerJoin<Result>(args: unknown): Promise<Result> {
    return this.call(ROOM_ROUTES.answerJoin, args);
  }

  addAgent<Result>(args: unknown): Promise<Result> {
    return this.call(ROOM_ROUTES.addAgent, args);
  }

  changePicture<Result>(args: unknown): Promise<Result> {
    return this.call(ROOM_ROUTES.changePicture, args);
  }

  removeAgent<Result>(args: unknown): Promise<Result> {
    return this.call(ROOM_ROUTES.removeAgent, args);
  }

  forgetAgent<Result>(agentId: string): Promise<Result> {
    return this.call(ROOM_ROUTES.forgetAgent, { agentId });
  }

  leave<Result>(roomId: string, targetAuthId?: string): Promise<Result> {
    return this.call(ROOM_ROUTES.leave, { roomId, ...(targetAuthId == null ? {} : { targetAuthId }) });
  }

  fetchState<Result>(): Promise<Result> {
    return this.call(ROOM_ROUTES.state, {});
  }

  async send(payload: unknown): Promise<{ timestampMs?: number }> {
    const reply = await this.call<{ timestampMs?: unknown }>(ROOM_ROUTES.send, payload);
    return typeof reply.timestampMs === "number" && Number.isFinite(reply.timestampMs)
      ? { timestampMs: reply.timestampMs }
      : {};
  }
}

export function describeRelayError(error: unknown): string {
  if (error instanceof SlateXuserRelayHttpError) {
    if (error.status === 403) return "Sharing isn't enabled for your account.";
    if (error.status === 429) return "You're doing that too often. Try again in a minute.";
  }
  return "Couldn't reach the sharing service. Check your connection and try again.";
}

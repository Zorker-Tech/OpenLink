import { randomUUID } from "node:crypto";
import { parseRemoteAgentId } from "../../shared/agents/sharing.ts";
import { toSharedRoomMessages } from "../groups/xuser.ts";
import {
  REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS,
  type RemoteMemberTurnArgs,
  type RemoteTurnsHost,
} from "./xuser-remote-turn-contracts.ts";

interface PendingRemoteTurn {
  readonly resolve: (messages: string[]) => void;
}

/** Sends a turn to a remote member and pairs the reply with its outstanding nonce. */
export class RemoteTurnOutboundRequests {
  readonly #pendingByNonce = new Map<string, PendingRemoteTurn>();
  readonly #backoffUntilMsByMember = new Map<string, number>();

  constructor(readonly host: RemoteTurnsHost) {}

  stop(): void {
    for (const [nonce, pending] of this.#pendingByNonce) {
      pending.resolve([]);
      this.#pendingByNonce.delete(nonce);
    }
  }

  handleResult(event: Record<string, unknown>): boolean {
    const nonce = event.turnNonce;
    if (typeof nonce !== "string") return true;
    const pending = this.#pendingByNonce.get(nonce);
    if (pending === undefined) return true;
    this.#pendingByNonce.delete(nonce);
    pending.resolve(this.readReplyMessages(event.messages));
    return true;
  }

  async run(args: RemoteMemberTurnArgs): Promise<string[]> {
    if (!this.host.isEnabled()) return [];
    const ref = parseRemoteAgentId(args.member.id);
    if (ref === null || this.isBackingOff(args.member.id)) return [];

    const turnNonce = randomUUID();
    const result = new Promise<string[]>((resolve) => {
      this.#pendingByNonce.set(turnNonce, { resolve });
    });
    try {
      await this.host.relay.send({
        kind: "turn-request",
        roomId: args.sharedRoomId,
        turnNonce,
        ownerAuthId: ref.ownerAuthId,
        agentId: ref.agentId,
        groupName: args.group.name,
        groupDescription: args.group.description,
        peers: args.peers.map((peer) => ({ name: peer.name, description: peer.description })),
        newMessages: toSharedRoomMessages(args.newMessages, args.member.id),
      });
    } catch {
      this.#pendingByNonce.delete(turnNonce);
      return [];
    }

    this.host.relay.requestDrain();
    let messages: string[];
    try {
      messages = await this.host.remoteTurnDeadline.run(async () => result);
    } catch {
      this.#pendingByNonce.delete(turnNonce);
      this.#backoffUntilMsByMember.set(
        args.member.id,
        this.host.clock.now() + REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS,
      );
      return [];
    }
    if (messages.length > 0) this.#backoffUntilMsByMember.delete(args.member.id);
    return messages;
  }

  private isBackingOff(memberId: string): boolean {
    return this.host.clock.now() < (this.#backoffUntilMsByMember.get(memberId) ?? 0);
  }

  private readReplyMessages(raw: unknown): string[] {
    return (Array.isArray(raw) ? raw : [])
      .filter((message): message is string => typeof message === "string")
      .slice(0, 2);
  }
}

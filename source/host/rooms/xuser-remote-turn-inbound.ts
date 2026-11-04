import { buildSharedRoomMemberPrompts, normalizeSharedRoomName } from "../groups/xuser.ts";
import { normalizeTurnMessages } from "./xuser-wire-normalization.ts";
import {
  REMOTE_TURN_BUDGET_MAX,
  REMOTE_TURN_BUDGET_WINDOW_MS,
  type RemoteTurnsHost,
  type SharedRoom,
} from "./xuser-remote-turn-contracts.ts";

/** Receives a request from another room host, enforcing membership and per-member rate limits. */
export class RemoteTurnInboundRequests {
  readonly #startsByRoomHostAgent = new Map<string, number[]>();

  constructor(readonly host: RemoteTurnsHost) {}

  stop(): void {
    this.#startsByRoomHostAgent.clear();
  }

  handleRequest(event: Record<string, unknown>): boolean {
    const roomId = typeof event.roomId === "string" ? event.roomId : null;
    const turnNonce = typeof event.turnNonce === "string" ? event.turnNonce : null;
    const agentId = typeof event.agentId === "string" ? event.agentId : null;
    const hostAuthId = typeof event.hostAuthId === "string" ? event.hostAuthId : null;
    if (roomId === null || turnNonce === null || agentId === null || hostAuthId === null) return true;

    const selfAuthId = this.host.getSelfAuthId();
    const room = this.host.getRooms().find((candidate) => candidate.roomId === roomId);
    if (selfAuthId === null || room === undefined || room.hostAuthId !== hostAuthId) return true;
    if (!this.containsHuman(room, selfAuthId) || !this.containsAgent(room, selfAuthId, agentId)) return true;
    if (!this.host.turnDedupe.markSeenIfNew(turnNonce)) return true;

    const budgetKey = this.budgetKey(roomId, hostAuthId, agentId);
    const now = this.host.clock.now();
    const recentStarts = (this.#startsByRoomHostAgent.get(budgetKey) ?? [])
      .filter((startedAtMs) => now - startedAtMs < REMOTE_TURN_BUDGET_WINDOW_MS);
    if (recentStarts.length >= REMOTE_TURN_BUDGET_MAX) {
      this.#startsByRoomHostAgent.set(budgetKey, recentStarts);
      return true;
    }
    this.#startsByRoomHostAgent.set(budgetKey, [...recentStarts, now]);
    void this.runRequestedTurn(event, room);
    return true;
  }

  async runRequestedTurn(event: Record<string, unknown>, room: SharedRoom): Promise<void> {
    const agentId = typeof event.agentId === "string" ? event.agentId : "";
    const roomId = typeof event.roomId === "string" ? event.roomId : "";
    const turnNonce = typeof event.turnNonce === "string" ? event.turnNonce : "";

    try {
      const profile = await this.host.manager.getAgentDisplayProfile(agentId);
      if (profile == null) {
        await this.host.relay.removeDeletedAgent(agentId);
        await this.host.reconcileShareState();
        return;
      }

      await this.host.manager.appendSharedRoomActivityNotice({
        roomId,
        text: `${profile.name} is responding in ${room.name} at the request of ${room.hostName}.`,
      });
      const peers = this.readPeers(event.peers);
      const prompts = buildSharedRoomMemberPrompts({
        member: { id: agentId, name: profile.name, description: profile.description },
        group: {
          name: typeof event.groupName === "string" ? event.groupName : "Shared room",
          description: typeof event.groupDescription === "string" ? event.groupDescription : "",
        },
        peers,
        hostName: room.hostName,
        newMessages: normalizeTurnMessages(event.newMessages),
      });
      const messages = await this.host.manager.runRemoteRequestedMemberTurn({ agentId, ...prompts });
      await this.sendResult(roomId, turnNonce, agentId, messages.slice(0, 2));
    } catch {
      try {
        await this.sendResult(roomId, turnNonce, agentId, []);
      } catch {
        // A failed empty response has no second route back to the requesting host.
      }
    }
  }

  private containsHuman(room: SharedRoom, authId: string): boolean {
    return room.members.some((member) => member.kind === "human" && member.authId === authId);
  }

  private containsAgent(room: SharedRoom, authId: string, agentId: string): boolean {
    return room.members.some((member) => member.kind === "agent" && member.authId === authId && member.agentId === agentId);
  }

  private budgetKey(roomId: string, hostAuthId: string, agentId: string): string {
    return `${roomId}\0${hostAuthId}\0${agentId}`;
  }

  private readPeers(raw: unknown): Array<{ id: string; name: string; description: string }> {
    if (!Array.isArray(raw)) return [];
    return raw.map((value, index) => {
      const peer = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
      return {
        id: `peer:${index}`,
        name: normalizeSharedRoomName(typeof peer.name === "string" ? peer.name : ""),
        description: typeof peer.description === "string" ? peer.description : "",
      };
    });
  }

  private async sendResult(roomId: string, turnNonce: string, agentId: string, messages: string[]): Promise<void> {
    await this.host.relay.send({ kind: "turn-result", roomId, turnNonce, agentId, messages });
  }
}

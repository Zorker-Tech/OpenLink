import type { DeadlinePolicy } from "../extensions/scheduling.ts";
import type { GroupMessage } from "../groups/group-chat.ts";
import type { XuserTurnDedupe } from "./xuser-turn-dedupe-store.ts";

export const REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS = 10 * 60_000;
export const REMOTE_TURN_BUDGET_WINDOW_MS = 10 * 60_000;
export const REMOTE_TURN_BUDGET_MAX = 30;

export interface SharedRoom {
  roomId: string;
  name: string;
  hostName: string;
  hostAuthId: string;
  members: Array<{ kind: string; authId: string; agentId?: string }>;
}

export interface RemoteTurnsHost {
  relay: {
    send(payload: unknown): Promise<unknown>;
    requestDrain(): void;
    removeDeletedAgent(agentId: string): Promise<unknown>;
  };
  manager: {
    getAgentDisplayProfile(agentId: string): Promise<{ name: string; description: string } | null>;
    appendSharedRoomActivityNotice(args: { roomId: string; text: string }): Promise<void>;
    runRemoteRequestedMemberTurn(args: { agentId: string; systemPrompt: string; prompt: string }): Promise<string[]>;
  };
  clock: { now(): number };
  remoteTurnDeadline: DeadlinePolicy;
  isEnabled(): boolean;
  getSelfAuthId(): string | null;
  getRooms(): SharedRoom[];
  turnDedupe: XuserTurnDedupe;
  reconcileShareState(): Promise<void>;
}

export interface RemoteMemberTurnArgs {
  readonly member: { readonly id: string };
  readonly sharedRoomId: string;
  readonly group: { readonly name: string; readonly description: string };
  readonly peers: Array<{ readonly name: string; readonly description: string }>;
  readonly newMessages: readonly GroupMessage[];
}

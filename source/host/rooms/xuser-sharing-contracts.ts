import type { Clock, DeadlinePolicy, ExpiryPolicy, PollingPolicy } from "../extensions/scheduling.ts";
import type { XuserPendingDepartureStore } from "./xuser-pending-departure-store.ts";
import type { XuserRoomTombstoneStore } from "./xuser-room-tombstone-store.ts";
import type { XuserRoom } from "./xuser-state-reconcile.ts";
import type { XuserTurnDedupe } from "./xuser-turn-dedupe-store.ts";

export interface SharingManager {
  getSharedRoomIdForAgent(id: string): Promise<string | null>;
  listRoomAgentIds(roomId: string): Promise<string[]>;
  markMirrorRoomRevoked(roomId: string): Promise<void>;
  getAgentDisplayProfile(id: string): Promise<{ name: string; description: string } | null>;
  getAgentAvatar(id: string): Promise<{ dataUrl: string } | null>;
  restampRoomEntry(args: { roomId: string; entryId: string; timestampMs: number }): Promise<void>;
  appendSharedRoomActivityNotice(args: { roomId: string; text: string }): Promise<void>;
  runRemoteRequestedMemberTurn(args: { agentId: string; systemPrompt: string; prompt: string }): Promise<string[]>;
  appendMirrorRoomEntry(args: unknown): Promise<boolean>;
  postSharedRoomGuestMessage(args: unknown): Promise<void>;
  ensureMirrorRoom(room: XuserRoom, id: string): Promise<void>;
  ensureHostedSharedRoom(args: unknown): Promise<string | null>;
  findRoomAgentId(roomId: string): Promise<string | null>;
  isAgentCapReached(): Promise<boolean>;
}

export interface SharingTiming {
  readonly clock: Clock;
  readonly relayPoll: PollingPolicy;
  readonly reconcilePoll: PollingPolicy;
  readonly selfIdentityRetry: PollingPolicy;
  readonly remoteTurnDeadline: DeadlinePolicy;
  readonly typingExpiry: (delayMs: number) => ExpiryPolicy;
}

export interface SharingDependencies {
  readonly getAccessToken: (options: { backendUrl: string }) => Promise<string>;
  readonly getBackendUrl: () => string;
  readonly getSelfAuthId: () => Promise<string | null>;
  readonly isEnabled: () => boolean;
  readonly manager: SharingManager;
  readonly emitSharing: (state: unknown) => void;
  readonly resolveAttachment: (url: string) => Promise<{ data: Uint8Array; mimeType: string } | null>;
  readonly timing: SharingTiming;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly pendingDepartures?: XuserPendingDepartureStore | undefined;
  readonly roomTombstones?: XuserRoomTombstoneStore | undefined;
  readonly turnDedupe?: XuserTurnDedupe | undefined;
  readonly isNotifyConnected?: (() => boolean) | undefined;
  readonly isNotifySafetyPollEnabled?: (() => boolean) | undefined;
}

export interface SlateSharingState {
  readonly isEnabled: boolean;
  readonly selfAuthId: string | null;
  readonly pendingJoinRequests: Array<Record<string, unknown>>;
  readonly rooms: XuserRoom[];
  readonly typingUsers: Array<{ roomId: string; authId: string; name: string; avatarUrl?: string; expiresAtMs: number }>;
}

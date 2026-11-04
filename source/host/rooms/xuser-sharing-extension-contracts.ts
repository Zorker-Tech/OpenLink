import type { SlateXuserSharingService, SharingManager } from "./xuser-sharing-service.ts";
import type { XuserSharingEnvironment } from "./xuser-sharing-environment.ts";

export const SHARING_DISABLED_MESSAGE = "Sharing isn't enabled for your account.";

export interface SharingFeatureGate {
  get(): boolean;
  subscribe(listener: (value: boolean) => void): () => void;
}

export interface SharingHost {
  log(message: string): void;
  readonly whenBackgroundWorkReady: Promise<unknown>;
}

export interface SharingEnabledState {
  readonly isEnabled: boolean;
  set(isEnabled: boolean): void;
}

export type SharingLifecycleService = Pick<
  SlateXuserSharingService,
  "buildManagerDelegate" | "start" | "stop" | "requestRelayDrain"
>;

export type SharingApiService = Pick<
  SlateXuserSharingService,
  | "getState"
  | "createRoomFromAgent"
  | "createRoomInvite"
  | "joinRoom"
  | "respondToJoinRequest"
  | "createSharedRoom"
  | "addOwnAgent"
  | "removeOwnAgent"
  | "setRoomTyping"
  | "leaveSharedRoom"
  | "noteAgentDeleted"
  | "start"
  | "stop"
>;

export interface CrossUserSharingLifecycle {
  readonly isEnabled: boolean;
  readonly isStopped: boolean;
  applyGate(on: boolean): void;
  applyGuardedGate(on: boolean): void;
  requestRelayDrain(): void;
  emit(state: unknown): void;
  stop(): void;
}

export interface CrossUserSharingServiceSources {
  readonly auth: { getAccessToken(options: { backendUrl: string }): Promise<string> };
  readonly manager: SharingManager & { setXuserDelegate(value: unknown): void };
  readonly attachments: {
    resolveChannelAttachment(url: string): Promise<{ transport: string; isImage: boolean; bytes: Uint8Array; mime: string } | null>;
  };
  readonly notifyBus: {
    isConnected(): boolean;
    isSafetyPollEnabled(): boolean;
  };
  readonly isEnabled: () => boolean;
  readonly emitSharing: (state: unknown) => void;
}

export interface CrossUserSharingLifecycleOptions {
  readonly service: SharingLifecycleService;
  readonly enabledState: SharingEnabledState;
  readonly transcript: { setXuserDelegate(value: unknown): void };
  readonly host: Pick<SharingHost, "log">;
  readonly environment: XuserSharingEnvironment;
  readonly listeners: Set<(state: unknown) => void>;
  readonly warn?: (message: string) => void;
}

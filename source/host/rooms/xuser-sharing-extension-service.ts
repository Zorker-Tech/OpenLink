import { createDeadlinePolicy, createExpiryPolicy, createPollingPolicy, realClock } from "../extensions/scheduling.ts";
import { getConfiguredBackendUrl, parseJwtPayload } from "../../shared/node/slate-token.ts";
import { getSlateRootDir } from "../host-paths.ts";
import { SHARED_ROOM_MEMBER_TURN_TIMEOUT_MS } from "../groups/xuser.ts";
import { XUSER_RELAY_POLL_INTERVAL_MS } from "./xuser-relay.ts";
import {
  SlateXuserPendingDepartureStore,
} from "./xuser-pending-departure-store.ts";
import { SlateXuserRoomTombstoneStore } from "./xuser-room-tombstone-store.ts";
import {
  SELF_IDENTITY_RETRY_MS,
  SlateXuserSharingService,
  STATE_RECONCILE_INTERVAL_MS,
  type SharingDependencies,
} from "./xuser-sharing-service.ts";
import { SlateXuserTurnDedupeStore } from "./xuser-turn-dedupe-store.ts";
import type { CrossUserSharingServiceSources } from "./xuser-sharing-extension-contracts.ts";

/** Only uploaded images may cross the sharing boundary as room attachments. */
export async function resolveCrossUserSharingAttachment(
  attachments: CrossUserSharingServiceSources["attachments"],
  url: string,
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  const attachment = await attachments.resolveChannelAttachment(url);
  if (attachment == null || attachment.transport !== "upload" || !attachment.isImage) return null;
  return { data: attachment.bytes, mimeType: attachment.mime };
}

/** Build the sharing service from the host's auth, transcript, attachment, and notification ports. */
export function createCrossUserSharingService(sources: CrossUserSharingServiceSources): SlateXuserSharingService {
  const backendUrl = () => getConfiguredBackendUrl();
  const dependencies: SharingDependencies = {
    getAccessToken: sources.auth.getAccessToken,
    getBackendUrl: backendUrl,
    isNotifyConnected: () => sources.notifyBus.isConnected(),
    isNotifySafetyPollEnabled: () => sources.notifyBus.isSafetyPollEnabled(),
    timing: {
      clock: realClock,
      relayPoll: createPollingPolicy(realClock, { name: "cross-user-sharing-relay-poll", intervalMs: XUSER_RELAY_POLL_INTERVAL_MS }),
      reconcilePoll: createPollingPolicy(realClock, { name: "cross-user-sharing-state-reconcile", intervalMs: STATE_RECONCILE_INTERVAL_MS }),
      selfIdentityRetry: createPollingPolicy(realClock, { name: "cross-user-sharing-self-identity", intervalMs: SELF_IDENTITY_RETRY_MS }),
      remoteTurnDeadline: createDeadlinePolicy(realClock, { name: "cross-user-sharing-remote-turn", timeoutMs: SHARED_ROOM_MEMBER_TURN_TIMEOUT_MS }),
      typingExpiry: (ttlMs) => createExpiryPolicy(realClock, { name: "cross-user-sharing-typing-expiry", ttlMs }),
    },
    isEnabled: sources.isEnabled,
    getSelfAuthId: async () => {
      try {
        return parseJwtPayload(await sources.auth.getAccessToken({ backendUrl: backendUrl() }))?.sub ?? null;
      } catch {
        return null;
      }
    },
    manager: sources.manager,
    emitSharing: sources.emitSharing,
    resolveAttachment: (url) => resolveCrossUserSharingAttachment(sources.attachments, url),
    turnDedupe: new SlateXuserTurnDedupeStore(getSlateRootDir()),
    pendingDepartures: new SlateXuserPendingDepartureStore(getSlateRootDir()),
    roomTombstones: new SlateXuserRoomTombstoneStore(getSlateRootDir()),
  };
  return new SlateXuserSharingService(dependencies);
}

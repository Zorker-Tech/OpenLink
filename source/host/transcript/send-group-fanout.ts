/**
 * Delivering a message into the room it was sent to.
 *
 * A send from a group member goes to the group's room rather than to a one-on-one transcript, and what the group
 * configuration says decides which; a send that is not part of a group is left to the caller.
 */
import { dirname } from "node:path";
import { readSlateGroupConfig } from "../groups/group-store.ts";
import type { LiveTranscriptSession } from "./session-runtime.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

interface GroupSendArgs {
  readonly session: LiveTranscriptSession;
  readonly trimmedPrompt: string;
  readonly selectedImages: readonly unknown[];
  readonly videoAttachmentPaths: readonly unknown[];
  readonly fileAttachmentPaths: readonly string[];
  readonly clientNonce?: string | undefined;
  readonly userMessageId?: string | undefined;
  readonly awaitTurn: boolean;
  readonly acceptedAtMs: number;
  readonly traceCtx: unknown;
  readonly readAddressedTranscript: () => readonly { readonly id: string }[];
  readonly nextTurnEpoch: (session: LiveTranscriptSession) => number;
  readonly markSendAccepted: (clientNonce?: string | undefined) => void;
}

async function dispatchRemoteRoomSend(
  tm: TranscriptManagerLike,
  args: GroupSendArgs,
): Promise<void> {
  await tm.sharedRooms.dispatchMirrorRoomSend(args.session, {
    text: args.trimmedPrompt,
    selectedImages: args.selectedImages,
    hasNonImageAttachments: args.videoAttachmentPaths.length > 0 || args.fileAttachmentPaths.length > 0,
    clientNonce: args.clientNonce,
  });
  args.markSendAccepted(args.clientNonce);
}

function publishGroupEntryIfConfigured(tm: TranscriptManagerLike, args: GroupSendArgs): void {
  const roomId = readSlateGroupConfig(dirname(args.session.dbPath))?.sharedRoomId;
  if (roomId == null || args.userMessageId == null) return;
  const entry = args.readAddressedTranscript().find(candidate => candidate.id === args.userMessageId);
  if (entry !== undefined) tm.xuserDelegate?.publishRoomEntry(roomId, entry);
}

async function dispatchGroupTurn(tm: TranscriptManagerLike, args: GroupSendArgs): Promise<void> {
  publishGroupEntryIfConfigured(tm, args);
  const epoch = args.nextTurnEpoch(args.session);
  tm.runLifecycle.beginSessionRun(args.session);
  const completion = tm.runLifecycle.enqueueExclusiveRun(
    args.session.id,
    () => tm.groupChat.runGroupTurn(args.session, epoch, args.traceCtx, "user"),
    { lane: "user", source: "group", acceptedAtMs: args.acceptedAtMs },
  );
  args.markSendAccepted(args.clientNonce);

  if (args.awaitTurn) {
    await completion;
    return;
  }
  void completion.catch((error: unknown) => {
    console.error("[slate] detached group turn failed after send acceptance:", error);
  });
}

export async function dispatchMirrorOrGroupSend(
  tm: TranscriptManagerLike,
  args: GroupSendArgs,
): Promise<boolean> {
  if (tm.groupChat.isRemoteRoomSession(args.session)) {
    await dispatchRemoteRoomSend(tm, args);
    return true;
  }
  if (!tm.groupChat.isGroupSession(args.session)) return false;
  await dispatchGroupTurn(tm, args);
  return true;
}

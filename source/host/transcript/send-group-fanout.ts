/**
 * Delivering a message into the room it was sent to.
 *
 * A send from a group member goes to the group's room rather than to a one-on-one transcript, and what the group
 * configuration says decides which; a send that is not part of a group is left to the caller.
 */
import { dirname } from "node:path";
import { readSlateGroupConfig } from "../groups/group-store.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export async function dispatchMirrorOrGroupSend(
  tm: TranscriptManagerLike,
  args: any,
): Promise<boolean> {
  const {
    session,
    trimmedPrompt,
    selectedImages,
    videoAttachmentPaths,
    fileAttachmentPaths,
    clientNonce,
    userMessageId,
    awaitTurn,
    acceptedAtMs,
    traceCtx,
    readAddressedTranscript,
    nextTurnEpoch,
    markSendAccepted,
  } = args;
  if (tm.groupChat.isRemoteRoomSession(session)) {
    await tm.sharedRooms.dispatchMirrorRoomSend(session, {
      text: trimmedPrompt,
      selectedImages,
      hasNonImageAttachments:
        videoAttachmentPaths.length > 0 || fileAttachmentPaths.length > 0,
      clientNonce,
    });
    markSendAccepted(clientNonce);
    return true;
  }
  if (!tm.groupChat.isGroupSession(session)) return false;
  const sharedRoomId = readSlateGroupConfig(
    dirname(session.dbPath),
  )?.sharedRoomId;
  if (sharedRoomId != null && userMessageId != null) {
    const userEntry = readAddressedTranscript().find(
      (candidate: any) => candidate.id === userMessageId,
    );
    if (userEntry != null)
      tm.xuserDelegate?.publishRoomEntry(sharedRoomId, userEntry);
  }
  const epoch = nextTurnEpoch(session);
  tm.runLifecycle.beginSessionRun(session);
  const done = tm.runLifecycle.enqueueExclusiveRun(
    session.id,
    () => tm.groupChat.runGroupTurn(session, epoch, traceCtx, "user"),
    { lane: "user", source: "group", acceptedAtMs },
  );
  markSendAccepted(clientNonce);
  if (awaitTurn) await done;
  else
    void done.catch((error: unknown) =>
      console.error(
        "[slate] detached group turn failed after send acceptance:",
        error,
      ),
    );
  return true;
}

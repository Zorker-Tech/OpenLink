import { dirname } from "node:path";
import { agentSettingsAt, getSlateSettingsPath } from "../../agents/settings-file.ts";
import { getSlateProfilePath, readSlateProfileFile } from "../../agents/agent-profile.ts";
import { ensureAgentSettingsDocument } from "./session-recovery.ts";
import { agentHasDurableFootprint } from "./session-summary-footprint.ts";
import { minimalAgentSummary } from "./session-summary-minimal.ts";
import type { BuildSummaryArgs } from "./session-summary-contracts.ts";

/** Build the complete agent row, or omit an empty and unrecoverable entry from the session list. */
export async function buildSummary(args: BuildSummaryArgs) {
  const summaryDirectory = dirname(args.dbPath);
  ensureAgentSettingsDocument(args.dbPath);

  const fallbackSummary = minimalAgentSummary(args);
  const persistedProfile = readSlateProfileFile(getSlateProfilePath(summaryDirectory));
  const notificationSettings = agentSettingsAt(getSlateSettingsPath(summaryDirectory));
  const databaseExtras = args.extras ?? null;
  const displayName = persistedProfile?.name?.trim() || "Slate";
  const profileDescription = persistedProfile?.description ?? "";
  const profileTitle = persistedProfile?.title ?? "";
  const groupConversation = args.isGroup === true;
  const hasVisibleIdentity = groupConversation
    || displayName !== "Slate"
    || profileDescription.trim().length > 0
    || profileTitle.length > 0;

  if (
    databaseExtras != null
    && !databaseExtras.hasTranscript
    && !fallbackSummary.isActive
    && !hasVisibleIdentity
    && !args.includeBlank
    && !await agentHasDurableFootprint(summaryDirectory, args.agentHasMemory ?? (() => false))
  ) {
    return null;
  }

  const avatarRead = await args.readAvatar?.(summaryDirectory, databaseExtras?.legacyAvatarPath ?? null) ?? null;
  const hasUnreadActivity = databaseExtras != null
    && (databaseExtras.unreadState.isManuallyUnread
      || databaseExtras.unreadState.lastActivityAt > databaseExtras.unreadState.lastViewedAt);

  return {
    ...fallbackSummary,
    id: databaseExtras?.agentId ?? args.dirName,
    name: displayName,
    description: profileDescription,
    title: profileTitle,
    avatarDataUrl: avatarRead?.dataUrl ?? null,
    avatarVersion: avatarRead?.version ?? null,
    createdAt: databaseExtras?.createdAt ?? fallbackSummary.createdAt,
    updatedAt: databaseExtras?.updatedAt ?? fallbackSummary.updatedAt,
    lastEntry: databaseExtras?.lastEntry ?? null,
    lastMessageId: databaseExtras?.lastMessage?.id ?? null,
    lastMessagePreview: databaseExtras?.lastMessage?.preview ?? null,
    newestEntryId: databaseExtras?.newestEntryId ?? null,
    hasUnread: hasUnreadActivity,
    unreadCount: hasUnreadActivity ? Math.max(databaseExtras?.unreadState.unreadCount ?? 0, 1) : 0,
    lastViewedAt: databaseExtras?.unreadState.lastViewedAt ?? 0,
    lastActivityAt: databaseExtras?.unreadState.lastActivityAt ?? 0,
    awaitingUserResponse: databaseExtras?.awaitingUserResponse ?? null,
    notifyOnUpdatesEnabled: notificationSettings.notifyOnAgentUpdates,
    isHiddenFromSidebar: notificationSettings.hiddenFromSidebar,
    origin: databaseExtras?.origin ?? "user",
    ...(databaseExtras?.purpose == null ? {} : { purpose: databaseExtras.purpose }),
    isGroup: groupConversation,
    memberIds: args.memberIds ?? [],
    ...(args.remoteRoom == null ? {} : { remoteRoom: args.remoteRoom }),
    conversationPartnerIds: databaseExtras?.conversationPartnerIds ?? [],
  };
}

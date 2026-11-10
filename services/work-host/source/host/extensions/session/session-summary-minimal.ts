import { dirname } from "node:path";
import { getSlateProfilePath, readSlateProfileFile } from "../../agents/agent-profile.ts";
import type { SummaryStats } from "./session-summary-contracts.ts";

function optionalProfileText(value?: string | null): string | null {
  return value != null && value.length > 0 ? value : null;
}

/** The list row available when durable conversation state could not be read. */
export function minimalAgentSummary(args: {
  readonly dirName: string;
  readonly dbPath: string;
  readonly dbStats?: SummaryStats;
  readonly activeAgentId?: string;
}) {
  const profilePath = getSlateProfilePath(dirname(args.dbPath));
  const profile = readSlateProfileFile(profilePath);
  const fallbackTime = Math.floor(Number(args.dbStats?.mtimeMs ?? 0));

  return {
    id: args.dirName,
    name: profile?.name?.trim() || "Slate",
    description: profile?.description ?? "",
    title: profile?.title ?? "",
    avatarDataUrl: null,
    avatarVersion: null,
    avatarShape: optionalProfileText(profile?.avatarShape),
    avatarColor: optionalProfileText(profile?.avatarColor),
    createdAt: fallbackTime,
    updatedAt: fallbackTime,
    path: args.dbPath,
    isActive: args.dirName === args.activeAgentId,
    isRunning: false,
    isComposingMessage: false,
    lastEntry: null,
    lastMessageId: null,
    lastMessagePreview: null,
    newestEntryId: null,
    hasUnread: false,
    unreadCount: 0,
    lastViewedAt: 0,
    lastActivityAt: 0,
    awaitingUserResponse: null,
    notificationsEnabled: false,
    notifyOnUpdatesEnabled: true,
    isHiddenFromSidebar: false,
    origin: "user",
    isGroup: false,
    memberIds: [],
    conversationPartnerIds: [],
  };
}

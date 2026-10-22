/**
 * A conversation between the members of a group.
 *
 * Members speak in rounds, the order rotating each round so the same member does not always go first, and each round is
 * bounded in how many turns and messages it may produce; the transcript a member is shown is bounded too.
 *
 * A mention only counts as a whole word, and a member is never shown a private one-on-one exchange.
 */

/** What a stored group configuration is written as, and the bounds a round of conversation runs under. */
export const GROUP_CONFIG_VERSION = 1;
export const GROUP_MAX_MEMBER_TURNS = 10;
export const GROUP_MAX_ROUNDS = 3;
export const GROUP_PROMPT_HISTORY_LIMIT = 24;
export const GROUP_MAX_MESSAGES_PER_TURN = 2;
export const SHARED_ROOM_HISTORY_LIMIT = 24;

/** The words a group turn is tagged with, so a stored prompt can be told from a message. */
export const GROUP_CHAT_TAG_PREFIX = "[Group chat: ";
export const SLATE_HIDDEN_PROMPT_MARKER = "[SLATE_HIDDEN_PROMPT]";

export interface GroupMember { id: string; name: string; description: string } export interface GroupDescription { name: string; description: string } export type GroupMessage = { speaker: { kind: "user"; name?: string } | { kind: "member"; id: string; name: string }; content: string };

/** The order the members speak in this round: the round number turns the start, so it rotates. */
export function orderRoundSpeakers<T>(memberIds: readonly T[], round: number): T[] {
  const count = memberIds.length;
  if (!count) return [];
  const offset = ((round % count) + count) % count;
  return [...memberIds.slice(offset), ...memberIds.slice(0, offset)];
}

/** Whether two lists name the same members, in any order. */
export function isSameMemberSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const members = new Set(a);
  return b.every((id) => members.has(id));
}

/** Raised when a group's member list names another group, which a group chat cannot hold. */
export class SlateGroupNestingError extends Error {
  readonly nestedGroupIds: string[];
  constructor(ids: readonly string[]) {
    super(`A group chat can only contain individual agents, not other group chats. Remove the group chat${ids.length === 1 ? "" : "s"} from the member list.`);
    this.name = "SlateGroupNestingError";
    this.nestedGroupIds = [...ids];
  }
}

/** Refuses a member list that names a group: a group chat holds agents, so a nested group is a configuration error. */
export function assertMembersAreNotGroups(ids: readonly string[], isGroupId: (id: string) => boolean): void {
  const nested = [...new Set(ids)].filter(isGroupId);
  if (!nested.length) return;
  throw new SlateGroupNestingError(nested);
}

/** The ways a member's name can be mentioned: its text, its text without spaces, and its first word. */
export function memberMentionHandles(name: string): string[] {
  const lower = name.trim().toLowerCase();
  if (!lower) return [];
  const compact = lower.replace(/\s+/g, "");
  const handles = new Set([lower, compact]);
  const first = lower.split(/\s+/)[0];
  if (first) handles.add(first);
  return [...handles];
}

/** A character that a mention may not sit next to. */
const WORD_CHARACTER = /[a-z0-9]/;

/** Whether this character is one a mention may not sit next to. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char);
}

/** Whether the mention appears in the text as a whole word, at any position. */
function hasMentionAt(lower: string, handle: string): boolean {
  const needle = `@${handle}`;
  let found = lower.indexOf(needle);
  while (found >= 0) {
    const before = lower[found - 1];
    const after = lower[found + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    found = lower.indexOf(needle, found + 1);
  }
  return false;
}

/** The mention that calls the whole room. */
const EVERYONE_MENTION = /(?:^|[^a-z0-9])@(everyone|all)\b/;

/** Everyone a message mentions, in the order their members are listed, and whether it calls the whole room. */
export function parseGroupMentions(text: string, members: readonly Pick<GroupMember, "id" | "name">[]): { isEveryone: boolean; memberIds: string[] } {
  const folded = text.toLowerCase();
  const mentioned = new Map<string, string>();
  for (const member of members) {
    if (mentioned.has(member.id)) continue;
    if (memberMentionHandles(member.name).some((handle) => hasMentionAt(folded, handle))) mentioned.set(member.id, member.id);
  }
  return { isEveryone: EVERYONE_MENTION.test(folded), memberIds: [...mentioned.keys()] };
}

/** Where the round starts: the last message the user sent, or the top of the transcript when they have said nothing. */
function roundStart(history: readonly GroupMessage[]): number {
  const found = history.findLastIndex((message) => message.speaker.kind === "user");
  return found === -1 ? 0 : found;
}

/** Who answers: every member when the round calls everyone or names nobody, and only the named members otherwise. */
export function resolveResponders<T extends Pick<GroupMember, "id" | "name">>(members: readonly T[], history: readonly GroupMessage[]): T[] {
  const mentioned = new Set<string>();
  let everyone = false;
  for (const message of history.slice(roundStart(history))) {
    const targets = parseGroupMentions(message.content, members);
    everyone ||= targets.isEveryone;
    for (const id of targets.memberIds) mentioned.add(id);
  }
  if (everyone || mentioned.size === 0) return [...members];
  return members.filter((member) => mentioned.has(member.id));
}

/** Whether a message is a pass: nothing at all, or the word in parentheses, in any case and with an optional dot. */
export function isPassContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return /^\(?\s*pass\s*\)?\.?$/i.test(trimmed);
}

/** Whether a message could still become a pass, which is what a reply is checked against while it streams. */
export function isPotentialPassPrefix(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || isPassContent(trimmed)) return true;
  return /^\(?\s*(?:p(?:a(?:s(?:s\s*\)?\.?)?)?)?)?$/i.test(trimmed);
}

/** What a redriven turn tells the member about the direct message that interrupted it. */
function redriveNote(): string {
  return "\n(Redelivery: your previous attempt at this turn was interrupted by a direct message to you. The room has NOT seen any reply from you for the messages above — anything you said or did while handling that direct message stayed in that private chat. If you already did the work, send the result to this room with SendMessage now; otherwise take the turn normally.)";
}

export function buildGroupRedriveNote(): string {
  return redriveNote();
}

/** One message as a transcript line, marked with who said it and, for the viewer's own, "(you)". */
export function formatGroupLine(message: GroupMessage, viewerId: string): string {
  if (message.speaker.kind === "user") {
    const name = message.speaker.name;
    return name ? `${name} (user): ${message.content}` : `User: ${message.content}`;
  }
  const you = message.speaker.id === viewerId ? " (you)" : "";
  return `${message.speaker.name}${you}: ${message.content}`;
}

/** The last messages of a transcript as text, bounded; an empty transcript says so. */
export function formatGroupHistory(history: readonly GroupMessage[], viewerId: string, limit = GROUP_PROMPT_HISTORY_LIMIT): string {
  const recent = history.slice(-limit);
  if (!recent.length) return "(no messages yet)";
  return recent.map((message) => formatGroupLine(message, viewerId)).join("\n");
}

/** The text with the hidden prompt marker taken off the front, when it is there. */
function withoutHiddenMarker(text: string): string {
  return text.startsWith(SLATE_HIDDEN_PROMPT_MARKER) ? text.slice(SLATE_HIDDEN_PROMPT_MARKER.length) : text;
}

/** Whether this text is the prompt a group turn runs with, with or without the hidden marker on it. */
export function isGroupTurnPromptText(text: string): boolean {
  return withoutHiddenMarker(text).startsWith(GROUP_CHAT_TAG_PREFIX);
}

/** The name a group is shown under: its own when it has one, and a stand-in when it does not. */
export function groupDisplayName(group: GroupDescription): string {
  const name = group.name.trim();
  return name || "the group";
}

/** A group as one phrase: its name, and its description when it has one. */
export function describeGroup(group: GroupDescription): string {
  const name = groupDisplayName(group);
  const description = group.description.trim();
  if (!description) return `"${name}"`;
  return `"${name}" — ${description}`;
}

/** The tag a group turn's prompt starts with, naming the group and the peers in the room. */
export function formatGroupChatTag(group: GroupDescription, peers: readonly Pick<GroupMember, "name">[]): string {
  const name = groupDisplayName(group);
  const withPeers = peers.length > 0 ? ` - with ${peers.map((peer) => peer.name).join(", ")}` : "";
  return `${GROUP_CHAT_TAG_PREFIX}"${name}"${withPeers}]`;
}

/** One other participant as the system prompt lists them: their name, and their description when they have one. */
function participantLine(peer: GroupMember): string {
  const description = peer.description.trim();
  return `- ${peer.name}${description ? ` (${description})` : ""}`;
}

/** The system prompt a member is given: who it is, who else is in the room, and the rules of its turn. */
export function buildGroupMemberSystemPrompt(member: GroupMember, group: GroupDescription, peers: readonly GroupMember[], options: { isSharedRoom?: boolean } = {}): string {
  const greeting = `You are ${member.name}, one participant in a group chat (${describeGroup(group)}).`;
  const persona = member.description.trim();
  const personaLine = persona ? [`Your persona: ${persona}`] : [];
  const peersSection = peers.length > 0 ? ["", "Other participants in the room:", ...peers.map(participantLine)] : [];
  const audience = peers.map((peer) => peer.name).join(", ");
  const speaking = peers.length > 0 ? `Right now you are speaking in this group chat, with ${audience}.` : "Right now you are speaking in this group chat.";
  const rules = options.isSharedRoom
    ? "This is a cross-user room turn. Tool calls and plain text are private scratch space; only SendMessage plain text is delivered to the room."
    : "You have your full toolkit in this room. Do the work first, then deliver the result with SendMessage.";
  const character = `Stay fully in character as ${member.name}. The ONLY way to say something the room can see is the SendMessage tool. Keep each message short and conversational. If you have nothing new worth adding, send exactly \"(pass)\". Never reveal private one-on-one context.`;
  return [greeting, ...personaLine, ...peersSection, "", speaking, rules, "", character].join("\n");
}

/** The messages after this member last spoke, or the whole transcript when it has never spoken. */
export function messagesSinceMemberLastSpoke(history: readonly GroupMessage[], memberId: string): readonly GroupMessage[] {
  const spokeAt = history.findLastIndex((message) => message.speaker.kind === "member" && message.speaker.id === memberId);
  return spokeAt === -1 ? history : history.slice(spokeAt + 1);
}

/** The prompt for one member's turn: the room since it last spoke, and what to do with it. */
export function buildGroupTurnPrompt(args: { member: GroupMember; group: GroupDescription; peers: readonly GroupMember[]; newMessages: readonly GroupMessage[] }): string {
  let transcript = "No new messages in the room since your last turn.";
  if (args.newMessages.length > 0) transcript = `New messages in the room (oldest first):\n${formatGroupHistory(args.newMessages, args.member.id)}`;
  const lines = [
    formatGroupChatTag(args.group, args.peers),
    transcript,
    "",
    `It's your turn, ${args.member.name}. Reply in character with a single SendMessage if you have something worth adding, or send \"(pass)\" if you don't.`,
  ];
  return lines.join("\n");
}

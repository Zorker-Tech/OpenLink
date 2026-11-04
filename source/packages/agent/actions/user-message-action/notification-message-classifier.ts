export interface UserMessageCandidate {
  role: string;
  content?: unknown;
}

export const NOTIFICATION_TAG_NAMES = [
  "system_notification",
  "agent_notification",
  "task_notification",
  "side_chat_boundary",
];

const XML_ELEMENT = /<(?:(\/)\s*([A-Za-z_][\w:.-]*)\s*>|([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?(\/)?\>)/g;

export function getUserMessageTextContent(message: UserMessageCandidate): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      part !== null
      && typeof part === "object"
      && "type" in part
      && part.type === "text"
      && "text" in part
      && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function isNotificationOnlyUserMessage(message: UserMessageCandidate): boolean {
  const text = getUserMessageTextContent(message);
  if (text === undefined || text.length === 0) return false;

  const nesting: string[] = [];
  for (const match of text.matchAll(XML_ELEMENT)) {
    const [, closingSlash, closingTagName, openingTagName, selfClosingSlash] = match;
    if (closingSlash !== undefined && closingTagName !== undefined) {
      if (nesting.at(-1) === closingTagName) nesting.pop();
      continue;
    }
    if (openingTagName === undefined) continue;
    if (nesting.length === 0 && NOTIFICATION_TAG_NAMES.includes(openingTagName)) return true;
    if (selfClosingSlash === undefined) nesting.push(openingTagName);
  }
  return false;
}

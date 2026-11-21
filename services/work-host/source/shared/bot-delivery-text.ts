/** The exact wire value used when a Bot opts out of a public message. */
export function isSilentBotReply(text: string): boolean {
  return /^\s*\{\s*"message"\s*:\s*null\s*\}\s*$/u.test(text);
}

export function isBotControlLabel(text: string): boolean {
  return isSilentBotReply(text) || /<\/?SendMessage(?:\s|>)/iu.test(text)
    || /^\s*\[(?:System recovery|SLATE_HIDDEN_PROMPT)\]/iu.test(text);
}

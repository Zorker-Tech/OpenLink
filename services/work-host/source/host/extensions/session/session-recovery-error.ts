export class ConversationRecoveryScanError extends Error {
  constructor(readonly detail: string) {
    super(`Slate could not read conversation recovery records: ${detail}`)
    this.name = "ConversationRecoveryScanError"
  }
}

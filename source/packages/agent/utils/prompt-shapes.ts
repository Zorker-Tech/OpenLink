/**
 * The shapes a prompt has once it has been assembled.
 *
 * A prompt reaches the platform as a list of messages from a provider SDK, and its content is a union
 * of text, tool calls, tool results and reasoning parts. The two views built from it — the token
 * breakdown and the context tree — read the same fields, so the shapes are declared once, here, rather
 * than twice in slightly different words.
 */

export interface PromptMessageLike {
  role: string
  content?: unknown
  /**
   * Provider options carried on the message. The summary marker is written under the provider's own
   * namespace by the summarizer, so the path is a contract between the two.
   */
  providerOptions?: { cursor?: { isSummary?: boolean } } | undefined
}

export interface PromptToolLike {
  name: string
  toolIdentifier?: string
  description?: string
  parameters?: unknown
  customToolFormat?: unknown
  descriptionGenerator?: (props: Record<string, unknown>) => string
  descriptionTokenPartsGenerator?: (props: Record<string, unknown>) => { subagentDescriptionText?: string }
  [key: string]: unknown
}

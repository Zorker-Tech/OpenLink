export const SEND_MESSAGE_TYPES = ["text", "attachment", "widget", "slate-agent", "secret-request"] as const;
export const SEND_MESSAGE_TYPE_DESCRIPTION = "text for chat messages, attachment for actual files or standalone media, widget for an interactive question with selectable options, slate-agent to reference a Slate cloud agent by its bcId (renders as a card that opens the agent in Slate on click), secret-request to ask the user for a credential through a secure masked input (never a chat paste).";

export type SendMessageType = typeof SEND_MESSAGE_TYPES[number];

export interface SendMessageInput {
  readonly type: SendMessageType;
  readonly content?: string | undefined;
  readonly url?: string | undefined;
  readonly images?: readonly { readonly url: string; readonly alt?: string | undefined }[] | undefined;
  readonly alt?: string | undefined;
  readonly reply_to?: string | undefined;
  readonly channel?: string | undefined;
  readonly widget?: unknown;
  readonly bcId?: string | undefined;
  readonly secret?: { readonly label: string; readonly description?: string | undefined; readonly connector: string; readonly field: string } | undefined;
}

export interface SendMessageIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

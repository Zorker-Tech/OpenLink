import type {
  SendMessagePreviewInput,
  SendMessagePreviewType,
} from "./send-message-preview-contracts.ts"
import {
  connectorsPreviewText,
  slateAgentPreviewText,
} from "./send-message-preview-connectors.ts"

type PreviewMessage<Type extends SendMessagePreviewType> = Extract<SendMessagePreviewInput, { readonly type: Type }>

type Previewers = {
  readonly [Type in SendMessagePreviewType]: (message: PreviewMessage<Type>) => string
}

const previewers = {
  text: message => message.content,
  attachment: message => message.url,
  widget: message => message.widget.prompt,
  "slate-agent": message => slateAgentPreviewText(message.title),
  "secret-request": message => message.secretRequest.label,
  "email-draft": message => message.draft.subject || message.draft.body,
  "slack-draft": message => message.draft.body,
  "permission-request": message => message.permission.title,
  "auto-review-approval": message => `Approval required: ${message.approval.summary}`,
  "local-tool-permission": message => `Permission required: ${message.ask.target}`,
  connector: message => message.variant === "connected"
    ? `${message.connector} connected`
    : `Connect ${message.connector}`,
  connectors: message => connectorsPreviewText(message.connectors),
  "listener-connect": message => `Connect ${message.platform === "slack" ? "Slack" : "GitHub"}`,
} satisfies Previewers

export function sendMessagePreviewText(message: SendMessagePreviewInput): string {
  if (!Object.prototype.hasOwnProperty.call(previewers, message.type)) return "Message"
  const project = previewers[message.type] as (value: SendMessagePreviewInput) => string
  return project(message)
}

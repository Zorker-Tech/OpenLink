interface SendMessagePreviewPayloads {
  text: { readonly content: string }
  attachment: { readonly url: string }
  widget: { readonly widget: { readonly prompt: string } }
  "slate-agent": { readonly title?: string | null }
  "secret-request": { readonly secretRequest: { readonly label: string } }
  "email-draft": { readonly draft: { readonly subject: string; readonly body: string } }
  "slack-draft": { readonly draft: { readonly body: string } }
  "permission-request": { readonly permission: { readonly title: string } }
  "auto-review-approval": { readonly approval: { readonly summary: string } }
  "local-tool-permission": { readonly ask: { readonly target: string } }
  connector: { readonly variant: string; readonly connector: string }
  connectors: { readonly connectors: readonly string[] }
  "listener-connect": { readonly platform: string }
}

export type SendMessagePreviewType = keyof SendMessagePreviewPayloads

export type SendMessagePreviewInput = {
  [Type in SendMessagePreviewType]: {
    readonly type: Type
  } & SendMessagePreviewPayloads[Type]
}[SendMessagePreviewType]

export type PiProtocolAttachment =
  | { type: 'image'; mediaType: string; url: string; filename?: string }
  | { type: 'text'; mediaType: 'text/plain'; text: string; filename?: string }
  | { type: 'instruction'; name: string; text: string }
  | { type: 'reference'; referenceType: 'file' | 'thread'; name: string; path: string }

export interface StagedPromptFile {
  name: string
  path: string
}

export function instructionProtocolText(name: string, text: string): string {
  return `Please follow this user-selected instruction (${name}):\n<openlink-instructions>\n${text}\n</openlink-instructions>`
}

/** Convert OpenLink's agent-independent input protocol to Pi's native
 * text-plus-images prompt shape. Uploaded files are already staged safely in
 * the workspace before this boundary is called. */
export function piPromptProtocolInput(message: string, attachments: PiProtocolAttachment[], uploadedFiles: StagedPromptFile[]) {
  const images = attachments
    .filter((attachment): attachment is Extract<PiProtocolAttachment, { type: 'image' }> => attachment.type === 'image')
    .map((attachment) => ({
      type: 'image' as const,
      data: attachment.url.slice(attachment.url.indexOf(',') + 1),
      mimeType: attachment.mediaType,
    }))
  const context = [
    ...attachments.filter((attachment): attachment is Extract<PiProtocolAttachment, { type: 'instruction' }> => attachment.type === 'instruction').map((attachment) => instructionProtocolText(attachment.name, attachment.text)),
    ...attachments.filter((attachment): attachment is Extract<PiProtocolAttachment, { type: 'text' }> => attachment.type === 'text').map((attachment) => `Attached text${attachment.filename ? ` (${attachment.filename})` : ''}:\n${attachment.text}`),
    ...attachments.filter((attachment): attachment is Extract<PiProtocolAttachment, { type: 'reference' }> => attachment.type === 'reference').map((attachment) => `${attachment.referenceType === 'thread' ? 'Referenced task' : 'Referenced file'} ${attachment.name}: ${attachment.path}`),
    ...uploadedFiles.map((attachment) => `Uploaded file ${attachment.name}: ${attachment.path}`),
  ]
  return { message: [message, ...context].filter(Boolean).join('\n\n'), images }
}

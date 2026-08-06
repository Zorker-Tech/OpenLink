export type PiStreamingBehavior = 'steer' | 'followUp'

export type PiRpcClientCommand =
  | { id: string; type: 'prompt'; message: string; streamingBehavior?: PiStreamingBehavior }
  | { id: string; type: 'abort' }
  | { id: string; type: 'set_model'; provider: string; modelId: string }
  | { id: string; type: 'set_thinking_level'; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

export function createPiPromptCommand({
  requestId,
  message,
  isStreaming = false,
  streamingBehavior = 'steer',
}: {
  requestId: string
  message: string
  isStreaming?: boolean
  streamingBehavior?: PiStreamingBehavior
}): PiRpcClientCommand {
  const text = message.trim()
  if (!text) throw new Error('Pi prompt cannot be empty')
  return {
    id: requestId,
    type: 'prompt',
    message: text,
    ...(isStreaming ? { streamingBehavior } : {}),
  }
}

export function createPiExtensionUiResponse({
  requestId,
  inputKind,
  approved,
  value,
}: {
  requestId: string
  inputKind: 'confirm' | 'select' | 'input' | 'editor'
  approved: boolean
  value?: string
}): PiRpcClientCommand {
  if (inputKind === 'confirm') {
    return { type: 'extension_ui_response', id: requestId, confirmed: approved }
  }
  if (!approved) return { type: 'extension_ui_response', id: requestId, cancelled: true }
  return { type: 'extension_ui_response', id: requestId, value: value ?? '' }
}

export function encodePiRpcCommand(command: PiRpcClientCommand) {
  return `${JSON.stringify(command)}\n`
}


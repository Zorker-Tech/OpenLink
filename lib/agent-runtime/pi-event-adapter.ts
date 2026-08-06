import type { OpenLinkAgentEvent } from './events'

type UnknownRecord = Record<string, unknown>

const asRecord = (value: unknown): UnknownRecord | null => value && typeof value === 'object' ? value as UnknownRecord : null

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function extractContentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((part) => {
      const item = asRecord(part)
      return item?.type === 'text' || item?.type === 'thinking' ? stringValue(item.text) : ''
    }).join('')
  }
  const record = asRecord(value)
  if (!record) return ''
  if (typeof record.output === 'string') return record.output
  if (record.content) return extractContentText(record.content)
  return ''
}

function filePathFromArgs(args: UnknownRecord | null) {
  if (!args) return undefined
  for (const key of ['path', 'filePath', 'file_path', 'target']) {
    if (typeof args[key] === 'string') return args[key] as string
  }
  return undefined
}

function partIdFromFrame(value: UnknownRecord) {
  for (const key of ['partId', 'part_id', 'messagePartId', 'message_part_id']) {
    if (typeof value[key] === 'string') return value[key] as string
  }
  return undefined
}

export class PiEventAdapter {
  private sequence: number
  private currentAssistantMessageId: string | null = null
  private currentReasoningId: string | null = null
  private readonly toolKinds = new Map<string, 'command' | 'file' | 'tool'>()
  private readonly toolArgs = new Map<string, UnknownRecord | null>()
  private readonly toolScopes = new Map<string, { taskId: string; partId?: string }>()
  private readonly partTaskIds = new Map<string, string>()
  private currentExecutionTaskId: string | null = null
  private lastExecutionStartedAt: number | null = null
  private taskIndex = 0

  constructor(
    private readonly sessionId: string,
    private readonly now: () => string = () => new Date().toISOString(),
    startSequence = 0,
  ) {
    this.sequence = Math.max(0, startSequence)
  }

  adapt(frame: unknown): OpenLinkAgentEvent[] {
    const value = asRecord(frame)
    const type = stringValue(value?.type)
    if (!value || !type || type === 'response') return []

    switch (type) {
      case 'agent_start':
        return [this.make({ type: 'session.started' })]
      case 'agent_settled':
        return [this.make({ type: 'session.completed' })]
      case 'message_start':
        return this.messageStart(asRecord(value.message))
      case 'message_update':
        return this.messageUpdate(asRecord(value.assistantMessageEvent))
      case 'message_end':
        return this.messageEnd(asRecord(value.message))
      case 'tool_execution_start':
        return this.toolStart(value)
      case 'tool_execution_update':
        return this.toolUpdate(value)
      case 'tool_execution_end':
        return this.toolEnd(value)
      case 'extension_ui_request':
        return this.extensionRequest(value)
      case 'extension_error':
        return [this.make({ type: 'error', errorId: this.identity('extension-error'), message: stringValue(value.error) || stringValue(value.message) || 'Pi extension failed', recoverable: true })]
      case 'auto_retry_start':
        return [this.make({ type: 'status.updated', statusId: this.identity('retry'), label: `正在重试（${Number(value.attempt) || 1}/${Number(value.maxAttempts) || 3}）`, status: 'active', detail: stringValue(value.errorMessage) })]
      case 'compaction_start':
        return [this.make({ type: 'status.updated', statusId: this.identity('compaction'), label: '正在压缩会话上下文', status: 'active' })]
      case 'compaction_end':
        return [this.make({ type: 'status.updated', statusId: this.identity('compaction'), label: '会话上下文压缩完成', status: value.errorMessage ? 'failed' : 'completed', detail: stringValue(value.errorMessage) })]
      default:
        return []
    }
  }

  private messageStart(message: UnknownRecord | null): OpenLinkAgentEvent[] {
    if (!message) return []
    const role = stringValue(message.role)
    if (role === 'user') {
      return [this.make({ type: 'message.user', messageId: this.identity('user-message'), text: extractContentText(message.content) })]
    }
    if (role === 'assistant') this.currentAssistantMessageId = this.identity('assistant-message')
    return []
  }

  private messageUpdate(update: UnknownRecord | null): OpenLinkAgentEvent[] {
    if (!update) return []
    const updateType = stringValue(update.type)
    if (updateType === 'text_start') {
      this.breakExecutionBurst()
      this.currentAssistantMessageId ??= this.identity('assistant-message')
      return []
    }
    if (updateType === 'text_delta') {
      this.currentAssistantMessageId ??= this.identity('assistant-message')
      return [this.make({ type: 'message.delta', messageId: this.currentAssistantMessageId, delta: stringValue(update.delta) })]
    }
    if (updateType === 'text_end') {
      this.currentAssistantMessageId ??= this.identity('assistant-message')
      return [this.make({ type: 'message.completed', messageId: this.currentAssistantMessageId, text: stringValue(update.content) || undefined })]
    }
    if (updateType === 'thinking_start') {
      this.currentReasoningId = this.identity('reasoning')
      return [this.make({ type: 'reasoning.started', reasoningId: this.currentReasoningId })]
    }
    if (updateType === 'thinking_delta') {
      this.currentReasoningId ??= this.identity('reasoning')
      return [this.make({ type: 'reasoning.delta', reasoningId: this.currentReasoningId, delta: stringValue(update.delta) })]
    }
    if (updateType === 'thinking_end') {
      this.currentReasoningId ??= this.identity('reasoning')
      const result = [this.make({ type: 'reasoning.completed', reasoningId: this.currentReasoningId, text: stringValue(update.content) || undefined })]
      this.currentReasoningId = null
      return result
    }
    return []
  }

  private messageEnd(message: UnknownRecord | null): OpenLinkAgentEvent[] {
    if (!message || stringValue(message.role) !== 'assistant' || !this.currentAssistantMessageId) return []
    if (stringValue(message.stopReason) === 'error') {
      const messageId = this.currentAssistantMessageId
      this.currentAssistantMessageId = null
      return [this.make({
        type: 'error',
        errorId: `${messageId}:error`,
        message: stringValue(message.errorMessage) || 'The model provider rejected the request',
        recoverable: true,
      })]
    }
    const event = this.make({ type: 'message.completed', messageId: this.currentAssistantMessageId, text: extractContentText(message.content) || undefined })
    this.currentAssistantMessageId = null
    return [event]
  }

  private toolStart(value: UnknownRecord): OpenLinkAgentEvent[] {
    const toolId = stringValue(value.toolCallId) || this.identity('tool')
    const name = stringValue(value.toolName) || 'tool'
    const args = asRecord(value.args)
    const normalized = name.toLowerCase()
    const kind = /bash|shell|terminal|command/.test(normalized) ? 'command' : /edit|write|patch|file/.test(normalized) ? 'file' : 'tool'
    const scope = this.executionScope(value)
    this.toolKinds.set(toolId, kind)
    this.toolArgs.set(toolId, args)
    this.toolScopes.set(toolId, scope)
    if (kind === 'command') {
      return [this.make({ type: 'command.started', commandId: toolId, command: stringValue(args?.command) || name, ...scope })]
    }
    return [this.make({ type: 'tool.started', toolId, name, input: value.args, ...scope })]
  }

  private toolUpdate(value: UnknownRecord): OpenLinkAgentEvent[] {
    const toolId = stringValue(value.toolCallId)
    if (!toolId) return []
    const output = extractContentText(value.partialResult)
    const scope = this.toolScopes.get(toolId) ?? this.executionScope(value)
    if (this.toolKinds.get(toolId) === 'command') {
      return [this.make({ type: 'command.output', commandId: toolId, output, ...scope })]
    }
    return [this.make({ type: 'tool.output', toolId, output, ...scope })]
  }

  private toolEnd(value: UnknownRecord): OpenLinkAgentEvent[] {
    const toolId = stringValue(value.toolCallId)
    if (!toolId) return []
    const output = extractContentText(value.result)
    const isError = value.isError === true
    const kind = this.toolKinds.get(toolId) ?? 'tool'
    const args = this.toolArgs.get(toolId) ?? null
    const scope = this.toolScopes.get(toolId) ?? this.executionScope(value)
    this.toolKinds.delete(toolId)
    this.toolArgs.delete(toolId)
    this.toolScopes.delete(toolId)
    if (kind === 'command') {
      return [this.make({ type: 'command.completed', commandId: toolId, output: output || undefined, exitCode: isError ? 1 : 0, ...scope })]
    }
    const events: OpenLinkAgentEvent[] = [isError
      ? this.make({ type: 'tool.failed', toolId, error: output || 'Tool execution failed', ...scope })
      : this.make({ type: 'tool.completed', toolId, output: output || undefined, ...scope })]
    if (kind === 'file' && !isError) {
      events.push(this.make({ type: 'file.changed', changeId: toolId, label: 'Applied changes', files: filePathFromArgs(args) ? [filePathFromArgs(args)!] : undefined, ...scope }))
    }
    return events
  }

  private extensionRequest(value: UnknownRecord): OpenLinkAgentEvent[] {
    const method = stringValue(value.method)
    const confirmationId = stringValue(value.id) || this.identity('confirmation')
    if (method === 'confirm' || method === 'select' || method === 'input' || method === 'editor') {
      return [this.make({
        type: 'confirmation.requested',
        confirmationId,
        title: stringValue(value.title) || 'Pi needs your input',
        message: stringValue(value.message) || undefined,
        options: Array.isArray(value.options) ? value.options.filter((option): option is string => typeof option === 'string') : undefined,
        inputKind: method,
      })]
    }
    if (method === 'notify') {
      const notifyType = stringValue(value.notifyType)
      if (notifyType === 'error') return [this.make({ type: 'error', errorId: confirmationId, message: stringValue(value.message), recoverable: true })]
      return [this.make({ type: 'status.updated', statusId: confirmationId, label: stringValue(value.message), status: notifyType === 'warning' ? 'active' : 'completed' })]
    }
    return []
  }

  private executionScope(value: UnknownRecord) {
    const explicitTaskId = stringValue(value.taskId) || stringValue(value.task_id)
    const partId = partIdFromFrame(value)
    if (explicitTaskId) {
      this.currentExecutionTaskId = explicitTaskId
      if (partId) this.partTaskIds.set(partId, explicitTaskId)
      this.lastExecutionStartedAt = Date.parse(this.now())
      return { taskId: explicitTaskId, ...(partId ? { partId } : {}) }
    }

    const knownPartTaskId = partId ? this.partTaskIds.get(partId) : undefined
    const startedAt = Date.parse(this.now())
    const withinBurst = this.lastExecutionStartedAt !== null
      && Number.isFinite(startedAt)
      && startedAt >= this.lastExecutionStartedAt
      && startedAt - this.lastExecutionStartedAt <= 5_000
    const taskId = knownPartTaskId
      ?? (withinBurst ? this.currentExecutionTaskId : null)
      ?? `${this.sessionId}:task:${this.taskIndex++}`

    this.currentExecutionTaskId = taskId
    this.lastExecutionStartedAt = startedAt
    if (partId) this.partTaskIds.set(partId, taskId)
    return { taskId, ...(partId ? { partId } : {}) }
  }

  private breakExecutionBurst() {
    this.currentExecutionTaskId = null
    this.lastExecutionStartedAt = null
    this.partTaskIds.clear()
  }

  private identity(prefix: string) {
    return `${this.sessionId}:${prefix}:${this.sequence}`
  }

  private make<T extends Omit<OpenLinkAgentEvent, 'version' | 'id' | 'sequence' | 'sessionId' | 'timestamp' | 'source'>>(value: T) {
    const sequence = this.sequence++
    return {
      ...value,
      version: 1 as const,
      id: `${this.sessionId}:${sequence}`,
      sequence,
      sessionId: this.sessionId,
      timestamp: this.now(),
      source: 'pi' as const,
    } as OpenLinkAgentEvent
  }
}

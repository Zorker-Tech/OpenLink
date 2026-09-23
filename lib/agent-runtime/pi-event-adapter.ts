import type { Translator } from '@/lib/i18n/messages'

import type { OpenLinkAgentEvent } from './events'

type UnknownRecord = Record<string, unknown>
const FILE_EDIT_CONTENT_LIMIT = 192 * 1024
/**
 * Fallback for callers that render without a locale provider (tests, stories,
 * isolated adapters). It mirrors `translate()` from lib/i18n/messages: no
 * catalog lookup, but placeholders still resolve.
 */
const sourceTranslator: Translator = (source, values) => values
  ? source.replace(/\{(\w+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]))
  : source

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

function partIdFromFrame(value: UnknownRecord) {
  for (const key of ['partId', 'part_id', 'messagePartId', 'message_part_id']) {
    if (typeof value[key] === 'string') return value[key] as string
  }
  return undefined
}

function fileOperationForTool(name: string): 'write' | 'edit' | undefined {
  const normalized = name.toLowerCase()
  if (/(^|[-_ ])write($|[-_ ])/.test(normalized)) return 'write'
  if (/(^|[-_ ])edit($|[-_ ])/.test(normalized) || /patch|apply_patch/.test(normalized)) return 'edit'
  return undefined
}

function languageForPath(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  const languages: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'cpp',
    html: 'html',
    java: 'java',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return languages[extension] ?? 'plaintext'
}

function toolCallFromMessage(frame: UnknownRecord, update: UnknownRecord): UnknownRecord | null {
  const message = asRecord(frame.message)
  const content = Array.isArray(message?.content) ? message.content : []
  const contentIndex = typeof update.contentIndex === 'number' ? update.contentIndex : undefined
  const indexed = contentIndex === undefined ? undefined : asRecord(content[contentIndex])
  const candidate = indexed?.type === 'toolCall'
    ? indexed
    : content.map(asRecord).findLast((item) => item?.type === 'toolCall')
  return candidate ?? null
}

function parsePartialArguments(candidate: UnknownRecord | null): UnknownRecord {
  const argumentsValue = asRecord(candidate?.arguments)
  if (argumentsValue) return argumentsValue
  const raw = stringValue(candidate?.partialArgs) || stringValue(candidate?.partialJson)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return asRecord(parsed) ?? {}
  } catch {
    return {}
  }
}

function fileContentFromArgs(args: UnknownRecord, operation: 'write' | 'edit') {
  if (operation === 'write') {
    for (const key of ['content', 'text', 'code', 'source']) {
      if (typeof args[key] === 'string') return (args[key] as string).slice(0, FILE_EDIT_CONTENT_LIMIT)
    }
    return undefined
  }
  const edits = Array.isArray(args.edits) ? args.edits : []
  const replacement = edits.map(asRecord).map((edit) => stringValue(edit?.newText)).filter(Boolean).join('\n\n')
  if (replacement) return replacement.slice(0, FILE_EDIT_CONTENT_LIMIT)
  if (typeof args.newText === 'string') return args.newText.slice(0, FILE_EDIT_CONTENT_LIMIT)
  return undefined
}

export class PiEventAdapter {
  private readonly sessionId: string
  private readonly now: () => string
  private readonly t: Translator
  private sequence: number
  // An adapter is created for every HTTP turn. Keep the turn's reserved event
  // range in generated task ids so `task:0` from a later turn cannot overwrite
  // `task:0` from an earlier turn while the client rebuilds the timeline.
  private readonly taskScope: string
  private currentAssistantMessageId: string | null = null
  private currentReasoningId: string | null = null
  private readonly toolKinds = new Map<string, 'command' | 'file' | 'tool'>()
  private readonly toolArgs = new Map<string, UnknownRecord | null>()
  private readonly toolScopes = new Map<string, { taskId: string; partId?: string }>()
  private readonly fileEditMeta = new Map<string, { path: string; operation: 'write' | 'edit'; language: string; content?: string }>()
  private readonly fileEditScopes = new Map<string, { taskId: string; partId?: string }>()
  /** A Git snapshot is emitted immediately after its raw tool completion. */
  private readonly completedToolScopes = new Map<string, { taskId: string; partId?: string }>()
  private readonly partTaskIds = new Map<string, string>()
  private currentExecutionTaskId: string | null = null
  private lastExecutionStartedAt: number | null = null
  private taskIndex = 0

  constructor(
    sessionId: string,
    now: () => string = () => new Date().toISOString(),
    startSequence = 0,
    t: Translator = sourceTranslator,
  ) {
    this.sessionId = sessionId
    this.now = now
    this.sequence = Math.max(0, startSequence)
    this.taskScope = String(this.sequence)
    this.t = t
  }

  adapt(frame: unknown): OpenLinkAgentEvent[] {
    const value = asRecord(frame)
    const type = stringValue(value?.type)
    if (!value || !type || type === 'response') return []

    switch (type) {
      case 'openlink_user_steer':
        return [this.make({ type: 'message.user', messageId: stringValue(value.messageId), text: stringValue(value.text) })]
      case 'agent_start':
        return [this.make({ type: 'session.started' })]
      case 'agent_settled':
        return [this.make({ type: 'session.completed' })]
      case 'message_start':
        return this.messageStart(asRecord(value.message))
      case 'message_update':
        return this.messageUpdate(asRecord(value.assistantMessageEvent), value)
      case 'message_end':
        return this.messageEnd(asRecord(value.message))
      case 'tool_execution_start':
        return this.toolStart(value)
      case 'tool_execution_update':
        return this.toolUpdate(value)
      case 'tool_execution_end':
        return this.toolEnd(value)
      case 'openlink_file_preview':
        return this.filePreview(value)
      case 'openlink_git_snapshot':
        return this.gitSnapshot(value)
      case 'extension_ui_request':
        return this.extensionRequest(value)
      case 'openlink_confirmation_resolved': {
        const confirmationId = stringValue(value.id)
        if (!confirmationId) return []
        return [this.make({
          type: 'confirmation.resolved',
          confirmationId,
          approved: value.cancelled === true ? false : value.confirmed === true || typeof value.value === 'string',
          ...(typeof value.value === 'string' ? { value: value.value } : {}),
        })]
      }
      case 'extension_error':
        return [this.make({ type: 'error', errorId: this.identity('extension-error'), message: stringValue(value.error) || stringValue(value.message) || 'Pi extension failed', recoverable: value.terminal !== true })]
      case 'auto_retry_start':
        return [this.make({ type: 'status.updated', statusId: this.identity('retry'), label: this.t('正在重试（{attempt}/{maxAttempts}）', { attempt: Number(value.attempt) || 1, maxAttempts: Number(value.maxAttempts) || 3 }), status: 'active', detail: stringValue(value.errorMessage) })]
      case 'compaction_start':
        return [this.make({ type: 'status.updated', statusId: this.identity('compaction'), label: this.t('正在压缩会话上下文'), status: 'active' })]
      case 'compaction_end':
        return [this.make({ type: 'status.updated', statusId: this.identity('compaction'), label: this.t('会话上下文压缩完成'), status: value.errorMessage ? 'failed' : 'completed', detail: stringValue(value.errorMessage) })]
      default:
        return []
    }
  }

  private messageStart(message: UnknownRecord | null): OpenLinkAgentEvent[] {
    if (!message) return []
    const role = stringValue(message.role)
    if (role === 'user') {
      // The HTTP boundary emits and persists the canonical user event before
      // Agent Host is contacted. Pi's echo of the same user entry is native
      // session bookkeeping and must not create a second UI message.
      return []
    }
    if (role === 'assistant') this.currentAssistantMessageId = this.identity('assistant-message')
    return []
  }

  private messageUpdate(update: UnknownRecord | null, frame: UnknownRecord): OpenLinkAgentEvent[] {
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
      // Pi's public stream always follows text_end with the authoritative
      // assistant message_end frame. Completing here as well persisted every
      // assistant bubble twice (once from the streaming part and once from the
      // final message). Keep text_end as an internal part boundary and emit
      // exactly one canonical completion from message_end, which also carries
      // the final stopReason/error state.
      return []
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
    if (updateType === 'toolcall_start' || updateType === 'toolcall_delta' || updateType === 'toolcall_end') {
      return this.fileCallUpdate(frame, update)
    }
    return []
  }

  private fileCallUpdate(frame: UnknownRecord, update: UnknownRecord): OpenLinkAgentEvent[] {
    const candidate = toolCallFromMessage(frame, update)
    const toolId = stringValue(candidate?.id)
    const name = stringValue(candidate?.name)
    const operation = fileOperationForTool(name)
    if (!toolId || !operation) return []

    const args = parsePartialArguments(candidate)
    const path = stringValue(args.path) || stringValue(args.file_path) || this.fileEditMeta.get(toolId)?.path
    if (!path) return []
    const content = fileContentFromArgs(args, operation)
    const meta = {
      path,
      operation,
      language: languageForPath(path),
      ...(content !== undefined ? { content } : this.fileEditMeta.get(toolId)?.content !== undefined ? { content: this.fileEditMeta.get(toolId)?.content } : {}),
    }
    this.fileEditMeta.set(toolId, meta)
    const scope = this.fileEditScopes.get(toolId) ?? this.executionScope({ ...frame, partId: `file:${toolId}` })
    this.fileEditScopes.set(toolId, scope)
    const eventType = this.fileEditMeta.has(`${toolId}:started`) ? 'file.editing.updated' : 'file.editing.started'
    // Keep an explicit marker so a provider that emits multiple start frames
    // does not reset the preview's lifecycle.
    this.fileEditMeta.set(`${toolId}:started`, meta)
    return [this.make({
      type: eventType,
      editId: toolId,
      ...meta,
      ...scope,
    } as never)]
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
    const scope = this.fileEditScopes.get(toolId) ?? this.executionScope(value)
    this.toolKinds.set(toolId, kind)
    this.toolArgs.set(toolId, args)
    this.toolScopes.set(toolId, scope)
    const operation = fileOperationForTool(name)
    if (kind === 'file' && operation) {
      const path = stringValue(args?.path) || stringValue(args?.file_path) || this.fileEditMeta.get(toolId)?.path
      if (!path) return []
      const content = args ? fileContentFromArgs(args, operation) : undefined
      const meta = { path, operation, language: languageForPath(path), ...(content !== undefined ? { content } : {}) }
      this.fileEditMeta.set(toolId, { ...this.fileEditMeta.get(toolId), ...meta })
      const alreadyStarted = this.fileEditMeta.has(`${toolId}:started`)
      this.fileEditMeta.set(`${toolId}:started`, this.fileEditMeta.get(toolId)!)
      return [this.make({ type: alreadyStarted ? 'file.editing.updated' : 'file.editing.started', editId: toolId, ...this.fileEditMeta.get(toolId)!, ...scope } as never)]
    }
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
    const meta = this.fileEditMeta.get(toolId)
    if (this.toolKinds.get(toolId) === 'file' && meta) {
      const preview = asRecord(value.partialResult)
      const content = stringValue(preview?.content) || stringValue(preview?.text) || meta.content
      if (content !== undefined) meta.content = content
      return [this.make({ type: 'file.editing.updated', editId: toolId, ...meta, ...scope })]
    }
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
    const scope = this.toolScopes.get(toolId) ?? this.executionScope(value)
    const meta = this.fileEditMeta.get(toolId)
    this.toolKinds.delete(toolId)
    this.toolArgs.delete(toolId)
    this.toolScopes.delete(toolId)
    this.fileEditScopes.delete(toolId)
    this.completedToolScopes.set(toolId, scope)
    // A snapshot follows only workspace-mutating tools. Keep a bounded
    // fallback scope cache for command tools that do not emit one.
    if (this.completedToolScopes.size > 128) {
      const oldest = this.completedToolScopes.keys().next().value
      if (oldest) this.completedToolScopes.delete(oldest)
    }
    if (kind === 'command') {
      return [this.make({ type: 'command.completed', commandId: toolId, output: output || undefined, exitCode: isError ? 1 : 0, ...scope })]
    }
    if (kind === 'file' && meta) {
      this.fileEditMeta.delete(toolId)
      this.fileEditMeta.delete(`${toolId}:started`)
      return [isError
        ? this.make({ type: 'file.editing.failed', editId: toolId, ...meta, error: output || 'File edit failed', ...scope })
        : this.make({ type: 'file.editing.completed', editId: toolId, ...meta, ...scope })]
    }
    const events: OpenLinkAgentEvent[] = [isError
      ? this.make({ type: 'tool.failed', toolId, error: output || 'Tool execution failed', ...scope })
      : this.make({ type: 'tool.completed', toolId, output: output || undefined, ...scope })]
    return events
  }

  private filePreview(value: UnknownRecord): OpenLinkAgentEvent[] {
    const toolId = stringValue(value.toolCallId)
    const path = stringValue(value.path)
    const content = typeof value.content === 'string' ? value.content.slice(0, FILE_EDIT_CONTENT_LIMIT) : undefined
    if (!toolId || !path || content === undefined) return []
    const operation = fileOperationForTool(stringValue(value.toolName)) ?? this.fileEditMeta.get(toolId)?.operation ?? 'edit'
    const meta = { path, operation, language: stringValue(value.language) || languageForPath(path), content }
    this.fileEditMeta.set(toolId, meta)
    const scope = this.fileEditScopes.get(toolId) ?? this.toolScopes.get(toolId) ?? this.completedToolScopes.get(toolId) ?? this.executionScope(value)
    this.fileEditScopes.set(toolId, scope)
    if (stringValue(value.phase) === 'completed') {
      const event = this.make({ type: 'file.editing.completed', editId: toolId, ...meta, ...scope })
      this.fileEditScopes.delete(toolId)
      this.fileEditMeta.delete(toolId)
      this.fileEditMeta.delete(`${toolId}:started`)
      return [event]
    }
    return [this.make({ type: 'file.editing.updated', editId: toolId, ...meta, ...scope })]
  }

  private gitSnapshot(value: UnknownRecord): OpenLinkAgentEvent[] {
    const toolId = stringValue(value.toolCallId)
    if (!toolId || !Array.isArray(value.files)) return []
    const scope = this.completedToolScopes.get(toolId) ?? this.executionScope(value)
    this.completedToolScopes.delete(toolId)
    const files = value.files.flatMap((candidate) => {
      const file = asRecord(candidate)
      const path = stringValue(file?.path)
      if (!path) return []
      const additions = typeof file?.additions === 'number' && Number.isFinite(file.additions) ? Math.max(0, file.additions) : undefined
      const deletions = typeof file?.deletions === 'number' && Number.isFinite(file.deletions) ? Math.max(0, file.deletions) : undefined
      const patch = stringValue(file?.patch)
      return [{ path, ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}), ...(patch ? { patch } : {}) }]
    })
    const additions = typeof value.additions === 'number' && Number.isFinite(value.additions) ? Math.max(0, value.additions) : 0
    const deletions = typeof value.deletions === 'number' && Number.isFinite(value.deletions) ? Math.max(0, value.deletions) : 0
    return [this.make({
      type: 'file.changed',
      changeId: toolId,
      label: 'Applied changes',
      additions,
      deletions,
      files,
      snapshot: true,
      ...(stringValue(value.baseCommit) ? { baseCommit: stringValue(value.baseCommit) } : {}),
      ...scope,
    })]
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
        confirmationKind: method === 'confirm' ? 'approval' : 'question',
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
      ?? `${this.sessionId}:task:${this.taskScope}:${this.taskIndex++}`

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

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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    return stringValue(asRecord(part)?.text)
  }).filter(Boolean).join('\n')
}

function itemTypeIs(itemType: string, camelCase: string, snakeCase: string): boolean {
  return itemType === camelCase || itemType === snakeCase
}

function languageForPath(path: string): string {
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

/**
 * Maps bidirectional JSON-RPC 2.0 messages from `codex app-server` (protocol v1/v2)
 * into OpenLink's canonical `OpenLinkAgentEvent` sequence.
 */
export class CodexEventAdapter {
  private readonly sessionId: string
  private readonly clock: () => string
  private readonly t: Translator
  private nextSequence: number
  private currentTurnId: string | null = null
  private sessionStarted = false
  private readonly commandItemMap = new Map<string, { command: string; commandId: string }>()
  private readonly reasoningItemMap = new Map<string, string>()
  private readonly fileChangeItemMap = new Map<string, { path: string; operation: 'write' | 'edit' }>()

  constructor(sessionId: string, clock: () => string = () => new Date().toISOString(), startSequence = 0, t: Translator = sourceTranslator) {
    this.sessionId = sessionId
    this.clock = clock
    this.nextSequence = startSequence
    this.t = t
  }

  private make<T extends { type: string }>(event: T): OpenLinkAgentEvent {
    return {
      version: 1,
      id: `${this.sessionId}:${this.nextSequence}`,
      sequence: this.nextSequence++,
      sessionId: this.sessionId,
      timestamp: this.clock(),
      source: 'codex',
      ...event,
    } as unknown as OpenLinkAgentEvent
  }

  adapt(raw: unknown): OpenLinkAgentEvent[] {
    const message = asRecord(raw)
    if (!message) return []
    if (message.type === 'openlink_confirmation_resolved' && typeof message.id === 'string') return [this.make({
      type: 'confirmation.resolved', confirmationId: message.id, approved: message.confirmed === true,
      ...(typeof message.value === 'string' ? { value: message.value } : {}),
    })]
    if (message.type === 'openlink_user_steer') return [this.make({ type: 'message.user', messageId: stringValue(message.messageId), text: stringValue(message.text) })]

    // 1. Check for synthetic / extension events passed through from worker
    if (message.type === 'openlink_git_snapshot' && typeof message.signature === 'string') {
      const gitEvent = message as unknown as { toolCallId: string; baseCommit?: string; files?: unknown[]; additions?: number; deletions?: number }
      return [this.make({
        type: 'file.changed',
        changeId: gitEvent.toolCallId || `${this.sessionId}:git:${Date.now()}`,
        label: 'Git Working Tree Snapshot',
        snapshot: true,
        baseCommit: gitEvent.baseCommit,
        files: (gitEvent.files ?? []) as any[],
        additions: gitEvent.additions,
        deletions: gitEvent.deletions,
      })]
    }

    if (message.type === 'openlink_file_preview' && typeof message.path === 'string') {
      const preview = message as unknown as { editId: string; path: string; operation: 'write' | 'edit'; language?: string; content?: string }
      return [this.make({
        type: 'file.editing.started',
        editId: preview.editId,
        path: preview.path,
        operation: preview.operation,
        language: preview.language,
        content: preview.content,
      })]
    }

    if (message.type === 'extension_error' && typeof message.error === 'string') {
      return [this.make({
        type: 'error',
        errorId: `${this.sessionId}:error:${Date.now()}`,
        message: message.error,
        recoverable: message.terminal !== true,
      })]
    }

    if (message.type === 'extension_ui_request' && typeof message.id === 'string') {
      const inputKind = message.method === 'select' || message.method === 'input' || message.method === 'editor'
        ? message.method
        : 'confirm'
      return [this.make({
        type: 'confirmation.requested',
        confirmationId: message.id,
        title: stringValue(message.title) || this.t('执行确认'),
        message: stringValue(message.message) || undefined,
        options: Array.isArray(message.options) ? message.options.filter((option): option is string => typeof option === 'string') : undefined,
        inputKind,
        confirmationKind: message.requestKind === 'question' || inputKind !== 'confirm' ? 'question' : 'approval',
      })]
    }

    // 2. Handle standard JSON-RPC notifications and methods from codex app-server
    const method = stringValue(message.method)
    const params = asRecord(message.params) ?? {}

    switch (method) {
      case 'thread/tokenUsage/updated': {
        const usage = asRecord(params.tokenUsage)
        const total = asRecord(usage?.total)
        const last = asRecord(usage?.last)
        if (!total) return []
        const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
        return [this.make({
          type: 'usage.updated',
          inputTokens: count(total.inputTokens), outputTokens: count(total.outputTokens),
          totalTokens: count(total.totalTokens), cachedInputTokens: count(total.cachedInputTokens),
          reasoningTokens: count(total.reasoningOutputTokens),
          contextTokens: typeof last?.totalTokens === 'number' ? count(last.totalTokens) : null,
          contextWindow: typeof usage?.modelContextWindow === 'number' && usage.modelContextWindow > 0 ? usage.modelContextWindow : null,
        })]
      }
      case 'thread/started':
        this.sessionStarted = true
        return [this.make({ type: 'session.started' })]

      case 'turn/started': {
        const turn = asRecord(params.turn)
        this.currentTurnId = stringValue(turn?.id) || stringValue(params.turnId) || `${this.sessionId}:turn:${Date.now()}`
        if (!this.sessionStarted) {
          this.sessionStarted = true
          return [this.make({ type: 'session.started' })]
        }
        return []
      }

      case 'turn/completed': {
        const turn = asRecord(params.turn)
        const durationMs = typeof turn?.durationMs === 'number' ? turn.durationMs : undefined
        const turnStatus = stringValue(turn?.status)
        const turnError = asRecord(turn?.error)
        const failed = turnStatus === 'failed' || turnStatus === 'interrupted'
        this.currentTurnId = null
        return [
          ...(failed ? [this.make({
            type: 'error',
            errorId: `${this.sessionId}:error:${Date.now()}`,
            message: stringValue(turnError?.message) || (turnStatus === 'interrupted' ? 'Codex turn was interrupted' : 'Codex turn failed'),
            recoverable: true,
          })] : []),
          this.make({
            type: 'session.completed',
            durationMs,
          }),
        ]
      }

      case 'turn/failed':
      {
        const err = asRecord(params.error)
        const messageText = stringValue(err?.message) || stringValue(params.message) || 'Codex encountered an error'
        this.currentTurnId = null
        return [
          this.make({
            type: 'error',
            errorId: `${this.sessionId}:error:${Date.now()}`,
            message: messageText,
            recoverable: true,
          }),
          this.make({ type: 'session.completed' }),
        ]
      }

      case 'error': {
        const err = asRecord(params.error)
        const messageText = stringValue(err?.message) || stringValue(params.message) || 'Codex encountered an error'
        return [this.make({
          type: 'error',
          errorId: `${this.sessionId}:error:${Date.now()}`,
          message: messageText,
          recoverable: true,
        })]
      }

      // Delta streaming
      case 'item/agentMessage/delta': {
        const itemId = stringValue(params.itemId) || `${this.sessionId}:assistant-msg`
        const delta = stringValue(params.delta)
        if (!delta) return []
        return [this.make({
          type: 'message.delta',
          messageId: itemId,
          delta,
        })]
      }

      case 'item/reasoning/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const itemId = stringValue(params.itemId) || `${this.sessionId}:reasoning`
        const delta = stringValue(params.delta)
        if (!delta) return []
        return [this.make({
          type: 'reasoning.delta',
          reasoningId: itemId,
          delta,
        })]
      }

      case 'item/plan/delta': {
        const itemId = stringValue(params.itemId) || `${this.sessionId}:plan`
        const delta = stringValue(params.delta)
        if (!delta) return []
        return [this.make({
          type: 'reasoning.delta',
          reasoningId: itemId,
          delta,
        })]
      }

      case 'item/commandExecution/outputDelta': {
        const itemId = stringValue(params.itemId)
        const delta = stringValue(params.delta)
        if (!delta) return []
        return [this.make({
          type: 'command.output',
          commandId: itemId,
          output: delta,
        })]
      }

      // Item started
      case 'item/started': {
        const item = asRecord(params.item)
        if (!item) return []
        const itemType = stringValue(item.type)
        const itemId = stringValue(item.id) || `${this.sessionId}:item:${Date.now()}`

        if (itemType === 'reasoning' || itemType === 'plan') {
          this.reasoningItemMap.set(itemId, '')
          return [this.make({
            type: 'reasoning.started',
            reasoningId: itemId,
          })]
        }

        if (itemTypeIs(itemType, 'commandExecution', 'command_execution')) {
          const command = stringValue(item.command)
          this.commandItemMap.set(itemId, { command, commandId: itemId })
          return [this.make({
            type: 'command.started',
            commandId: itemId,
            command,
          })]
        }

        if (itemTypeIs(itemType, 'fileChange', 'file_change')) {
          const changes = Array.isArray(item.changes) ? item.changes : []
          const first = asRecord(changes[0])
          const path = stringValue(first?.path) || 'file'
          const operation = first?.kind === 'add' ? 'write' : 'edit'
          this.fileChangeItemMap.set(itemId, { path, operation })
          return [this.make({
            type: 'file.editing.started',
            editId: itemId,
            path,
            operation,
            language: languageForPath(path),
          })]
        }

        if (itemTypeIs(itemType, 'mcpToolCall', 'mcp_tool_call')) {
          const tool = stringValue(item.tool)
          const server = stringValue(item.server)
          return [this.make({
            type: 'tool.started',
            toolId: itemId,
            name: `${server}/${tool}`,
            input: item.arguments,
          })]
        }

        return []
      }

      // Item completed
      case 'item/completed': {
        const item = asRecord(params.item)
        if (!item) return []
        const itemType = stringValue(item.type)
        const itemId = stringValue(item.id) || `${this.sessionId}:item:${Date.now()}`

        if (itemTypeIs(itemType, 'agentMessage', 'agent_message')) {
          const text = stringValue(item.text)
          return [this.make({
            type: 'message.completed',
            messageId: itemId,
            text: text || undefined,
          })]
        }

        if (itemType === 'reasoning' || itemType === 'plan') {
          const text = stringValue(item.text) || [textValue(item.summary), textValue(item.content)].filter(Boolean).join('\n')
          this.reasoningItemMap.delete(itemId)
          return [this.make({
            type: 'reasoning.completed',
            reasoningId: itemId,
            text: text || undefined,
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
          })]
        }

        if (itemTypeIs(itemType, 'commandExecution', 'command_execution')) {
          const output = stringValue(item.aggregatedOutput) || stringValue(item.aggregated_output)
          const exitCode = typeof item.exitCode === 'number' ? item.exitCode : (typeof item.exit_code === 'number' ? item.exit_code : 0)
          this.commandItemMap.delete(itemId)
          return [this.make({
            type: 'command.completed',
            commandId: itemId,
            output: output || undefined,
            exitCode,
          })]
        }

        if (itemTypeIs(itemType, 'fileChange', 'file_change')) {
          const meta = this.fileChangeItemMap.get(itemId)
          const path = meta?.path || 'file'
          const operation = meta?.operation || 'edit'
          this.fileChangeItemMap.delete(itemId)
          const status = stringValue(item.status)
          if (status === 'failed') {
            return [this.make({
              type: 'file.editing.failed',
              editId: itemId,
              path,
              operation,
              error: 'Patch application failed',
            })]
          }
          return [this.make({
            type: 'file.editing.completed',
            editId: itemId,
            path,
            operation,
            language: languageForPath(path),
          })]
        }

        if (itemTypeIs(itemType, 'mcpToolCall', 'mcp_tool_call')) {
          const status = stringValue(item.status)
          if (status === 'failed') {
            const err = asRecord(item.error)
            return [this.make({
              type: 'tool.failed',
              toolId: itemId,
              error: stringValue(err?.message) || 'MCP tool execution failed',
            })]
          }
          const result = asRecord(item.result)
          return [this.make({
            type: 'tool.completed',
            toolId: itemId,
            output: result ? JSON.stringify(result) : undefined,
          })]
        }

        return []
      }

      // User Approval request from codex app-server
      case 'execCommandApproval':
      case 'applyPatchApproval':
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/execApproval/request': {
        const id = stringValue(params.approvalId) || stringValue(params.callId) || stringValue(params.itemId) || `${this.sessionId}:approval:${Date.now()}`
        const reason = stringValue(params.reason) || 'Codex requests user approval to execute operation'
        const command = Array.isArray(params.command) ? params.command.join(' ') : stringValue(params.command)
        return [this.make({
          type: 'confirmation.requested',
          confirmationId: id,
          title: this.t('执行确认'),
          message: command ? this.t('执行命令：{command}', { command }) : reason,
          inputKind: 'confirm',
          confirmationKind: 'approval',
        })]
      }

      default:
        return []
    }
  }
}

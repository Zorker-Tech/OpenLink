import type { OpenLinkAgentEvent } from './events'

type UnknownRecord = Record<string, unknown>
const FILE_EDIT_CONTENT_LIMIT = 192 * 1024

const asRecord = (value: unknown): UnknownRecord | null => value && typeof value === 'object' ? value as UnknownRecord : null

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
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
  private nextSequence: number
  private currentTurnId: string | null = null
  private readonly commandItemMap = new Map<string, { command: string; commandId: string }>()
  private readonly reasoningItemMap = new Map<string, string>()
  private readonly fileChangeItemMap = new Map<string, { path: string; operation: 'write' | 'edit' }>()

  constructor(
    private readonly sessionId: string,
    private readonly clock: () => string = () => new Date().toISOString(),
    startSequence = 0,
  ) {
    this.nextSequence = startSequence
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
        recoverable: true,
      })]
    }

    // 2. Handle standard JSON-RPC notifications and methods from codex app-server
    const method = stringValue(message.method)
    const params = asRecord(message.params) ?? {}

    switch (method) {
      case 'thread/started':
        return [this.make({ type: 'session.started' })]

      case 'turn/started': {
        const turn = asRecord(params.turn)
        this.currentTurnId = stringValue(turn?.id) || stringValue(params.turnId) || `${this.sessionId}:turn:${Date.now()}`
        return [this.make({
          type: 'status.updated',
          statusId: `${this.sessionId}:status:${Date.now()}`,
          label: 'Working',
          status: 'active',
        })]
      }

      case 'turn/completed': {
        const turn = asRecord(params.turn)
        const durationMs = typeof turn?.durationMs === 'number' ? turn.durationMs : undefined
        this.currentTurnId = null
        return [
          this.make({
            type: 'status.updated',
            statusId: `${this.sessionId}:status:${Date.now()}`,
            label: 'Worked',
            status: 'completed',
          }),
          this.make({
            type: 'session.completed',
            durationMs,
          }),
        ]
      }

      case 'turn/failed':
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

        if (itemType === 'command_execution') {
          const command = stringValue(item.command)
          this.commandItemMap.set(itemId, { command, commandId: itemId })
          return [this.make({
            type: 'command.started',
            commandId: itemId,
            command,
          })]
        }

        if (itemType === 'file_change') {
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

        if (itemType === 'mcp_tool_call') {
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

        if (itemType === 'agent_message') {
          const text = stringValue(item.text)
          return [this.make({
            type: 'message.completed',
            messageId: itemId,
            text: text || undefined,
          })]
        }

        if (itemType === 'reasoning' || itemType === 'plan') {
          const text = stringValue(item.text)
          this.reasoningItemMap.delete(itemId)
          return [this.make({
            type: 'reasoning.completed',
            reasoningId: itemId,
            text: text || undefined,
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
          })]
        }

        if (itemType === 'command_execution') {
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

        if (itemType === 'file_change') {
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

        if (itemType === 'mcp_tool_call') {
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
      case 'item/execApproval/request': {
        const id = stringValue(params.approvalId) || stringValue(params.callId) || `${this.sessionId}:approval:${Date.now()}`
        const reason = stringValue(params.reason) || 'Codex requests user approval to execute operation'
        const command = Array.isArray(params.command) ? params.command.join(' ') : stringValue(params.command)
        return [this.make({
          type: 'confirmation.requested',
          confirmationId: id,
          title: '执行确认',
          message: command ? `执行命令：${command}` : reason,
          inputKind: 'confirm',
        })]
      }

      default:
        return []
    }
  }
}

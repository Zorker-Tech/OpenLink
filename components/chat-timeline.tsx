'use client'

import {
  Conversation,
  ConversationContent,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task'
import { ChatCodePreview } from '@/components/chat-code-preview'
import { ThinkingOrb, type OrbState } from '@/components/thinking/src'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { AgentFileChange, OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import {
  Atom,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  Link2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { AiBrain02Icon, BadgeCheckIcon, BookOpen01Icon, Edit01Icon, SquareTerminalIcon } from '@hugeicons/core-free-icons'
import type { ReactNode } from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'

type ExecutionState = 'pending' | 'active' | 'completed' | 'failed'

interface TaskExecution {
  id: string
  kind: 'command' | 'file' | 'tool'
  label: string
  input?: unknown
  output?: string
  error?: string
  path?: string
  language?: string
  content?: string
  operation?: 'write' | 'edit'
  editState?: 'editing' | 'edited' | 'failed'
  state: ExecutionState
}

type TimelineItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'reasoning'; text: string; streaming: boolean; durationMs?: number }
  | { id: string; kind: 'task'; label: string; detail?: string; state: ExecutionState; executions: TaskExecution[] }
  | { id: string; kind: 'status'; label: string; detail?: string; state: 'active' | 'completed' | 'failed' }
  | { id: string; kind: 'change'; label: string; additions?: number; deletions?: number; files?: Array<string | AgentFileChange>; changeCount?: number; snapshot?: boolean; baseCommit?: string }
  | { id: string; kind: 'confirmation'; title: string; message?: string; options?: string[]; resolved?: boolean; approved?: boolean }
  | { id: string; kind: 'checkpoint'; label: string; timestamp: string; metrics?: { actions?: number; credits?: number; model?: string } }
  | { id: string; kind: 'error'; message: string }

type MessageTimelineItem = Extract<TimelineItem, { kind: 'message' }>
type ChangeTimelineItem = Extract<TimelineItem, { kind: 'change' }>

interface TimelineState {
  items: TimelineItem[]
  status: 'idle' | 'running' | 'settled' | 'error'
  source: 'pi' | 'codex' | 'demo'
  /** The canonical user message is the durable boundary of an agent turn. */
  activeRoundId?: string
  activeExecutionTaskId?: string
  lastExecutionStartedAt?: number
  partTaskIds: Record<string, string>
}

interface ConversationRound {
  id: string
  state: 'working' | 'worked'
  user?: MessageTimelineItem
  thinkingItems: TimelineItem[]
  workingItems: TimelineItem[]
  outputItems: MessageTimelineItem[]
  ending?: MessageTimelineItem
  endingChange?: ChangeTimelineItem
  checkpoint?: Extract<TimelineItem, { kind: 'checkpoint' }>
}

function replaceItem(items: TimelineItem[], id: string, update: (item: TimelineItem | undefined) => TimelineItem) {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return [...items, update(undefined)]
  const next = items.slice()
  next[index] = update(next[index])
  return next
}

function taskState(executions: TaskExecution[], fallback: ExecutionState): ExecutionState {
  if (executions.some((execution) => execution.state === 'active')) return 'active'
  if (executions.some((execution) => execution.state === 'failed')) return 'failed'
  if (executions.length > 0 && executions.every((execution) => execution.state === 'completed')) return 'completed'
  if (executions.some((execution) => execution.state === 'pending')) return 'pending'
  return fallback
}

function humanizeToolName(name: string) {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function fallbackTaskLabel(execution: TaskExecution) {
  if (execution.kind === 'command') return 'Run command'
  const name = execution.label.toLowerCase()
  if (/read|open/.test(name)) return 'Read files'
  if (/search|find|grep/.test(name)) return 'Search project'
  if (/edit|write|patch/.test(name)) return 'Update files'
  if (/fetch|web|http|browser/.test(name)) return 'Fetch resources'
  return humanizeToolName(execution.label)
}

function taskIdForRound(state: TimelineState, taskId: string) {
  // Older persisted events used a per-request `session:task:0` id. Since the
  // adapter was recreated for every request, that id recurred in each round
  // and collapsed every subsequent task into the first visible Working group.
  // Scope task ids locally by the preceding user message to keep legacy
  // histories correct as well as new streams.
  return state.activeRoundId ? `${state.activeRoundId}:task:${taskId}` : taskId
}

function resolveStartedTaskId(
  state: TimelineState,
  event: { sessionId: string; sequence: number; timestamp: string; taskId?: string; partId?: string },
) {
  if (event.taskId) {
    const taskId = taskIdForRound(state, event.taskId)
    state.activeExecutionTaskId = taskId
    state.lastExecutionStartedAt = Date.parse(event.timestamp)
    if (event.partId) state.partTaskIds[event.partId] = taskId
    return taskId
  }
  if (event.partId && state.partTaskIds[event.partId]) return state.partTaskIds[event.partId]

  const startedAt = Date.parse(event.timestamp)
  const withinBurst = state.activeExecutionTaskId
    && state.lastExecutionStartedAt !== undefined
    && Number.isFinite(startedAt)
    && startedAt >= state.lastExecutionStartedAt
    && startedAt - state.lastExecutionStartedAt <= 5_000
  const taskId = withinBurst
    ? state.activeExecutionTaskId!
    : `${event.sessionId}:auto-task:${event.sequence}`

  state.activeExecutionTaskId = taskId
  state.lastExecutionStartedAt = startedAt
  if (event.partId) state.partTaskIds[event.partId] = taskId
  return taskId
}

function findExecutionTaskId(items: TimelineItem[], executionId: string) {
  return items.find((item) => item.kind === 'task' && item.executions.some((execution) => execution.id === executionId))?.id
}

function upsertTaskExecution(
  state: TimelineState,
  taskId: string,
  execution: TaskExecution,
  fallbackLabel = fallbackTaskLabel(execution),
) {
  state.items = replaceItem(state.items, taskId, (current) => {
    const task = current?.kind === 'task'
      ? current
      : { id: taskId, kind: 'task' as const, label: fallbackLabel, state: execution.state, executions: [] }
    const index = task.executions.findIndex((item) => item.id === execution.id)
    const executions = task.executions.slice()
    if (index < 0) executions.push(execution)
    else executions[index] = { ...executions[index], ...execution }
    return { ...task, state: taskState(executions, task.state), executions }
  })
}

function updateTaskExecution(
  state: TimelineState,
  executionId: string,
  scope: { taskId?: string },
  update: (current: TaskExecution | undefined) => TaskExecution,
) {
  const taskId = scope.taskId
    ? taskIdForRound(state, scope.taskId)
    : findExecutionTaskId(state.items, executionId)
  if (!taskId) return
  state.items = replaceItem(state.items, taskId, (current) => {
    const task = current?.kind === 'task'
      ? current
      : { id: taskId, kind: 'task' as const, label: 'Agent task', state: 'active' as const, executions: [] }
    const index = task.executions.findIndex((execution) => execution.id === executionId)
    const existing = index >= 0 ? task.executions[index] : undefined
    const nextExecution = update(existing)
    const executions = task.executions.slice()
    if (index < 0) executions.push(nextExecution)
    else executions[index] = nextExecution
    return { ...task, state: taskState(executions, task.state), executions }
  })
}

function buildTimeline(events: OpenLinkAgentEvent[]): TimelineState {
  return events.reduce<TimelineState>((state, event) => {
    state.source = event.source
    switch (event.type) {
      case 'session.started':
        state.status = 'running'
        break
      case 'session.completed':
        state.status = 'settled'
        break
      case 'message.user':
        // A user message begins a new durable turn. Reset transient grouping
        // state before processing following tool frames, including when this
        // is a historical replay after reopening a session.
        state.activeRoundId = event.messageId
        state.activeExecutionTaskId = undefined
        state.lastExecutionStartedAt = undefined
        state.partTaskIds = {}
        state.items = replaceItem(state.items, event.messageId, () => ({ id: event.messageId, kind: 'message', role: 'user', text: event.text, streaming: false }))
        break
      case 'message.delta':
        if (!state.items.some((item) => item.kind === 'message' && item.id === event.messageId)) {
          state.activeExecutionTaskId = undefined
          state.lastExecutionStartedAt = undefined
          state.partTaskIds = {}
        }
        state.items = replaceItem(state.items, event.messageId, (current) => ({
          id: event.messageId,
          kind: 'message',
          role: 'assistant',
          text: current?.kind === 'message' ? current.text + event.delta : event.delta,
          streaming: true,
        }))
        break
      case 'message.completed':
        state.items = replaceItem(state.items, event.messageId, (current) => ({
          id: event.messageId,
          kind: 'message',
          role: 'assistant',
          text: event.text ?? (current?.kind === 'message' ? current.text : ''),
          streaming: false,
        }))
        break
      case 'reasoning.started':
        state.items = replaceItem(state.items, event.reasoningId, () => ({ id: event.reasoningId, kind: 'reasoning', text: '', streaming: true }))
        break
      case 'reasoning.delta':
        state.items = replaceItem(state.items, event.reasoningId, (current) => ({
          id: event.reasoningId,
          kind: 'reasoning',
          text: current?.kind === 'reasoning' ? current.text + event.delta : event.delta,
          streaming: true,
        }))
        break
      case 'reasoning.completed':
        state.items = replaceItem(state.items, event.reasoningId, (current) => ({
          id: event.reasoningId,
          kind: 'reasoning',
          text: event.text ?? (current?.kind === 'reasoning' ? current.text : ''),
          streaming: false,
          durationMs: event.durationMs,
        }))
        break
      case 'command.started': {
        const taskId = resolveStartedTaskId(state, event)
        upsertTaskExecution(state, taskId, { id: event.commandId, kind: 'command', label: 'Run', input: { command: event.command }, state: 'active' })
        break
      }
      case 'command.output':
        updateTaskExecution(state, event.commandId, event, (current) => ({ id: event.commandId, kind: 'command', label: current?.label ?? 'Run', input: current?.input, output: event.output, state: 'active' }))
        break
      case 'command.completed':
        updateTaskExecution(state, event.commandId, event, (current) => ({ id: event.commandId, kind: 'command', label: current?.label ?? 'Run', input: current?.input, output: event.output ?? current?.output, state: event.exitCode && event.exitCode !== 0 ? 'failed' : 'completed' }))
        break
      case 'file.editing.started': {
        const taskId = resolveStartedTaskId(state, event)
        upsertTaskExecution(state, taskId, {
          id: event.editId,
          kind: 'file',
          label: event.operation,
          input: { path: event.path },
          path: event.path,
          language: event.language,
          content: event.content,
          operation: event.operation,
          editState: 'editing',
          state: 'active',
        })
        break
      }
      case 'file.editing.updated':
        updateTaskExecution(state, event.editId, event, (current) => ({
          id: event.editId,
          kind: 'file',
          label: current?.label ?? event.operation,
          input: current?.input ?? { path: event.path },
          path: event.path,
          language: event.language ?? current?.language,
          content: event.content ?? current?.content,
          operation: event.operation,
          editState: 'editing',
          state: 'active',
        }))
        break
      case 'file.editing.completed':
        updateTaskExecution(state, event.editId, event, (current) => ({
          id: event.editId,
          kind: 'file',
          label: current?.label ?? event.operation,
          input: current?.input ?? { path: event.path },
          path: event.path,
          language: event.language ?? current?.language,
          content: event.content ?? current?.content,
          operation: event.operation,
          editState: 'edited',
          state: 'completed',
        }))
        break
      case 'file.editing.failed':
        updateTaskExecution(state, event.editId, event, (current) => ({
          id: event.editId,
          kind: 'file',
          label: current?.label ?? event.operation,
          input: current?.input ?? { path: event.path },
          path: event.path,
          language: event.language ?? current?.language,
          content: event.content ?? current?.content,
          operation: event.operation,
          editState: 'failed',
          state: 'failed',
          error: event.error,
        }))
        break
      case 'tool.started': {
        const taskId = resolveStartedTaskId(state, event)
        upsertTaskExecution(state, taskId, { id: event.toolId, kind: 'tool', label: event.name, input: event.input, state: 'active' })
        break
      }
      case 'tool.output':
        updateTaskExecution(state, event.toolId, event, (current) => ({ id: event.toolId, kind: 'tool', label: current?.label ?? 'Tool', input: current?.input, output: event.output, state: 'active' }))
        break
      case 'tool.completed':
      case 'tool.failed':
        updateTaskExecution(state, event.toolId, event, (current) => ({
          id: event.toolId,
          kind: 'tool',
          label: current?.label ?? 'Tool',
          input: current?.input,
          output: event.type === 'tool.completed' ? event.output ?? current?.output : current?.output,
          error: event.type === 'tool.failed' ? event.error : undefined,
          state: event.type === 'tool.failed' ? 'failed' : 'completed',
        }))
        break
      case 'file.changed':
        state.items = replaceItem(state.items, event.changeId, () => ({ id: event.changeId, kind: 'change', label: event.label, additions: event.additions, deletions: event.deletions, files: event.files, snapshot: event.snapshot, baseCommit: event.baseCommit }))
        break
      case 'task.updated':
        {
          const taskId = taskIdForRound(state, event.taskId)
          state.items = replaceItem(state.items, taskId, (current) => {
            const executions = current?.kind === 'task' ? current.executions : []
            return { id: taskId, kind: 'task', label: event.label, detail: event.detail, state: taskState(executions, event.status), executions }
          })
          state.activeExecutionTaskId = taskId
          state.lastExecutionStartedAt = Date.parse(event.timestamp)
        }
        break
      case 'status.updated':
        state.items = replaceItem(state.items, event.statusId, () => ({ id: event.statusId, kind: 'status', label: event.label, detail: event.detail, state: event.status }))
        break
      case 'confirmation.requested':
        state.items = replaceItem(state.items, event.confirmationId, () => ({ id: event.confirmationId, kind: 'confirmation', title: event.title, message: event.message, options: event.options }))
        break
      case 'confirmation.resolved':
        state.items = replaceItem(state.items, event.confirmationId, (current) => ({ id: event.confirmationId, kind: 'confirmation', title: current?.kind === 'confirmation' ? current.title : 'Confirmation', message: current?.kind === 'confirmation' ? current.message : undefined, options: current?.kind === 'confirmation' ? current.options : undefined, resolved: true, approved: event.approved }))
        break
      case 'checkpoint.created':
        state.items = replaceItem(state.items, event.checkpointId, () => ({ id: event.checkpointId, kind: 'checkpoint', label: event.label, timestamp: event.timestamp, metrics: event.metrics }))
        break
      case 'error':
        state.status = 'error'
        state.items = replaceItem(state.items, event.errorId, () => ({ id: event.errorId, kind: 'error', message: event.message }))
        break
    }
    return state
  }, { items: [], status: 'idle', source: 'demo', partTaskIds: {} })
}

function buildConversationRounds(timeline: TimelineState): ConversationRound[] {
  const groups: Array<{ id: string; user?: MessageTimelineItem; items: TimelineItem[] }> = []

  for (const item of timeline.items) {
    if (item.kind === 'message' && item.role === 'user') {
      groups.push({ id: item.id, user: item, items: [] })
      continue
    }
    const current = groups.at(-1)
    if (current) current.items.push(item)
    else groups.push({ id: `round-${groups.length}`, items: [item] })
  }

  return groups.map((group, index) => {
    const isLast = index === groups.length - 1
    const state = isLast && timeline.status === 'running' ? 'working' : 'worked'
    const checkpoint = [...group.items].reverse().find((item): item is Extract<TimelineItem, { kind: 'checkpoint' }> => item.kind === 'checkpoint')
    const assistantMessages = group.items.filter((item): item is MessageTimelineItem => item.kind === 'message' && item.role === 'assistant')
    const changes = group.items.filter((item): item is ChangeTimelineItem => item.kind === 'change')
    const ending = state === 'worked' ? assistantMessages.at(-1) : undefined
    const endingChange = state === 'worked' && changes.length ? mergeRoundChanges(group.id, changes) : undefined
    const nonMessageItems = group.items.filter((item) => (
      item !== checkpoint
      && item.kind !== 'change'
      && item.kind !== 'message'
      // task.updated can arrive before its first actual tool call. It is
      // bookkeeping, not a visible Working group by itself.
      && (item.kind !== 'task' || item.executions.length > 0)
    ))
    const hasToolExecution = group.items.some((item) => item.kind === 'task' && item.executions.length > 0)
    // Working is a chronological stream, not a tool-only bucket.  An agent
    // often explains what it will inspect immediately before calling a tool;
    // retain that assistant part directly above its Task instead of moving all
    // prose below the collapsed Working group.
    const workingItems = hasToolExecution
      ? group.items.filter((item) => (
          item !== checkpoint
          && item.kind !== 'change'
          && item !== ending
          && (item.kind !== 'task' || item.executions.length > 0)
        ))
      : []
    const thinkingItems = hasToolExecution ? [] : nonMessageItems
    const outputItems = hasToolExecution ? [] : assistantMessages.filter((item) => item !== ending)

    return { id: group.id, state, user: group.user, thinkingItems, workingItems, outputItems, ending, endingChange, checkpoint }
  })
}

function mergeRoundChanges(roundId: string, entries: ChangeTimelineItem[]): ChangeTimelineItem | undefined {
  // A Git snapshot represents the whole working tree at a precise point in
  // time. Do not sum snapshots from individual tool calls: doing so inflated
  // additions/deletions every time an agent made a second edit in one turn.
  const latestSnapshot = [...entries].reverse().find((entry) => entry.snapshot)
  if (latestSnapshot) {
    if (!latestSnapshot.files?.length) return undefined
    return {
      ...latestSnapshot,
      id: `${roundId}:ending-changes`,
      changeCount: latestSnapshot.files.length,
    }
  }
  const hasAdditions = entries.some((change) => change.additions !== undefined)
  const hasDeletions = entries.some((change) => change.deletions !== undefined)
  const files = new Map<string, AgentFileChange>()

  for (const change of entries) {
    for (const file of change.files ?? []) {
      const normalized = typeof file === 'string' ? { path: file } : file
      const current = files.get(normalized.path)
      files.set(normalized.path, {
        path: normalized.path,
        additions: current?.additions === undefined && normalized.additions === undefined ? undefined : (current?.additions ?? 0) + (normalized.additions ?? 0),
        deletions: current?.deletions === undefined && normalized.deletions === undefined ? undefined : (current?.deletions ?? 0) + (normalized.deletions ?? 0),
      })
    }
  }

  return {
    id: `${roundId}:ending-changes`,
    kind: 'change',
    label: 'Applied changes',
    additions: hasAdditions ? entries.reduce((total, change) => total + (change.additions ?? 0), 0) : undefined,
    deletions: hasDeletions ? entries.reduce((total, change) => total + (change.deletions ?? 0), 0) : undefined,
    files: files.size ? [...files.values()] : undefined,
    changeCount: entries.length,
  }
}

function toolActionLabel(execution: TaskExecution) {
  if (execution.kind === 'command') return 'Run'
  if (execution.kind === 'file') {
    if (execution.editState === 'editing' || execution.state === 'active') return '正在编辑'
    if (execution.editState === 'failed' || execution.state === 'failed') return '编辑失败'
    return 'Edited'
  }
  const name = execution.label.toLowerCase()
  if (/read|open/.test(name)) return 'Read'
  if (/search|find|grep/.test(name)) return 'Search'
  if (/edit|write|patch/.test(name)) return 'Edit'
  if (/fetch|web|http|browser/.test(name)) return 'Fetch'
  return humanizeToolName(execution.label)
}

function executionOrbState(execution: TaskExecution): OrbState {
  const name = execution.label.toLowerCase()
  if (/read|open|search|find|grep/.test(name)) return 'searching'
  if (/fetch|web|http|browser|connect/.test(name)) return 'connecting'
  if (/edit|write|patch|file/.test(name)) return 'shaping'
  if (/compose|generate/.test(name)) return 'composing'
  return 'working'
}

type ExecutionAction = 'browser' | 'command' | 'edit' | 'read' | 'search' | 'fetch' | 'other'

function executionAction(execution: TaskExecution): ExecutionAction {
  if (execution.kind === 'command') return 'command'
  const name = execution.label.toLowerCase()
  if (/browser|playwright|navigate|screenshot/.test(name)) return 'browser'
  if (/read|open/.test(name)) return 'read'
  if (/search|find|grep/.test(name)) return 'search'
  if (/edit|write|patch|file/.test(name)) return 'edit'
  if (/fetch|web|http/.test(name)) return 'fetch'
  return 'other'
}

function dynamicTaskLabel(executions: TaskExecution[], active: boolean) {
  if (!executions.length) return active ? 'Working' : 'Worked'
  const actions = new Map<ExecutionAction, number>()
  for (const execution of executions) {
    const action = executionAction(execution)
    actions.set(action, (actions.get(action) ?? 0) + 1)
  }

  return [...actions].map(([action, count]) => {
    if (action === 'browser') return active ? 'Using the browser' : 'Used the browser'
    if (action === 'command') return active ? `Running ${count === 1 ? 'a command' : 'commands'}` : `Ran ${count === 1 ? 'a command' : 'commands'}`
    if (action === 'edit') return active ? `正在编辑 ${count === 1 ? '文件' : `${count} 个文件`}` : `Edited ${count === 1 ? 'a file' : 'files'}`
    if (action === 'read') return active ? `Reading ${count === 1 ? 'a file' : 'files'}` : `Read ${count === 1 ? 'a file' : 'files'}`
    if (action === 'search') return active ? 'Searching the project' : 'Searched the project'
    if (action === 'fetch') return active ? `Fetching ${count === 1 ? 'a resource' : 'resources'}` : `Fetched ${count === 1 ? 'a resource' : 'resources'}`
    return active ? `Using ${count === 1 ? 'a tool' : 'tools'}` : `Used ${count === 1 ? 'a tool' : 'tools'}`
  }).join(', ')
}

function latestFlowForItems(items: TimelineItem[]): ActiveFlowStatus {
  for (const item of [...items].reverse()) {
    if (item.kind === 'task' && item.executions.length) {
      const execution = item.executions.findLast((candidate) => candidate.state === 'active') ?? item.executions.at(-1)!
      return { label: dynamicTaskLabel(item.executions, item.state === 'active'), state: executionOrbState(execution) }
    }
  }
  for (const item of [...items].reverse()) {
    if (item.kind === 'message') return { label: item.streaming ? '正在生成回复' : '生成回复', state: 'composing' }
    if (item.kind === 'reasoning') return { label: item.streaming ? '正在思考' : '完成思考', state: 'solving' }
    if (item.kind === 'status') return { label: item.label, state: 'working' }
    if (item.kind === 'change') return { label: item.label, state: 'shaping' }
  }
  return IDLE_FLOW_STATUS
}

export interface ActiveFlowStatus {
  label: string
  state: OrbState
}

const IDLE_FLOW_STATUS: ActiveFlowStatus = { label: 'Solving', state: 'solving' }
const CAPSULE_ORB_SIZE = 30
const TASK_POSITION_TOLERANCE = 8

function getActiveFlowStatus(timeline: TimelineState): ActiveFlowStatus | null {
  if (timeline.status !== 'running') return null

  for (const item of [...timeline.items].reverse()) {
    if (item.kind === 'message' && item.streaming) return { label: '正在生成回复', state: 'composing' }
    if (item.kind === 'reasoning' && item.streaming) return { label: '正在思考', state: 'solving' }
    if (item.kind === 'status' && item.state === 'active') return { label: item.label, state: 'working' }
    if (item.kind === 'task' && item.state === 'active') {
      const execution = [...item.executions].reverse().find((candidate) => candidate.state === 'active')
      return {
        label: execution ? `${toolActionLabel(execution)} · ${item.label}` : item.label,
        state: execution ? executionOrbState(execution) : 'working',
      }
    }
  }

  const latest = latestFlowForItems(timeline.items)
  return latest === IDLE_FLOW_STATUS ? { label: '正在思考', state: 'solving' } : latest
}

function TaskPositionCapsule({ activeFlow }: { activeFlow: ActiveFlowStatus | null }) {
  const { contentRef, escapedFromLock, scrollRef, scrollToBottom } = useStickToBottomContext()
  const capsuleFlow = activeFlow ?? IDLE_FLOW_STATUS
  const [awayFromTaskPosition, setAwayFromTaskPosition] = useState(false)

  useEffect(() => {
    const scrollElement = scrollRef.current
    const contentElement = contentRef.current
    if (!scrollElement || !contentElement) return

    const updatePosition = () => {
      const distanceFromTask = scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop
      setAwayFromTaskPosition(distanceFromTask > TASK_POSITION_TOLERANCE)
    }

    updatePosition()
    scrollElement.addEventListener('scroll', updatePosition, { passive: true })
    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(contentElement)

    return () => {
      scrollElement.removeEventListener('scroll', updatePosition)
      resizeObserver.disconnect()
    }
  }, [contentRef, scrollRef])

  if (!awayFromTaskPosition || !escapedFromLock) return null

  return (
    <button
      aria-label={activeFlow ? '返回正在工作的位置' : '返回任务位置'}
      className="absolute bottom-3 left-1/2 z-30 flex h-10 max-w-[calc(100%_-_24px)] -translate-x-1/2 items-center gap-1.5 overflow-hidden rounded-full border border-[var(--app-status-glass-border)] bg-[var(--app-status-glass)] py-1 pl-1.5 pr-3 text-left text-[var(--app-status-glass-foreground)] shadow-[inset_0_0_50px_rgb(255_255_255_/_1%),0_16px_48px_var(--app-shadow)] backdrop-blur-xl transition-transform active:scale-[0.98]"
      onClick={() => scrollToBottom()}
      type="button"
    >
      <ThinkingOrb aria-label={capsuleFlow.label} className="shrink-0" size={CAPSULE_ORB_SIZE} speed={activeFlow ? 1 : 0.5} state={capsuleFlow.state} />
      <span className="min-w-0 max-w-[160px] truncate text-[12px] font-normal leading-[14px]">{activeFlow?.label ?? '空闲中'}</span>
    </button>
  )
}

function executionInput(execution: TaskExecution) {
  const input = execution.input && typeof execution.input === 'object'
    ? execution.input as Record<string, unknown>
    : {}
  const toolName = execution.label.toLowerCase()
  const primaryKeys = execution.kind === 'file' && execution.path
    ? []
    : execution.kind === 'command'
    ? ['command']
    : /search|find|grep/.test(toolName)
      ? ['query', 'path', 'target']
      : /fetch|web|http|browser/.test(toolName)
        ? ['url', 'query', 'target']
        : ['path', 'filePath', 'file_path', 'target', 'query', 'url', 'command']
  const primaryEntry = primaryKeys
    .map((key) => [key, input[key]] as const)
    .find((entry): entry is readonly [string, string] => typeof entry[1] === 'string')
  const primary = execution.path ?? primaryEntry?.[1] ?? (typeof execution.input === 'string' ? execution.input : execution.label)
  const displayValue = primaryEntry && /^(path|filePath|file_path|target)$/.test(primaryEntry[0]) && /[\\/]/.test(primary)
    ? primary.split(/[\\/]/).at(-1) ?? primary
    : primary
  const start = input.line_start ?? input.lineStart ?? input.startLine
  const end = input.line_end ?? input.lineEnd ?? input.endLine
  const range = typeof start === 'number'
    ? `Lines ${start}${typeof end === 'number' ? `-${end}` : ''}`
    : undefined
  return { displayValue, primary, range, title: [primary, range, execution.error ?? execution.output].filter(Boolean).join(' · ') }
}

function StatusGlyph({ running, label, doneIcon, orbState = 'working' }: { running: boolean; label: string; doneIcon?: IconSvgElement; orbState?: OrbState }) {
  // Running tasks keep the animated orb; settled tasks switch to a static
  // HugeIcon SVG that corresponds to the task type. Both states share one
  // fixed 20px footprint (orb is 20px, icon 16px centered inside it) so the
  // icon column — and the title's first letter after it — never shifts
  // vertically or horizontally when a task settles.
  return (
    <span aria-label={label} className="flex size-5 shrink-0 items-center justify-center">
      {running
        ? <ThinkingOrb className="shrink-0" size={20} state={orbState} />
        : <HugeiconsIcon className="size-4 shrink-0 text-[var(--app-subtle-foreground)]" icon={doneIcon ?? BadgeCheckIcon} />}
    </span>
  )
}

function executionDoneIcon(execution: TaskExecution): IconSvgElement {
  if (execution.kind === 'command') return SquareTerminalIcon
  if (execution.kind === 'file') return Edit01Icon
  const name = execution.label.toLowerCase()
  if (/read|open|search|find|grep/.test(name)) return BookOpen01Icon
  return BadgeCheckIcon
}

function ExecutionIcon({ execution }: { execution: TaskExecution }) {
  const action = toolActionLabel(execution)
  const stateLabel = execution.state === 'active'
    ? `${action} 中`
    : execution.state === 'failed'
      ? `${action} 失败`
      : execution.state === 'completed'
        ? `${action} 已完成`
        : `${action} 等待中`

  return (
    <StatusGlyph doneIcon={executionDoneIcon(execution)} label={stateLabel} orbState={executionOrbState(execution)} running={execution.state === 'active'} />
  )
}

function TaskExecutionRow({ execution }: { execution: TaskExecution }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const input = executionInput(execution)
  const expandable = execution.kind === 'command' || execution.kind === 'file'
  const command = execution.kind === 'command' ? input.primary : undefined
  const output = execution.error ?? execution.output

  return (
    <div className="min-w-0 text-[13px] leading-4 tracking-[-0.0762px] text-[var(--app-muted)]">
      <div className="flex h-6 min-w-0 items-center gap-2">
        <span className={execution.state === 'failed' ? 'w-14 shrink-0 truncate text-[var(--destructive)]' : 'w-14 shrink-0 truncate'}>{toolActionLabel(execution)}</span>
        <button
          aria-controls={expandable ? detailsId : undefined}
          aria-expanded={expandable ? open : undefined}
          className={`flex h-6 min-w-0 max-w-[200px] items-center gap-1.5 overflow-hidden rounded-md border pl-1 pr-1.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--app-muted)] ${expandable ? 'cursor-pointer hover:border-[var(--app-muted)]' : 'cursor-default'} ${execution.state === 'failed' ? 'border-[color-mix(in_oklab,var(--destructive)_35%,transparent)] bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)]' : 'border-[var(--app-control-border)] bg-[var(--app-active)]'}`}
          disabled={!expandable}
          onClick={() => expandable && setOpen((value) => !value)}
          title={input.title}
          type="button"
        >
          <span className={`flex shrink-0 items-center justify-center ${execution.state === 'active' ? 'size-5' : 'size-4'}`}><ExecutionIcon execution={execution} /></span>
          <span className="min-w-0 truncate">{input.displayValue}</span>
          {input.range && <span className="shrink-0 text-[var(--app-subtle-foreground)]">{input.range}</span>}
        </button>
      </div>
      {expandable && open ? (
        <div className="mt-2 max-h-[240px] w-full max-w-[350px] space-y-2 overflow-y-auto font-mono text-[13px] leading-5 text-[var(--app-muted)]" id={detailsId}>
          {execution.kind === 'file' ? (
            execution.content !== undefined ? <ChatCodePreview className="max-w-none" content={execution.content} language={execution.language} path={execution.path ?? input.primary} streaming={execution.editState === 'editing'} /> : <p className="rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3 text-[12px] text-[var(--app-muted)]">等待代码内容…</p>
          ) : (
            <>
              <pre className="overflow-x-auto rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3 text-[var(--app-foreground)]"><code className="whitespace-pre">$ {command}</code></pre>
              {output ? <pre className="overflow-x-auto rounded-md border border-[var(--app-control-border)] bg-[var(--app-surface)] p-3 text-[var(--app-foreground)]"><code className="whitespace-pre-wrap break-words">{output}</code></pre> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function TaskGroupItem({ item }: { item: Extract<TimelineItem, { kind: 'task' }> }) {
  const [open, setOpen] = useState(false)
  const latestExecution = item.executions.findLast((execution) => execution.state === 'active') ?? item.executions.at(-1)
  const title = item.executions.length ? dynamicTaskLabel(item.executions, item.state === 'active') : item.label
  const orbState = latestExecution ? executionOrbState(latestExecution) : 'working'
  return (
    <Task className="w-full" onOpenChange={setOpen} open={open}>
      <TaskTrigger className="w-full" title={title}>
        <div className="flex h-7 w-full items-center gap-2 overflow-hidden rounded-md text-left text-[13px] leading-[21.125px] tracking-[-0.0762px] text-[var(--app-muted)] transition-colors hover:text-[var(--app-foreground)]">
          <StatusGlyph doneIcon={BadgeCheckIcon} label={title} orbState={orbState} running={item.state === 'active'} />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <ChevronDown className={`size-[13px] shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        </div>
      </TaskTrigger>
      <TaskContent className="[&>div]:mt-0 [&>div]:grid [&>div]:max-h-[240px] [&>div]:grid-cols-[28px_minmax(0,1fr)] [&>div]:space-y-0 [&>div]:overflow-x-hidden [&>div]:overflow-y-auto [&>div]:overscroll-contain [&>div]:border-0 [&>div]:pl-0">
        <div className="relative h-full"><span className="absolute left-[9.5px] top-0 h-full w-px bg-gradient-to-b from-[var(--app-border)] to-transparent" /></div>
        <div className="flex min-w-0 flex-col gap-2 pt-2">
          {item.executions.map((execution) => <TaskExecutionRow execution={execution} key={execution.id} />)}
          {item.executions.length === 0 && item.detail ? <p className="text-[12px] leading-5 text-[var(--app-muted)]">{item.detail}</p> : null}
        </div>
      </TaskContent>
    </Task>
  )
}

function StatusItem({ item }: { item: Extract<TimelineItem, { kind: 'status' }> }) {
  return (
    <div className="flex h-7 items-center gap-2 text-[13px] leading-[21px] tracking-[-0.0762px] text-[var(--app-muted)]">
      <StatusGlyph doneIcon={BadgeCheckIcon} label={`${item.label}${item.state === 'active' ? '中' : item.state === 'failed' ? '失败' : '已完成'}`} running={item.state === 'active'} />
      <div className="min-w-0 leading-[21px]"><p>{item.label}</p>{item.detail ? <p className="text-[12px] text-[var(--app-subtle-foreground)]">{item.detail}</p> : null}</div>
    </div>
  )
}

function ChangeItem({ item }: { item: Extract<TimelineItem, { kind: 'change' }> }) {
  const [open, setOpen] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  const files = (item.files ?? []).map((file) => typeof file === 'string' ? { path: file } : file)
  const selected = files.find((file) => file.path === selectedPath) ?? files[0]

  return (
    <div className={`overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] p-2 shadow-[0_2px_1px_rgb(0_0_0_/_4%),0_8px_4px_rgb(0_0_0_/_4%)] transition-[max-height] duration-200 ease-out ${open ? 'max-h-[540px]' : 'max-h-[46px]'}`}>
      <div className="flex h-7 items-center gap-1">
        <button aria-expanded={open} className="flex h-7 min-w-0 flex-1 select-none items-center gap-2 rounded-md text-left outline-none hover:text-[var(--app-foreground)] focus:outline-none focus-visible:outline-none" onClick={() => setOpen((value) => !value)} type="button">
          {open ? <ChevronDown className="size-[13px] shrink-0 text-[var(--app-muted)]" /> : <ChevronRight className="size-[13px] shrink-0 text-[var(--app-muted)]" />}
          <span className="min-w-0 truncate text-[13px] tracking-[-0.0762px]">{item.label}</span>
          {item.baseCommit ? <span className="shrink-0 text-[12px] text-[var(--app-muted)]">@{item.baseCommit}</span> : item.changeCount && item.changeCount > 1 ? <span className="shrink-0 text-[13px] text-[var(--app-muted)]">v{item.changeCount}</span> : null}
        </button>
        {(item.additions !== undefined || item.deletions !== undefined) && (
          <button aria-label="查看差异" className="flex h-6 shrink-0 items-center rounded border border-[var(--app-control-border)] px-2 text-xs font-medium hover:bg-[var(--app-hover)]" type="button">
            <span className="text-[var(--app-success)]">+{item.additions ?? 0}</span>
            <span className="px-0.5 text-[var(--app-muted)]">/</span>
            <span className="text-[var(--app-danger)]">-{item.deletions ?? 0}</span>
          </button>
        )}
        <button aria-label={open ? '收起 Git 变更' : '展开 Git 变更'} className="flex size-6 items-center justify-center rounded text-[var(--app-muted)] hover:bg-[var(--app-active)] hover:text-[var(--app-foreground)]" onClick={() => setOpen((value) => !value)} type="button"><RotateCcw className="size-3.5" /></button>
      </div>
      {open && files.length ? (
        <div className="max-h-[480px] overflow-y-auto pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="space-y-0.5">
          {files.map((change) => {
            const segments = change.path.split('/')
            const name = segments.at(-1) ?? change.path
            const directory = segments.slice(0, -1).join('/')
            return (
              <button aria-pressed={selected?.path === change.path} className={`flex h-7 w-full min-w-0 items-center gap-2 rounded px-0.5 text-left transition-colors hover:bg-[var(--app-hover)] ${selected?.path === change.path ? 'bg-[var(--app-active)]' : ''}`} key={change.path} onClick={() => setSelectedPath(change.path)} type="button">
                <Atom className="size-4 shrink-0 text-[var(--app-info)]" />
                <span className="shrink-0 text-[13px] text-[var(--app-foreground)]">{name}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--app-muted)]">{directory}</span>
                {(change.additions !== undefined || change.deletions !== undefined) && (
                  <span className="flex shrink-0 items-center gap-0.5 text-[12px]">
                    <span className="text-[var(--app-success)]">+{change.additions ?? 0}</span>
                    {change.deletions ? <span className="text-[var(--app-danger)]">/-{change.deletions}</span> : null}
                  </span>
                )}
              </button>
            )
          })}
          </div>
          {selected?.patch ? (
            <pre className="mt-2 max-h-[248px] overflow-auto rounded-md border border-[var(--app-control-border)] bg-[var(--app-active)] p-2 font-mono text-[11px] leading-4 text-[var(--app-foreground)]"><code className="whitespace-pre-wrap break-words">{selected.patch}</code></pre>
          ) : item.snapshot ? <p className="mt-2 text-[12px] text-[var(--app-muted)]">Git detected this file, but it has no text diff to preview.</p> : null}
        </div>
      ) : null}
    </div>
  )
}

function ConfirmationResultItem({ item }: { item: Extract<TimelineItem, { kind: 'confirmation' }> }) {
  const approved = item.approved ?? false

  return (
    <div
      aria-label={`${item.title}，${approved ? '已批准执行' : '已拒绝执行'}`}
      className="flex h-6 min-w-0 items-center gap-2 text-[13px] leading-4 tracking-[-0.0762px] text-[var(--app-muted)]"
      role="status"
    >
      <span className="w-14 shrink-0 truncate">{approved ? '批准' : '跳过'}</span>
      <div className="flex h-6 min-w-0 max-w-[200px] items-center gap-1.5 overflow-hidden rounded-md border border-[var(--app-control-border)] bg-[var(--app-active)] pl-1 pr-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {approved
            ? <CircleCheck className="size-[14px] text-[var(--app-success)]" />
            : <CircleAlert className="size-[14px] text-[var(--destructive)]" />}
        </span>
        <span className="min-w-0 truncate text-[var(--app-foreground)]">{item.title}</span>
      </div>
    </div>
  )
}

function formatRelativeTime(timestamp: string) {
  const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime())
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatClockTime(timestamp: string) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(timestamp))
}

function TimelineMessageItem({ item }: { item: Extract<TimelineItem, { kind: 'message' }> }) {
  const compactUserMessage = item.role === 'user' && !item.text.includes('\n') && item.text.trim().length <= 16
  return (
    <Message className={item.role === 'user' ? 'mb-4 max-w-[95%]' : 'max-w-full'} from={item.role}>
      <MessageContent className={item.role === 'user'
        ? `relative isolate min-h-0 overflow-hidden border border-[var(--app-control-border)] bg-[var(--app-active)]! text-[13px] text-[var(--app-foreground)]! before:hidden after:hidden ${compactUserMessage ? 'rounded-lg! px-2.5! py-px! leading-5' : 'rounded-2xl! px-3! py-1.5! leading-[21.125px]'}`
        : 'w-full gap-0 overflow-visible text-[13px] leading-[21.125px]'}>
        {item.role === 'assistant'
          ? <MessageResponse className="chat-message-markdown text-[13px] leading-[21.125px] [&_li]:my-1 [&_p]:my-0 [&_ul]:list-outside [&_ul]:pl-[1.5em] [&_ul]:my-1 [&_ol]:list-outside [&_ol]:pl-[1.5em] [&_ol]:my-1 [&_li>p]:inline">{item.text}</MessageResponse>
          : <p className="whitespace-pre-wrap break-words">{item.text}</p>}
        {item.streaming && <span className="inline-block h-3 w-1 animate-pulse bg-[var(--app-foreground)]" />}
      </MessageContent>
    </Message>
  )
}

function TimelineItemView({ item }: { item: TimelineItem }) {
  if (item.kind === 'message') return <TimelineMessageItem item={item} />
  if (item.kind === 'reasoning') {
    return (
      <Reasoning className="mb-0!" defaultOpen={false} duration={item.durationMs ? Math.max(1, Math.round(item.durationMs / 1000)) : undefined} isStreaming={item.streaming}>
        <ReasoningTrigger className="h-7 gap-2 text-[13px] leading-[21px] tracking-[-0.0762px]" getThinkingMessage={(streaming) => streaming ? <span>Thinking…</span> : <span>Thought for a moment</span>}>
          <StatusGlyph doneIcon={AiBrain02Icon} label={item.streaming ? '正在思考' : '思考已完成'} orbState="solving" running={item.streaming} />
          <span>{item.streaming ? 'Thinking…' : 'Thought for a moment'}</span>
        </ReasoningTrigger>
        {item.text && <ReasoningContent className="relative mt-2 pl-7 text-[12px] leading-5 before:absolute before:inset-y-0 before:left-[9.5px] before:w-px before:bg-gradient-to-b before:from-[var(--app-border)] before:to-transparent">{item.text}</ReasoningContent>}
      </Reasoning>
    )
  }
  if (item.kind === 'task') return <TaskGroupItem item={item} />
  if (item.kind === 'status') return <StatusItem item={item} />
  if (item.kind === 'change') return <ChangeItem item={item} />
  if (item.kind === 'confirmation') return item.resolved ? <ConfirmationResultItem item={item} /> : null
  if (item.kind === 'checkpoint') return null
  return <div className="flex gap-2 rounded-lg border border-[color-mix(in_oklab,var(--destructive)_35%,transparent)] bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)] p-2 text-[13px] text-[var(--destructive)]"><CircleAlert className="mt-1 size-3.5 shrink-0" />{item.message}</div>
}

function StreamingThinkingItem() {
  return (
    <div className="flex h-7 items-center gap-2 text-[13px] leading-[21px] text-[var(--app-muted)]" data-streaming-thinking>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <ThinkingOrb aria-label="正在思考" className="shrink-0" size={20} state="solving" />
      </span>
      <span>Thinking…</span>
    </div>
  )
}

function WorkFlowGroup({
  activeFlow,
  children,
  round,
}: {
  activeFlow: ActiveFlowStatus | null
  children: ReactNode
  round: ConversationRound
}) {
  const [open, setOpen] = useState(round.state === 'working')
  const checkpoint = round.checkpoint
  const flow = round.state === 'working' && activeFlow ? activeFlow : latestFlowForItems(round.workingItems)
  const label = round.state === 'working' ? 'Working' : checkpoint?.label ?? 'Worked'
  const checkpointText = checkpoint ? [
    checkpoint.label,
    `${checkpoint.metrics?.actions ?? 0} actions`,
    `${checkpoint.metrics?.credits?.toFixed(3) ?? '0.000'} credits`,
    checkpoint.metrics?.model ?? 'Fable 5',
  ].join('\n') : ''

  useEffect(() => {
    if (round.state === 'worked') setOpen(false)
  }, [round.state])

  const copyCheckpointLink = () => {
    if (!checkpoint) return
    const url = new URL(window.location.href)
    url.hash = `checkpoint-${checkpoint.id}`
    void navigator.clipboard.writeText(url.toString())
  }

  const requestRetry = (mode: 'same-model' | 'from-checkpoint') => {
    if (!checkpoint) return
    window.dispatchEvent(new CustomEvent('openlink:retry-checkpoint', {
      detail: { checkpointId: checkpoint.id, mode },
    }))
  }

  return (
    <section className={`flex w-full flex-col text-[13px] tracking-[-0.0762px] text-[var(--app-subtle-foreground)] ${round.state === 'worked' ? 'border-b border-[var(--app-border)]' : ''}`} id={checkpoint ? `checkpoint-${checkpoint.id}` : undefined}>
      <div className={`flex min-h-9 w-full items-center gap-2 border-[var(--app-border)] ${round.state === 'working' && open ? 'border-b' : ''}`}>
        <button aria-expanded={open} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:text-[var(--app-foreground)] focus-visible:ring-0" onClick={() => setOpen((value) => !value)} type="button">
          <StatusGlyph doneIcon={BadgeCheckIcon} label={flow.label} orbState={flow.state} running={round.state === 'working'} />
          <span className="truncate text-[14px] font-medium">{label}</span>
          <ChevronDown className={`size-[13px] shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
        {checkpoint ? <span className="hidden shrink-0 items-center gap-1 sm:flex"><Clock3 className="size-[13px]" />{open ? formatClockTime(checkpoint.timestamp) : formatRelativeTime(checkpoint.timestamp)}</span> : null}
        {checkpoint ? <DropdownMenu>
          <DropdownMenuTrigger
            render={<button aria-label="更多运行操作" className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--app-hover)] hover:text-[var(--app-foreground)] data-popup-open:bg-[var(--app-active)] data-popup-open:text-[var(--app-foreground)]" type="button" />}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-[164px] rounded-xl border border-[var(--app-border)] bg-[var(--app-elevated)] p-1.5 text-[var(--app-foreground)] shadow-[0_12px_36px_var(--app-shadow)] ring-0"
            side="top"
            sideOffset={8}
          >
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="h-8 cursor-pointer gap-2.5 rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)] data-popup-open:bg-[var(--app-hover)]">
                <RefreshCw className="size-4 text-[var(--app-muted)]" />
                <span>重试</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-[144px] rounded-lg border border-[var(--app-border)] bg-[var(--app-elevated)] p-1 shadow-[0_12px_36px_var(--app-shadow)] ring-0">
                <DropdownMenuItem className="h-8 cursor-pointer rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]" onClick={() => requestRetry('from-checkpoint')}>从此处重试</DropdownMenuItem>
                <DropdownMenuItem className="h-8 cursor-pointer rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]" onClick={() => requestRetry('same-model')}>使用相同模型</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem className="h-8 cursor-pointer gap-2.5 rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]" onClick={() => { void navigator.clipboard.writeText(checkpointText) }}>
              <Copy className="size-4 text-[var(--app-muted)]" />
              <span>复制</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="h-8 cursor-pointer gap-2.5 rounded-md px-2.5 text-[13px] focus:bg-[var(--app-hover)]" onClick={copyCheckpointLink}>
              <Link2 className="size-4 text-[var(--app-muted)]" />
              <span>Copy Link</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu> : null}
      </div>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="flex min-h-0 flex-col gap-2 overflow-hidden pb-2 pt-2">
          {children}
        </div>
      </div>
    </section>
  )
}

function EndingSection({ round }: { round: ConversationRound }) {
  if (round.state !== 'worked' || (!round.ending && !round.endingChange)) return null
  const hasWorkingGroup = round.workingItems.length > 0

  return (
    <div className={`flex flex-col gap-3 ${hasWorkingGroup ? '-mt-1' : ''}`} data-message-phase="ending">
      {round.ending ? <div data-ending-item="summary"><TimelineMessageItem item={round.ending} /></div> : null}
      {round.endingChange ? <div data-ending-item="applied-changes"><ChangeItem item={round.endingChange} /></div> : null}
    </div>
  )
}

export function ChatTimeline({
  events,
  isStreaming = false,
  onFlowStatusChange,
}: {
  events: OpenLinkAgentEvent[]
  isStreaming?: boolean
  onFlowStatusChange?: (status: ActiveFlowStatus | null) => void
}) {
  const timeline = useMemo(() => buildTimeline(events), [events])
  const rounds = useMemo(() => buildConversationRounds(timeline), [timeline])
  const activeFlow = useMemo(() => getActiveFlowStatus(timeline) ?? (isStreaming ? { label: '正在思考', state: 'solving' as OrbState } : null), [isStreaming, timeline])

  useEffect(() => {
    onFlowStatusChange?.(activeFlow)
  }, [activeFlow, onFlowStatusChange])

  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent className="min-h-full gap-5 px-3 pb-6 pt-20 text-[13px] leading-[21.125px] tracking-[-0.0762px]">
        {rounds.map((round) => (
          <section className="flex w-full flex-col gap-3" data-round-state={round.state} key={round.id}>
            {round.user ? <TimelineMessageItem item={round.user} /> : null}
            {round.thinkingItems.map((item) => <TimelineItemView item={item} key={item.id} />)}
            {isStreaming && round === rounds.at(-1) && !round.thinkingItems.length && !round.workingItems.length && !round.outputItems.length && !round.ending ? <StreamingThinkingItem /> : null}
            {round.workingItems.length || round.checkpoint ? (
              <WorkFlowGroup activeFlow={round.state === 'working' ? activeFlow : null} round={round}>
                {round.workingItems.map((item) => <TimelineItemView item={item} key={item.id} />)}
              </WorkFlowGroup>
            ) : null}
            {round.outputItems.map((item) => <TimelineMessageItem item={item} key={item.id} />)}
            <EndingSection round={round} />
          </section>
        ))}
        <div className="h-px w-full" data-task-position="current" />
      </ConversationContent>
      <TaskPositionCapsule activeFlow={activeFlow} />
    </Conversation>
  )
}

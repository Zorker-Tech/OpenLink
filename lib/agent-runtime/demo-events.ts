import type { Translator } from '@/lib/i18n/messages'

import type { OpenLinkAgentEvent } from './events'

interface DemoRunOptions {
  sessionId: string
  prompt: string
  startedAt?: string
  startSequence?: number
  includeUserMessage?: boolean
}

/**
 * Fallback for callers that render without a locale provider (tests, stories,
 * isolated adapters). It mirrors `translate()` from lib/i18n/messages: no
 * catalog lookup, but placeholders still resolve.
 */
const sourceTranslator: Translator = (source, values) => values
  ? source.replace(/\{(\w+)\}/g, (match, key: string) => values[key] === undefined ? match : String(values[key]))
  : source
const defaultPrompt = (t: Translator) => t('给项目安装 npx ai-elements@latest 这个 sdk，项目是 nextjs 项目')

export function createDemoAgentEvents({
  sessionId,
  prompt,
  startedAt = '2026-08-05T00:00:00.000Z',
  startSequence = 0,
  includeUserMessage = true,
}: DemoRunOptions, t: Translator = sourceTranslator): OpenLinkAgentEvent[] {
  const text = prompt.trim() || defaultPrompt(t)
  const run = `${sessionId}-${startSequence}`
  const timestamp = new Date(startedAt).toISOString()
  let sequence = startSequence

  const event = <T extends Omit<OpenLinkAgentEvent, 'version' | 'id' | 'sequence' | 'sessionId' | 'timestamp' | 'source'>>(
    value: T,
  ) => ({
    ...value,
    version: 1 as const,
    id: `${run}-${sequence}`,
    sequence: sequence++,
    sessionId,
    timestamp,
    source: 'demo' as const,
  }) as OpenLinkAgentEvent

  const events: OpenLinkAgentEvent[] = []
  if (includeUserMessage) {
    events.push(event({ type: 'message.user', messageId: `${run}-user`, text }))
  }

  events.push(
    event({ type: 'session.started' }),
    event({ type: 'reasoning.started', reasoningId: `${run}-reasoning-1` }),
    event({ type: 'reasoning.delta', reasoningId: `${run}-reasoning-1`, delta: t('检查项目结构、依赖与现有 AI Elements 组件，并生成一条覆盖所有 Chat UI 节点的执行链。') }),
    event({ type: 'reasoning.completed', reasoningId: `${run}-reasoning-1`, text: t('检查项目结构、依赖与现有 AI Elements 组件，并生成一条覆盖所有 Chat UI 节点的执行链。'), durationMs: 1200 }),
    event({ type: 'message.delta', messageId: `${run}-assistant-1`, delta: t('下面是一条完整的 Agent 执行链 Demo。连续且属于同一工作片段的 Tool 与 Command 会归入同一个 Task 执行集。') }),
    event({ type: 'message.completed', messageId: `${run}-assistant-1` }),
    event({
      type: 'task.updated',
      taskId: `${run}-task-read-sidebar`,
      label: 'Read sidebar example',
      status: 'active',
    }),
    event({ type: 'tool.started', toolId: `${run}-tool-read-1`, partId: `${run}-part-read-1`, name: 'read_file', input: { path: 'sidebar-icon-example.tsx' } }),
    event({ type: 'tool.output', toolId: `${run}-tool-read-1`, partId: `${run}-part-read-1`, output: t('读取完成。') }),
    event({ type: 'tool.completed', toolId: `${run}-tool-read-1`, partId: `${run}-part-read-1` }),
    event({ type: 'tool.started', toolId: `${run}-tool-read-2`, partId: `${run}-part-read-2`, name: 'read_file', input: { path: 'sidebar-icon-example.tsx', line_start: 118, line_end: 142 } }),
    event({ type: 'tool.output', toolId: `${run}-tool-read-2`, partId: `${run}-part-read-2`, output: t('读取第 118-142 行完成。') }),
    event({ type: 'tool.completed', toolId: `${run}-tool-read-2`, partId: `${run}-part-read-2` }),
    event({ type: 'task.updated', taskId: `${run}-task-read-sidebar`, label: 'Read sidebar example', status: 'completed' }),
    event({ type: 'task.updated', taskId: `${run}-task-implement`, label: 'Implement execution grouping', status: 'active' }),
    event({ type: 'command.started', commandId: `${run}-command-1`, partId: `${run}-part-implement-1`, command: 'pnpm list ai @ai-sdk/react' }),
    event({ type: 'command.output', commandId: `${run}-command-1`, partId: `${run}-part-implement-1`, output: 'ai 7.0.48\n@ai-sdk/react 4.0.54' }),
    event({ type: 'command.completed', commandId: `${run}-command-1`, partId: `${run}-part-implement-1`, exitCode: 0 }),
    event({ type: 'tool.started', toolId: `${run}-tool-search`, partId: `${run}-part-implement-2`, name: 'search_files', input: { query: 'task.updated', path: 'lib/agent-runtime' } }),
    event({ type: 'tool.output', toolId: `${run}-tool-search`, partId: `${run}-part-implement-2`, output: t('找到 6 个匹配结果。') }),
    event({ type: 'tool.completed', toolId: `${run}-tool-search`, partId: `${run}-part-implement-2` }),
    event({ type: 'tool.started', toolId: `${run}-tool-preview`, partId: `${run}-part-implement-2`, name: 'fetch_preview', input: { url: 'http://127.0.0.1:65535/preview' } }),
    event({ type: 'tool.failed', toolId: `${run}-tool-preview`, partId: `${run}-part-implement-2`, error: t('连接预览服务失败。') }),
    event({ type: 'task.updated', taskId: `${run}-task-implement`, label: 'Implement execution grouping', status: 'failed', detail: t('部分工具失败，可重试失败项。') }),
    event({
      type: 'file.changed',
      changeId: `${run}-change-1`,
      label: 'Applied changes',
      additions: 38,
      deletions: 4,
      files: [
        { path: 'components/chat-timeline.tsx', additions: 38, deletions: 4 },
      ],
    }),
    event({
      type: 'file.changed',
      changeId: `${run}-change-2`,
      label: 'Applied changes',
      additions: 428,
      deletions: 6,
      files: [
        { path: 'components/chat-timeline.tsx', additions: 241, deletions: 2 },
        { path: 'lib/agent-runtime/events.ts', additions: 96, deletions: 1 },
        { path: 'lib/agent-runtime/pi-event-adapter.ts', additions: 91, deletions: 3 },
      ],
    }),
    event({
      type: 'confirmation.requested',
      confirmationId: `${run}-confirmation-pending`,
      title: t('允许执行数据库迁移？'),
      message: t('待确认状态：操作会修改当前项目的本地数据库结构。'),
      inputKind: 'confirm',
    }),
    event({
      type: 'confirmation.requested',
      confirmationId: `${run}-confirmation-approved`,
      title: t('安装 AI Elements 依赖'),
      message: t('已批准状态示例。'),
      inputKind: 'confirm',
    }),
    event({ type: 'confirmation.resolved', confirmationId: `${run}-confirmation-approved`, approved: true }),
    event({
      type: 'confirmation.requested',
      confirmationId: `${run}-confirmation-rejected`,
      title: t('删除远端预览环境'),
      message: t('已拒绝状态示例。'),
      inputKind: 'confirm',
    }),
    event({ type: 'confirmation.resolved', confirmationId: `${run}-confirmation-rejected`, approved: false }),
    event({ type: 'message.delta', messageId: `${run}-assistant-2`, delta: t('完整 Chat UI Demo 已生成。当前页面仍使用 **Demo transport**；生产环境只需将 Pi JSONL 帧交给同一事件适配器，组件层无需切换实现。') }),
    event({ type: 'message.completed', messageId: `${run}-assistant-2` }),
    event({ type: 'error', errorId: `${run}-error-1`, message: t('可恢复错误示例：远端预览暂时不可用。'), recoverable: true }),
    event({ type: 'checkpoint.created', checkpointId: `${run}-checkpoint-1`, label: 'Worked for 1m 21s', metrics: { actions: 12, credits: 0.135, model: 'Fable 5' } }),
    event({ type: 'session.completed', durationMs: 81_000 }),
  )

  return events
}

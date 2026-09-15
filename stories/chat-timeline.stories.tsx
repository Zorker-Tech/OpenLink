import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ChatTimeline } from '@/components/chat-timeline'
import { ChatWorkspace } from '@/components/chat-workspace'
import { AccessWritesBanner } from '@/components/access-writes-banner'
import type { OpenLinkAgentEvent } from '@/lib/agent-runtime/events'
import { workspace } from './fixtures/product'

type Payload = OpenLinkAgentEvent extends infer Event ? Event extends OpenLinkAgentEvent ? Omit<Event, 'id' | 'version' | 'sequence' | 'sessionId' | 'timestamp' | 'source'> : never : never
function events(payloads: Payload[]): OpenLinkAgentEvent[] { return payloads.map((payload, index) => ({ ...payload, id: `event-${index}`, version: 1, sequence: index, sessionId: 'fixture-session', timestamp: new Date(Date.UTC(2026, 8, 12, 0, 0, index)).toISOString(), source: 'demo' })) }
const user: Payload = { type: 'message.user', messageId: 'u1', text: '请检查并修复这个组件。', attachments: [{ type: 'instruction', name: '代码规范', text: '保留原有交互并运行测试。' }, { type: 'text', text: '这是演示附件。', mediaType: 'text/plain', filename: '上下文.txt' }] }
const completed = events([user, { type: 'reasoning.started', reasoningId: 'r1' }, { type: 'reasoning.completed', reasoningId: 'r1', text: '检查组件边界和测试。', durationMs: 1200 }, { type: 'command.started', commandId: 'c1', command: 'pnpm test' }, { type: 'command.completed', commandId: 'c1', output: '13 tests passed', exitCode: 0 }, { type: 'message.completed', messageId: 'a1', text: '已修复，测试通过。' }, { type: 'session.completed', durationMs: 2200 }])
const meta = { title: 'Product/Timeline and Workspace', parameters: { layout: 'fullscreen', nextjs: { appDirectory: true }, localApi: {}, docs: { description: { component: '真实事件协议渲染，全部事件为本地 fixture。会话工作区的 API 被隔离，不运行真实 Agent。' } } }, decorators: [(Story) => <div className="flex h-[700px] flex-col"><Story /></div>] } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const CompletedRound: Story = { render: () => <ChatTimeline events={completed} /> }
export const Empty: Story = { render: () => <ChatTimeline events={[]} /> }
export const Streaming: Story = { render: () => <ChatTimeline events={events([user, { type: 'session.started' }, { type: 'reasoning.started', reasoningId: 'r1' }, { type: 'reasoning.delta', reasoningId: 'r1', delta: '正在检查…' }])} isStreaming /> }
export const EditingFile: Story = { render: () => <ChatTimeline events={events([user, { type: 'file.editing.started', editId: 'e1', path: 'app.ts', operation: 'edit', content: 'export const ready = true', language: 'typescript' }])} isStreaming /> }
export const FileChanges: Story = { render: () => <ChatTimeline events={events([user, { type: 'file.changed', changeId: 'f1', label: 'Applied changes', additions: 3, deletions: 1, files: ['app.ts'], baseCommit: 'abc1234' }, { type: 'checkpoint.created', checkpointId: 'cp1', label: '完成检查点' }, { type: 'message.completed', messageId: 'a1', text: '已更新组件。' }, { type: 'session.completed' }])} /> }
export const ToolFailure: Story = { render: () => <ChatTimeline events={events([user, { type: 'tool.started', toolId: 't1', name: 'read_file', input: { path: 'missing.ts' } }, { type: 'tool.failed', toolId: 't1', error: '文件不存在' }, { type: 'error', errorId: 'err', message: '演示：运行失败，请重试。', recoverable: true }])} /> }
export const ConfirmationEvent: Story = { render: () => <ChatTimeline events={events([user, { type: 'confirmation.requested', confirmationId: 'cf1', title: '允许修改文件？', message: '演示审批', confirmationKind: 'approval', inputKind: 'confirm' }])} /> }
export const TaskStates: Story = { render: () => <ChatTimeline events={events([user, ...(['pending','active','completed','failed'] as const).map((status, i): Payload => ({ type: 'task.updated', taskId: `task-${i}`, label: `任务 · ${status}`, status }))])} /> }
export const FullWorkspace: Story = { render: () => <ChatWorkspace {...workspace} configuredModels={[]} chatSessions={[]} autoStart={false} autoStartModel={null} initialEvents={completed} initialPrompt="" sessionId="fixture-session" thinkingVisibility="summary" sessionTitle="演示会话" projectName="演示项目" projectId="fixture-project" userId="fixture-user" localRuntime composerResources={{ agent: 'codex', skills: [], customInstructions: '' }} /> }
export const PiWorkspace: Story = { render: () => <ChatWorkspace {...workspace} configuredModels={[]} chatSessions={[]} autoStart={false} autoStartModel={null} initialEvents={completed} initialPrompt="" sessionId="fixture-session" thinkingVisibility="summary" sessionTitle="Pi 演示会话" projectName="演示项目" projectId="fixture-project" userId="fixture-user" localRuntime composerResources={{ agent: 'pi', skills: [], customInstructions: '' }} /> }
export const NoPendingWrites: Story = { render: () => <><p>无待审批写入时不显示横幅。</p><AccessWritesBanner sessionId="fixture-session" /></> }

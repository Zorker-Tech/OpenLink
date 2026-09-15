import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import * as Agent from '@/components/ai-elements/agent'
import * as Chain from '@/components/ai-elements/chain-of-thought'
import * as Confirm from '@/components/ai-elements/confirmation'
import * as Env from '@/components/ai-elements/environment-variables'
import * as Package from '@/components/ai-elements/package-info'
import * as Schema from '@/components/ai-elements/schema-display'
import * as SnippetElements from '@/components/ai-elements/snippet'
import * as Tests from '@/components/ai-elements/test-results'
import * as ToolElements from '@/components/ai-elements/tool'
import * as QueueElements from '@/components/ai-elements/queue'
import * as CommitElements from '@/components/ai-elements/commit'
import * as Attachment from '@/components/ai-elements/attachments'
import * as ContextElements from '@/components/ai-elements/context'
import * as CheckpointElements from '@/components/ai-elements/checkpoint'
import * as SandboxElements from '@/components/ai-elements/sandbox'
import * as Citation from '@/components/ai-elements/inline-citation'
import * as Code from '@/components/ai-elements/code-block'
import { Shimmer as ShimmerElement } from '@/components/ai-elements/shimmer'
import { Conversation as ConversationElement, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'

/**
 * Protocol primitives are rendered in the same full-width Storybook canvas as
 * the product timeline.  The previous decorator omitted a layout override, so
 * Storybook's global `centered` layout constrained the iframe root to the
 * intrinsic width of each primitive (a narrow white strip in the middle of the
 * canvas).  Keeping the frame wide also makes portal/overlay states inspectable
 * without pretending these primitives are a separate product shell.
 */
const meta = {
  title: 'AI Elements/Protocol Primitives',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'OpenLink 的协议级可复用原语。产品会话中的真实事件组合请查看 Product/Timeline and Workspace；这里仅展示原语的可组合状态。',
      },
    },
  },
  decorators: [(Story) => (
    <main className="min-h-[420px] w-full bg-[var(--app-background)] px-6 py-10 text-[var(--app-foreground)]">
      <div className="mx-auto grid w-full max-w-[900px] gap-5">
        <Story />
      </div>
    </main>
  )],
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const AgentInstructions: Story = { render: () => <Agent.Agent><Agent.AgentHeader name="本地编程助手" model="OpenLink 工作模式" /><Agent.AgentContent><Agent.AgentInstructions>仅修改用户指定的文件，完成后执行本地测试。</Agent.AgentInstructions></Agent.AgentContent></Agent.Agent> }
export const ChainOfThought: Story = { render: () => <Chain.ChainOfThought defaultOpen><Chain.ChainOfThoughtHeader>任务执行过程</Chain.ChainOfThoughtHeader><Chain.ChainOfThoughtContent><Chain.ChainOfThoughtStep label="检查文件" status="complete" /><Chain.ChainOfThoughtStep label="运行本地测试" description="正在验证变更" status="active" /><Chain.ChainOfThoughtStep label="返回结果" status="pending" /></Chain.ChainOfThoughtContent></Chain.ChainOfThought> }
export const ApprovalRequested: Story = { render: () => <Confirm.Confirmation approval={{ id: 'fixture-approval' }} state="approval-requested"><Confirm.ConfirmationTitle>允许写入项目文件？</Confirm.ConfirmationTitle><Confirm.ConfirmationRequest><Confirm.ConfirmationActions><Confirm.ConfirmationAction variant="outline">拒绝</Confirm.ConfirmationAction><Confirm.ConfirmationAction>允许</Confirm.ConfirmationAction></Confirm.ConfirmationActions></Confirm.ConfirmationRequest></Confirm.Confirmation> }
export const ApprovalAccepted: Story = { render: () => <Confirm.Confirmation approval={{ id: 'fixture-approval', approved: true }} state="approval-responded"><Confirm.ConfirmationAccepted>已允许操作</Confirm.ConfirmationAccepted></Confirm.Confirmation> }
export const ApprovalDenied: Story = { render: () => <Confirm.Confirmation approval={{ id: 'fixture-approval', approved: false }} state="output-denied"><Confirm.ConfirmationRejected>已拒绝操作</Confirm.ConfirmationRejected></Confirm.Confirmation> }
export const EnvironmentVariables: Story = { render: () => <Env.EnvironmentVariables><Env.EnvironmentVariablesHeader><Env.EnvironmentVariablesTitle /><Env.EnvironmentVariablesToggle /></Env.EnvironmentVariablesHeader><Env.EnvironmentVariablesContent>{[['PUBLIC_NAME', 'OpenLink'], ['LOCAL_MODE', 'storybook']].map(([name, value]) => <Env.EnvironmentVariable key={name} name={name} value={value}><Env.EnvironmentVariableName /><Env.EnvironmentVariableValue /><Env.EnvironmentVariableCopyButton /></Env.EnvironmentVariable>)}</Env.EnvironmentVariablesContent></Env.EnvironmentVariables> }
export const PackageInfoStates: Story = { render: () => <>{(['added', 'minor', 'removed'] as const).map(changeType => <Package.PackageInfo key={changeType} name="openlink-ui" currentVersion="1.0.0" newVersion="1.1.0" changeType={changeType}><Package.PackageInfoHeader><Package.PackageInfoName /><Package.PackageInfoChangeType /></Package.PackageInfoHeader><Package.PackageInfoVersion /></Package.PackageInfo>)}</> }
export const SchemaDisplay: Story = { render: () => <Schema.SchemaDisplay method="GET" path="/projects/{id}" description="按标识符读取本地项目" parameters={[{ name: 'id', type: 'string', required: true, description: '项目 ID', location: 'path' }]}><Schema.SchemaDisplayHeader><Schema.SchemaDisplayMethod /><Schema.SchemaDisplayPath /></Schema.SchemaDisplayHeader><Schema.SchemaDisplayDescription /><Schema.SchemaDisplayContent><Schema.SchemaDisplayParameters /></Schema.SchemaDisplayContent></Schema.SchemaDisplay> }
export const Snippet: Story = { render: () => <SnippetElements.Snippet code="pnpm storybook"><SnippetElements.SnippetInput aria-label="启动命令" /><SnippetElements.SnippetAddon><SnippetElements.SnippetCopyButton /></SnippetElements.SnippetAddon></SnippetElements.Snippet> }
export const TestResults: Story = { render: () => <Tests.TestResults summary={{ passed: 2, failed: 1, skipped: 1, total: 4, duration: 140 }}><Tests.TestResultsHeader><Tests.TestResultsSummary /><Tests.TestResultsDuration /></Tests.TestResultsHeader><Tests.TestResultsProgress /><Tests.TestResultsContent>{(['passed', 'failed', 'skipped', 'running'] as const).map(status => <Tests.Test key={status} name={`组件测试 · ${status}`} status={status} duration={35}><Tests.TestStatus /><Tests.TestName /><Tests.TestDuration />{status === 'failed' ? <Tests.TestError><Tests.TestErrorMessage>可见滑块圆点未被裁切</Tests.TestErrorMessage></Tests.TestError> : null}</Tests.Test>)}</Tests.TestResultsContent></Tests.TestResults> }
export const Tool: Story = { render: () => <>{(['input-streaming', 'input-available', 'output-available', 'output-error', 'output-denied'] as const).map(state => <ToolElements.Tool key={state} defaultOpen><ToolElements.ToolHeader type="tool-read_file" state={state} /><ToolElements.ToolContent><ToolElements.ToolInput input={{ path: 'components/chat-timeline.tsx' }} /><ToolElements.ToolOutput output={state === 'output-available' ? '文件已读取。' : undefined} errorText={state === 'output-error' ? '文件不存在' : undefined} /></ToolElements.ToolContent></ToolElements.Tool>)}</> }
export const Queue: Story = { render: () => <QueueElements.Queue><QueueElements.QueueList>{['检查组件', '修复问题', '运行本地测试'].map((item, index) => <QueueElements.QueueItem key={item}><div className="flex items-center gap-2"><QueueElements.QueueItemIndicator completed={index === 0} /><QueueElements.QueueItemContent completed={index === 0}>{item}</QueueElements.QueueItemContent></div><QueueElements.QueueItemDescription>本地 Storybook 队列 fixture</QueueElements.QueueItemDescription></QueueElements.QueueItem>)}</QueueElements.QueueList></QueueElements.Queue> }
export const Commit: Story = { render: () => <CommitElements.Commit defaultOpen><CommitElements.CommitHeader><CommitElements.CommitHash>abc1234</CommitElements.CommitHash><CommitElements.CommitMessage>修复 Storybook 画布裁切</CommitElements.CommitMessage></CommitElements.CommitHeader><CommitElements.CommitContent><CommitElements.CommitFiles><CommitElements.CommitFile><CommitElements.CommitFileInfo><CommitElements.CommitFilePath>app/globals.css</CommitElements.CommitFilePath></CommitElements.CommitFileInfo><CommitElements.CommitFileChanges><CommitElements.CommitFileAdditions count={1} /><CommitElements.CommitFileDeletions count={0} /></CommitElements.CommitFileChanges></CommitElements.CommitFile></CommitElements.CommitFiles></CommitElements.CommitContent></CommitElements.Commit> }
export const Attachments: Story = { render: () => <>{(['grid', 'inline', 'list'] as const).map(variant => <Attachment.Attachments key={variant} variant={variant}><Attachment.Attachment onRemove={() => {}} data={{ id: 'fixture', type: 'file', url: 'data:text/plain,OpenLink', mediaType: 'text/plain', filename: 'README.md' }}><Attachment.AttachmentPreview /><Attachment.AttachmentInfo /><Attachment.AttachmentRemove /></Attachment.Attachment></Attachment.Attachments>)}</> }
export const Context: Story = { render: () => <ContextElements.Context usedTokens={32000} maxTokens={128000}><ContextElements.ContextTrigger /><ContextElements.ContextContent><ContextElements.ContextContentHeader /><ContextElements.ContextContentBody>本地对话上下文使用情况</ContextElements.ContextContentBody></ContextElements.ContextContent></ContextElements.Context> }
export const Checkpoint: Story = { render: () => <CheckpointElements.Checkpoint><CheckpointElements.CheckpointIcon /><CheckpointElements.CheckpointTrigger>恢复至此检查点</CheckpointElements.CheckpointTrigger></CheckpointElements.Checkpoint> }
export const Sandbox: Story = { render: () => <SandboxElements.Sandbox><SandboxElements.SandboxHeader title="运行本地测试" state="output-available" /><SandboxElements.SandboxContent><Code.CodeBlock code="13 tests passed" language="bash" /></SandboxElements.SandboxContent></SandboxElements.Sandbox> }
export const InlineCitation: Story = { render: () => <Citation.InlineCitation><Citation.InlineCitationText>参考 OpenLink 本地文档。</Citation.InlineCitationText><Citation.InlineCitationCard><Citation.InlineCitationCardTrigger sources={['https://docs.openlink.local/components']} /><Citation.InlineCitationCardBody><Citation.InlineCitationSource title="OpenLink 组件文档" url="https://docs.openlink.local/components" description="本地 Storybook fixture，不请求外部站点。" /></Citation.InlineCitationCardBody></Citation.InlineCitationCard></Citation.InlineCitation> }
export const CodeBlock: Story = { render: () => <Code.CodeBlock code={'export const ready = true\nconsole.log(ready)'} language="typescript"><Code.CodeBlockHeader><Code.CodeBlockFilename>components/example.ts</Code.CodeBlockFilename><Code.CodeBlockCopyButton /></Code.CodeBlockHeader></Code.CodeBlock> }
export const Shimmer: Story = { render: () => <ShimmerElement>正在检查本地运行时…</ShimmerElement> }
export const Conversation: Story = { render: () => <ConversationElement className="h-80 border"><ConversationContent>{Array.from({ length: 20 }, (_, i) => <p key={i}>消息 {i + 1}：OpenLink 会话滚动 fixture。</p>)}</ConversationContent><ConversationScrollButton /></ConversationElement> }

import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { KnowledgeWorkspace } from '@/components/knowledge-workspace'
import { ProjectSupabasePanel } from '@/components/project-supabase-panel'
import { ProjectSupabaseStudioFrame } from '@/components/project-supabase-studio-frame'
import { CodeServerWorkbench } from '@/components/code-server/code-server-workbench'
import { BrowserWorkbench } from '@/components/browser/browser-workbench'
import { workspace } from './fixtures/product'

const meta = { title: 'Product/Runtime States', parameters: { layout: 'fullscreen', nextjs: { appDirectory: true }, localApi: {}, docs: { description: { component: '真实运行时面板，HTTP 由本地 fixtures 响应。未配置的 API 返回 501，不连接 VM、数据库或浏览器服务。' } } }, decorators: [(Story) => <div className="h-[700px]"><Story /></div>] } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
const knowledgeApi = {
  '/api/knowledge/collections': { body: { collections: [] } },
  '/api/knowledge/documents': { body: { documents: [] } },
  '/api/knowledge/backends': { body: { backend: null } },
}
const knowledgeProps = { ...workspace, workspaceId: 'fixture-workspace', initialPath: [] }
export const KnowledgeEmpty: Story = { parameters: { localApi: knowledgeApi }, render: () => <KnowledgeWorkspace {...knowledgeProps} /> }
export const KnowledgeCreate: Story = { parameters: { localApi: knowledgeApi }, render: () => <KnowledgeWorkspace {...knowledgeProps} initialPath={['new']} /> }
export const KnowledgeUnavailable: Story = { render: () => <KnowledgeWorkspace {...knowledgeProps} knowledgeEnabled={false} /> }
export const KnowledgeError: Story = { render: () => <KnowledgeWorkspace {...knowledgeProps} /> }
export const KnowledgeLoading: Story = { parameters: { localApi: { '/api/knowledge/collections': { body: { collections: [] }, delay: 60000 }, '/api/knowledge/documents': { body: { documents: [] }, delay: 60000 }, '/api/knowledge/backends': { body: { backend: null }, delay: 60000 } } }, render: () => <KnowledgeWorkspace {...knowledgeProps} /> }
export const KnowledgeBackend: Story = { parameters: { localApi: knowledgeApi }, render: () => <KnowledgeWorkspace {...knowledgeProps} initialPath={['zero']} /> }
const backendProps = { ...workspace, sessionId: 'fixture-session', chatSessions: [], projectId: 'fixture-project', projectName: '演示项目', userId: 'fixture-user' }
export const DatabaseUnavailable: Story = { render: () => <ProjectSupabasePanel {...backendProps} embedded /> }
export const StudioUnavailable: Story = { render: () => <ProjectSupabaseStudioFrame sessionId="fixture-session" /> }
export const StudioLoading: Story = { parameters: { localApi: { '/api/chat/fixture-session/supabase/studio-session': { body: {}, delay: 60000 } } }, render: () => <ProjectSupabaseStudioFrame sessionId="fixture-session" /> }
export const EditorUnavailable: Story = { render: () => <CodeServerWorkbench chatSessionId="fixture-session" /> }
export const EditorLoading: Story = { parameters: { localApi: { '/api/code-server/sessions': { body: {}, delay: 60000 } } }, render: () => <CodeServerWorkbench chatSessionId="fixture-session" /> }
export const EditorFrame: Story = { parameters: { localApi: { '/api/code-server/sessions': { body: { session: { url: 'about:blank' } } } } }, render: () => <CodeServerWorkbench chatSessionId="fixture-session" /> }
export const BrowserUnavailable: Story = { render: () => <BrowserWorkbench chatSessionId="fixture-session" viewportMode="browser" /> }
export const BrowserMobileUnavailable: Story = { render: () => <BrowserWorkbench chatSessionId="fixture-session" viewportMode="mobile" /> }

import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { AuthPage } from '@/components/auth-page'
import { OrganizationSetup } from '@/components/organization-setup'
import { OrganizationDialog } from '@/components/organization-dialog'
import { NewProjectDialog } from '@/components/new-project-dialog'
import { AppWorkspace, Sidebar } from '@/components/app-workspace'
import { ProjectsWorkspace } from '@/components/projects-workspace'
import { OpenLinkHome } from '@/components/openlink-home'
import { PromptComposer } from '@/components/prompt-composer'
import { ChatCodePreview } from '@/components/chat-code-preview'
import { ZorkerLogo } from '@/components/zorker-logo'
import { workspace, project } from './fixtures/product'

const meta = { title: 'Product/Pages', parameters: { layout: 'fullscreen', nextjs: { appDirectory: true }, docs: { description: { component: '挂载真实业务组件；所有身份信息为演示数据，服务端操作只使用 Storybook mocks。' } } } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Login: Story = { render: () => <AuthPage mode="login" localRuntime /> }
export const Register: Story = { render: () => <AuthPage mode="register" localRuntime /> }
export const HostedLogin: Story = { render: () => <AuthPage mode="login" /> }
export const Organization: Story = { render: () => <div className="mx-auto max-w-md p-8"><OrganizationSetup showSkip /></div> }
function OrganizationModal() { const [open, setOpen] = useState(true); return <><button onClick={() => setOpen(true)}>组织工作区</button><OrganizationDialog open={open} onOpenChange={setOpen} /></> }
export const OrganizationOverlay: Story = { render: () => <OrganizationModal /> }
function ProjectModal() { const [open, setOpen] = useState(true); return <><button onClick={() => setOpen(true)}>创建项目</button><NewProjectDialog open={open} onOpenChange={setOpen} projects={[project]} workspaceSlug="storybook" /></> }
export const CreateProject: Story = { render: () => <ProjectModal /> }
export const Home: Story = { render: () => <AppWorkspace {...workspace} configuredModels={[]} defaultProject={project} chatSessions={[]} initialPrompt="" projects={[project]} workspaceSlug="storybook" /> }
export const MarketingHome: Story = { render: () => <OpenLinkHome user={null} composerContext={null} /> }
export const AnonymousComposer: Story = { render: () => <div className="p-12"><PromptComposer user={null} composerContext={null} /></div> }
export const ProjectsEmpty: Story = { render: () => <ProjectsWorkspace {...workspace} projects={[]} canManageProjects /> }
export const ProjectLifecycle: Story = { render: () => <ProjectsWorkspace {...workspace} projects={[project, ...(['queued', 'starting_vm', 'retry_wait', 'failed', 'stopped'] as const).map((phase, index) => ({ ...project, id: `fixture-${index}`, name: `项目 · ${phase}`, is_default: false, runtime_phase: phase, runtime_status: phase === 'failed' ? 'error' as const : phase === 'stopped' ? 'stopped' as const : 'provisioning' as const, status: 'waiting' as const }))]} canManageProjects /> }
export const ProjectsReadOnly: Story = { render: () => <ProjectsWorkspace {...workspace} projects={[project]} canManageProjects={false} /> }
function SidebarFixture() { const [collapsed, setCollapsed] = useState(false); const [themeMode, setTheme] = useState<'dark' | 'light' | 'system'>('dark'); return <div className="flex h-screen"><Sidebar {...workspace} collapsed={collapsed} mobileOpen={false} onToggle={() => setCollapsed(!collapsed)} onCloseMobile={() => {}} onThemeChange={setTheme} themeMode={themeMode} projects={[project]} /><main className="p-8">侧栏可折叠；工作区和账户菜单均可交互。</main></div> }
export const SidebarAndAccount: Story = { render: () => <SidebarFixture /> }
export const CodePreview: Story = { render: () => <div className="h-96"><ChatCodePreview path="src/app.ts" content={'export const title = "OpenLink"\n'} language="typescript" /></div> }
export const CodeStreaming: Story = { render: () => <div className="h-96"><ChatCodePreview path="src/app.ts" content={'export const title ='} language="typescript" streaming /></div> }
export const Brand: Story = { render: () => <div className="p-12"><ZorkerLogo /></div> }

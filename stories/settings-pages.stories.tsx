import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { PreferencesForm } from '@/components/settings/preferences-form'
import { SettingsShell } from '@/components/settings/settings-shell'
import { AiProvidersOverview } from '@/components/settings/ai-providers-overview'
import { EmbeddingProvidersOverview } from '@/components/settings/embedding-providers-overview'
import { ProviderConfigurationForm } from '@/components/settings/provider-configuration-form'
import { EmbeddingProviderConfigurationForm } from '@/components/settings/embedding-provider-configuration-form'
import { ProviderNavigation } from '@/components/settings/provider-navigation'
import { SkillsWorkspace } from '@/components/settings/skills-workspace'
import { ProviderBrand } from '@/components/settings/provider-logo'
import { CloudConnectionsSettings } from '@/components/settings/cloud-connections'
import { AI_PROVIDERS } from '@/lib/ai-providers'
import { EMBEDDING_PROVIDERS } from '@/lib/embedding-providers'
import { workspace, preferences } from './fixtures/product'

const meta = { title: 'Product/Settings', parameters: { layout: 'fullscreen', nextjs: { appDirectory: true }, docs: { description: { component: '真实设置组件，保存/测试连接动作已在 Storybook 中替换为本地 mocks，不写入账户配置。' } } }, decorators: [(Story) => <div className="min-h-screen p-8"><Story /></div>] } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Preferences: Story = { render: () => <PreferencesForm initial={preferences} /> }
export const Shell: Story = { render: () => <SettingsShell {...workspace} preferences={preferences}><PreferencesForm initial={preferences} /></SettingsShell> }
export const Providers: Story = { render: () => <AiProvidersOverview configurations={[]} /> }
export const Embeddings: Story = { render: () => <EmbeddingProvidersOverview configurations={[]} /> }
export const ProviderConfiguration: Story = { render: () => <ProviderConfigurationForm provider={AI_PROVIDERS[0]} configuration={null} models={[]} /> }
export const EmbeddingConfiguration: Story = { render: () => <EmbeddingProviderConfigurationForm provider={EMBEDDING_PROVIDERS[0]} configuration={null} /> }
export const ProviderSearch: Story = { render: () => <ProviderNavigation configurations={[]} /> }
export const EmbeddingSearch: Story = { render: () => <ProviderNavigation configurations={[]} mode="embedding" /> }
export const SkillsEmpty: Story = { render: () => <SkillsWorkspace skills={[]} /> }
const skill = { id: 'fixture-skill', slug: 'review', name: '代码审查', updatedAt: '2026-09-12T00:00:00Z', content: '---\nname: review\ndescription: Review scoped changes\n---\n\n检查代码与测试，禁止修改无关文件。' }
export const SkillEditor: Story = { render: () => <SkillsWorkspace skills={[skill]} currentSkill={skill} /> }
export const ProviderBrands: Story = { render: () => <div className="grid grid-cols-3 gap-6">{AI_PROVIDERS.map(provider => <ProviderBrand key={provider.id} provider={provider} />)}</div> }

const cloudConnectionId = '123e4567-e89b-42d3-a456-426614174000'
const cloudApi = {
  '/api/platform/connections': { body: { connections: [{ id: cloudConnectionId, issuer: 'https://auth.hydite.com', subject: 'yikewang@haokir.com', state: 'active' }] } },
  [`/api/platform/connections/${cloudConnectionId}`]: { body: { connected: true, subject: 'yikewang@haokir.com' } },
}
const revokingCloudApi = {
  '/api/platform/connections': { body: { connections: [{ id: cloudConnectionId, issuer: 'https://auth.hydite.com', subject: 'yikewang@haokir.com', state: 'revoking' }] } },
}
export const CloudAccountEmpty: Story = { parameters: { localApi: { '/api/platform/connections': { body: { connections: [] } } } }, render: () => <CloudConnectionsSettings loginEnabled={false} locale="zh-CN" /> }
export const CloudAccountConnected: Story = { parameters: { localApi: cloudApi }, render: () => <CloudConnectionsSettings loginEnabled locale="zh-CN" /> }
export const CloudAccountRevoking: Story = { parameters: { localApi: revokingCloudApi }, render: () => <CloudConnectionsSettings loginEnabled={false} locale="zh-CN" /> }
export const CloudAccountEnglish: Story = { parameters: { localApi: { '/api/platform/connections': { body: { connections: [] } } } }, render: () => <CloudConnectionsSettings loginEnabled locale="en-US" /> }

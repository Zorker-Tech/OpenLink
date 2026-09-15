import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { WorkspacePrompt } from '@/components/workspace-prompt'
import type { ProjectSummary } from '@/lib/projects'

const project: ProjectSummary = {
  id: 'runtime-hint-project', workspace_id: 'workspace', created_by: 'owner',
  name: 'Draft', slug: 'draft', kind: 'code', source_type: 'blank', source_url: null,
  description: '', status: 'waiting', runtime_status: 'provisioning', runtime_error: null,
  runtime_phase: 'queued', runtime_phase_updated_at: null, runtime_provisioning_attempts: 0,
  runtime_provisioning_next_attempt_at: null, runtime_provisioning_lease_expires_at: null,
  runtime_claimed: false, is_default: true, disk_mode: 'thin', execution_mode: 'local',
  ssh_host: null, ssh_port: null, ssh_user: null, ssh_remote_root: null,
  ssh_known_hosts: null, ssh_private_key_hint: null, created_at: '', updated_at: '',
}

function Fixture() {
  const [stage, setStage] = useState<'queued' | 'starting_vm' | 'ready'>('queued')
  return <div className="w-[700px] max-w-full">
    <WorkspacePrompt configuredModels={[]} defaultProject={{ ...project,
      runtime_phase: stage, runtime_status: stage === 'ready' ? 'ready' : 'provisioning',
      status: stage === 'ready' ? 'active' : 'waiting',
    }} initialPrompt="" projects={[]} workspaceSlug="workspace" />
    <div className="mt-8 flex gap-4">
      <button onClick={() => setStage('starting_vm')}>Start VM</button>
      <button onClick={() => setStage('ready')}>Ready</button>
    </div>
  </div>
}

const meta = {
  title: 'Product/Workspace Runtime Hint', component: WorkspacePrompt,
  parameters: { nextjs: { appDirectory: true } },
} satisfies Meta<typeof WorkspacePrompt>
export default meta
type Story = StoryObj<typeof meta>

export const RuntimeGateWithoutPromptHint: Story = {
  render: () => <Fixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole('textbox', { name: '描述你想创建的内容' })
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument()
    await expect(input).toBeDisabled()
    await expect(canvas.queryByText('查看状态详情')).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: 'Start VM' }))
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole('button', { name: 'Ready', exact: true }))
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument()
    await expect(input).toBeEnabled()
    await userEvent.type(input, '保留我的草稿')
    await userEvent.click(canvas.getByRole('button', { name: 'Start VM' }))
    await expect(input).toHaveValue('保留我的草稿')
    await expect(input).toBeDisabled()
  },
}

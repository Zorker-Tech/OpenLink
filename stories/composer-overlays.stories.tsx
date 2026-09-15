import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { useState } from 'react'

import { PromptInput, PromptInputBody } from '@/components/ai-elements/prompt-input'
import { ChatConfirmationDock } from '@/components/chat-confirmation-dock'
import { PromptAddMenu } from '@/components/prompt-add-menu'
import type { AccessMode } from '@/lib/chat-sessions'
import type { CodexComposerResources, RuntimeComposerResources } from '@/lib/composer-resources'

const runtimeResources: RuntimeComposerResources = {
  agent: 'codex',
  source: 'Codex App Server',
  accessMode: 'restricted',
  mcpServers: [{ id: 'figma', name: 'Figma' }],
  imageGeneration: false,
  commands: [],
}

const codexResources: CodexComposerResources = {
  skills: [{ id: 'skill-review', name: 'review', description: 'Review changes', source: 'builtin' }],
  plugins: [
    {
      pluginId: 'installed-plugin',
      name: 'installed',
      marketplaceName: 'OpenAI',
      version: '1.0.0',
      installed: true,
      enabled: true,
      installPolicy: 'AVAILABLE',
      authPolicy: 'NONE',
      displayName: 'Installed Plugin',
      shortDescription: 'Already available in this runtime.',
      longDescription: 'An installed plugin used to verify native mention insertion.',
      developerName: 'OpenAI',
      category: 'Developer Tools',
      capabilities: ['skills'],
      homepage: null,
      repository: null,
      license: 'MIT',
      keywords: ['installed'],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompts: [],
    },
    {
      pluginId: 'available-plugin',
      name: 'available',
      marketplaceName: 'OpenAI',
      version: '2.0.0',
      installed: false,
      enabled: false,
      installPolicy: 'AVAILABLE',
      authPolicy: 'NONE',
      displayName: 'Available Plugin',
      shortDescription: 'Available from the current marketplace.',
      longDescription: 'A not-yet-installed plugin used to exercise the details and install flow.',
      developerName: 'OpenAI',
      category: 'Developer Tools',
      capabilities: ['skills', 'mcp'],
      homepage: null,
      repository: null,
      license: 'MIT',
      keywords: ['available'],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompts: ['Use the available plugin'],
    },
  ],
}

function AddMenuFixture({ installFails = false }: { installFails?: boolean }) {
  const [accessMode, setAccessMode] = useState<AccessMode>('restricted')
  const [result, setResult] = useState('none')
  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-xl">
        <p className="mb-4 text-sm text-[var(--app-muted)]" role="status">Result: {result}. Access: {accessMode}.</p>
        <PromptInput className="w-full" onSubmit={() => undefined}>
          <PromptInputBody>
            <PromptAddMenu
              accessMode={accessMode}
              agent="codex"
              attachmentsEnabled
              codexResources={codexResources}
              customInstructions="Keep runtime claims evidence-backed."
              onAccessModeChange={(mode) => { setAccessMode(mode); setResult(`access:${mode}`) }}
              onInsertText={(text) => setResult(`insert:${text.trim()}`)}
              onInstallPlugin={async (pluginId) => {
                if (installFails) throw new Error('Worker 未确认插件可用')
                setResult(`install:${pluginId}`)
              }}
              runtimeResources={{ ...runtimeResources, accessMode }}
              variant="session"
            />
          </PromptInputBody>
        </PromptInput>
      </div>
    </main>
  )
}

function ConfirmationFixture({ resolveFails = false }: { resolveFails?: boolean }) {
  const [result, setResult] = useState('none')
  return (
    <main className="flex min-h-screen items-end justify-center bg-[var(--app-background)] p-12 text-[var(--app-foreground)]">
      <div className="w-full max-w-2xl">
        <p className="mb-4 text-sm text-[var(--app-muted)]" role="status">Resolved: {result}</p>
        <ChatConfirmationDock
          onResolve={async (id, approved, value) => {
            if (resolveFails) throw new Error('确认服务暂时不可用')
            setResult(`${id}:${approved ? 'approved' : 'rejected'}:${value ?? ''}`)
          }}
          requests={[
            { id: 'approval', title: '写入 workspace', message: '修改 src/app.tsx', inputKind: 'confirm', confirmationKind: 'approval' },
            { id: 'choice', title: '选择环境', options: ['Preview', 'Production'], inputKind: 'select', confirmationKind: 'question' },
            { id: 'reason', title: '补充说明', inputKind: 'input', confirmationKind: 'question' },
          ]}
        />
      </div>
    </main>
  )
}

const meta = {
  title: 'Product/Composer Overlays',
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

async function openAvailablePlugin(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  const page = within(canvasElement.ownerDocument.body)
  await userEvent.click(canvas.getByRole('button', { name: '打开添加菜单' }))
  await page.findByRole('menu')
  await waitFor(() => expect(page.getByRole('menu')).toBeVisible())
  page.getByRole('menuitem', { name: /Plugins/ }).focus()
  await userEvent.keyboard('{ArrowRight}')
  const managePlugins = await page.findByRole('menuitem', { name: '管理 Codex 插件' })
  managePlugins.focus()
  await userEvent.keyboard('{Enter}')
  const dialog = await page.findByRole('dialog', { name: 'Codex 插件市场' })
  await userEvent.click(within(dialog).getByRole('button', { name: /Available Plugin/ }))
  return { canvas, dialog, page }
}

export const AddMenu: Story = {
  render: () => <AddMenuFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole('button', { name: '打开添加菜单' }))
    await page.findByRole('menu')
    await waitFor(() => expect(page.getByRole('menu')).toBeVisible())

    page.getByRole('menuitem', { name: /权限/ }).focus()
    await userEvent.keyboard('{ArrowRight}')
    const askItem = await page.findByRole('menuitem', { name: '询问（写操作确认）' })
    askItem.focus()
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByRole('status')).toHaveTextContent('Access: ask')
    // Wait for the permission submenu's close transition before reopening
    // the root picker; otherwise two accessible menus coexist transiently.
    await waitFor(() => expect(page.queryAllByRole('menu')).toHaveLength(0))

    const { dialog } = await openAvailablePlugin(canvasElement)
    await userEvent.click(within(dialog).getByRole('button', { name: '安装插件' }))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(page.queryByRole('dialog', { name: 'Codex 插件市场' })).not.toBeInTheDocument())
    const addButton = canvas.getByRole('button', { name: '打开添加菜单' })
    if (addButton.getAttribute('aria-expanded') === 'true') await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('install:available-plugin'))
  },
}

export const PluginInstallError: Story = {
  render: () => <AddMenuFixture installFails />,
  play: async ({ canvasElement }) => {
    const { dialog } = await openAvailablePlugin(canvasElement)
    await userEvent.click(within(dialog).getByRole('button', { name: '安装插件' }))
    const alert = await within(dialog).findByRole('alert')
    await expect(alert).toHaveTextContent('Worker 未确认插件可用')
    await expect(within(dialog).getByRole('button', { name: '安装插件' })).toBeEnabled()
  },
}

export const Confirmations: Story = {
  render: () => <ConfirmationFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('alert', { name: '审批：写入 workspace' })).toBeVisible()
    await expect(canvas.getByRole('group', { name: '问题：选择环境' })).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: '允许' }))
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('approval:approved'))
    await userEvent.click(canvas.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('choice:approved:Preview'))
    await userEvent.type(canvas.getByRole('textbox', { name: '补充说明' }), '需要保留历史')
    await userEvent.click(canvas.getAllByRole('button', { name: '提交' }).at(-1)!)
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('reason:approved:需要保留历史'))
  },
}

export const ConfirmationError: Story = {
  render: () => <ConfirmationFixture resolveFails />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole('textbox', { name: '补充说明' })
    await userEvent.type(input, '保留这段输入')
    await userEvent.click(canvas.getAllByRole('button', { name: '提交' }).at(-1)!)
    const alert = await canvas.findByText('确认服务暂时不可用')
    await expect(alert).toHaveAttribute('role', 'alert')
    await expect(alert).toHaveTextContent('确认服务暂时不可用')
    await expect(input).toHaveValue('保留这段输入')
    await expect(canvas.getAllByRole('button', { name: '提交' }).at(-1)!).toBeEnabled()
  },
}

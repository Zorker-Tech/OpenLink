import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, within } from 'storybook/test'
import { useState } from 'react'

import { AgentPromptTextarea, type AgentPromptSuggestion } from '@/components/agent-prompt-textarea'
import { PromptInput, PromptInputBody } from '@/components/ai-elements/prompt-input'

const suggestions: AgentPromptSuggestion[] = [
  {
    id: 'review',
    kind: 'command',
    command: undefined,
    label: '/review',
    description: 'Review uncommitted changes',
    group: 'Codex',
    insertText: '/review ',
  },
  {
    id: 'fork',
    kind: 'command',
    command: undefined,
    label: '/fork',
    description: 'Fork this task',
    group: 'Codex',
    insertText: '',
    action: 'fork',
  },
  {
    id: 'permission-open',
    kind: 'command',
    command: undefined,
    label: '/permissions open',
    description: 'Unavailable while a turn is running',
    group: 'Permissions',
    insertText: '',
    action: 'permissions:open',
    disabled: true,
  },
]

function PromptFixture({ allDisabled = false }: { allDisabled?: boolean }) {
  const [value, setValue] = useState('')
  const [lastAction, setLastAction] = useState('none')
  const visibleSuggestions = allDisabled
    ? suggestions.map((item) => ({ ...item, disabled: true }))
    : suggestions

  return (
    <main className="flex min-h-screen w-full items-end justify-center bg-[var(--app-background)] p-8 text-[var(--app-foreground)]">
      <div className="w-full max-w-[720px]">
        <p className="mb-3 text-xs text-[var(--app-muted)]" role="status">
          Last action: {lastAction}. Use Arrow keys, Enter, Tab and Escape to inspect focus behavior.
        </p>
        <PromptInput
          className="w-full [&>[data-slot=input-group]]:overflow-visible! [&>[data-slot=input-group]]:rounded-xl [&>[data-slot=input-group]]:border-[var(--app-control-border)] [&>[data-slot=input-group]]:bg-[var(--app-surface)]"
          onSubmit={() => undefined}
        >
          <PromptInputBody>
            <AgentPromptTextarea
              aria-label="Agent prompt"
              autoFocus
              commandPaletteLabel="Codex commands"
              onAction={setLastAction}
              onValueChange={setValue}
              placeholder="Type / for commands"
              suggestions={visibleSuggestions}
              value={value}
            />
          </PromptInputBody>
        </PromptInput>
      </div>
    </main>
  )
}

const meta = {
  title: 'Product/Agent Prompt Textarea',
  component: AgentPromptTextarea,
  parameters: { a11y: { test: 'error' }, layout: 'fullscreen' },
} satisfies Meta<typeof AgentPromptTextarea>

export default meta
type Story = StoryObj<typeof meta>

export const CommandPicker: Story = {
  render: () => <PromptFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const combobox = canvas.getByRole('combobox', { name: 'Agent prompt' })
    const textbox = canvas.getByRole('textbox', { name: 'Agent prompt' })
    await userEvent.type(textbox, '/')

    const options = await canvas.findAllByRole('option')
    await expect(combobox).toHaveAttribute('aria-expanded', 'true')
    await expect(options).toHaveLength(3)
    await expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await expect(options[2]).toBeDisabled()

    await userEvent.keyboard('{ArrowDown}')
    await expect(options[1]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}')
    await expect(options[0]).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Enter}')
    await expect(combobox).toHaveAttribute('aria-expanded', 'false')
    await expect(textbox).toHaveValue('/review ')
    await expect(textbox).toHaveFocus()
  },
}

export const DisabledCommandFocusExit: Story = {
  render: () => <PromptFixture allDisabled />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const combobox = canvas.getByRole('combobox', { name: 'Agent prompt' })
    const textbox = canvas.getByRole('textbox', { name: 'Agent prompt' })
    await userEvent.type(textbox, '/')

    const options = await canvas.findAllByRole('option')
    await expect(options).toHaveLength(3)
    for (const option of options) await expect(option).toBeDisabled()
    await expect(textbox).not.toHaveAttribute('aria-activedescendant')

    await userEvent.keyboard('{Enter}')
    await expect(textbox).toHaveValue('/')
    await expect(combobox).toHaveAttribute('aria-expanded', 'true')

    await userEvent.keyboard('{Tab}')
    await expect(combobox).toHaveAttribute('aria-expanded', 'false')
    await expect(textbox).not.toHaveFocus()
  },
}

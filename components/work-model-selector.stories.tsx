import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, within, waitFor } from 'storybook/test'
import { ArrowUp, Mic, Plus } from 'lucide-react'
import { WorkModelSelector, type WorkModelOption, type WorkModelSelection, type WorkModelSelectorProps } from './work-model-selector'

// Reference fixtures only, not a declaration of provider availability or billing capability.
const efforts = [
  { id: 'minimal', label: '最少' }, { id: 'low', label: '轻度' },
  { id: 'medium', label: '标准' }, { id: 'high', label: '深度' },
  { id: 'xhigh', label: '更深' }, { id: 'max', label: '最高' },
] as const
const models: WorkModelOption[] = [
  { id: 'default', label: 'Default', description: 'Recommended set of models' },
  ...['GPT-6 Astra', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5'].map(label => ({
    id: label, label, efforts, defaultEffort: 'low', supportsFastMode: true,
  })),
]
const initial: WorkModelSelection = { modelId: 'GPT-5.6 Sol', effort: 'low', fast: false }

function Controlled(args: WorkModelSelectorProps) {
  const [value, setValue] = useState(args.value)
  useEffect(() => setValue(args.value), [args.value])
  return <WorkModelSelector {...args} value={value} onValueChange={next => { setValue(next); args.onValueChange(next) }} />
}

function Composer({ args, detail = false }: { args: WorkModelSelectorProps; detail?: boolean }) {
  return <div style={{ width: 'min(768px, calc(100vw - 32px))', paddingTop: 340 }}>
    {!detail ? <h2 style={{ textAlign: 'center', marginBottom: 32, fontSize: 24, fontWeight: 400 }}>我们该做什么？</h2> : null}
    <div style={{ background: 'var(--app-active, #212121)', borderRadius: 28, padding: '8px', display: 'flex', flexDirection: detail ? 'row' : 'column', alignItems: detail ? 'center' : 'stretch', gap: 8 }}>
      {detail ? <Plus aria-hidden size={20} style={{ margin: 8, flexShrink: 0 }} /> : null}
      <textarea aria-label="演示输入框" placeholder="处理任何事务" rows={detail ? 1 : 2} style={{ resize: 'none', background: 'transparent', padding: detail ? '6px 0' : '8px 12px', border: 0, outline: 'none', flex: 1, minWidth: 0, fontSize: 16 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
        {!detail ? <Plus aria-hidden size={20} style={{ margin: 8, marginRight: 'auto' }} /> : null}
        <Controlled {...args} /><Mic aria-hidden size={20} />
        <span aria-hidden style={{ display: 'grid', placeItems: 'center', borderRadius: '50%', width: 36, height: 36, background: 'var(--app-hover, #353535)' }}><ArrowUp size={20} /></span>
      </div>
    </div>
  </div>
}

const meta = {
  title: 'Product/Work Model Selector', component: WorkModelSelector,
  args: { models, value: initial, onValueChange: fn() },
  render: args => <div style={{ width: 'min(600px, calc(100vw - 32px))', minHeight: 420, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}><Controlled {...args} /></div>,
  globals: { theme: 'dark' },
  parameters: { layout: 'centered', docs: { description: { component: '独立的受控工作模式模型选择器。仅在 Storybook 挂载；不读取账号、模型服务或运行时。模型、推理档位和快速模式能力由调用方传入。参考 Figma 112:1044 / 112:500；档位文案为可替换演示数据。' } } },
} satisfies Meta<typeof WorkModelSelector>
export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}
export const HomeComposer: Story = { render: args => <Composer args={args} /> }
export const ConversationComposer: Story = { render: args => <Composer args={args} detail /> }
export const ModelList: Story = { args: { initialView: 'models', defaultOpen: true, labels: { selectModel: 'Select model' } } }
export const EffortControls: Story = { args: { defaultOpen: true, models: models.map(model => ({ ...model, efforts: model.efforts?.map(effort => ({ ...effort, label: effort.id === 'low' ? 'Light' : effort.label })) })) } }
export const Light: Story = { globals: { theme: 'light' }, args: { defaultOpen: true } }
export const Disabled: Story = { args: { disabled: true } }
export const Empty: Story = { args: { models: [], value: { modelId: '' }, defaultOpen: true } }
export const Narrow: Story = { parameters: { viewport: { defaultViewport: 'mobile1' } }, render: args => <div style={{ width: 280, minHeight: 340, display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end' }}><Controlled {...args} /></div> }

export const SelectThenTune: Story = {
  args: { initialView: 'models' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole('button', { name: /选择模型，当前/ })
    await userEvent.click(trigger)
    await userEvent.click(await body.findByRole('button', { name: 'GPT-5.6 Terra' }))
    const slider = await body.findByRole('slider', { name: '推理强度' })
    await expect(slider).toHaveAttribute('aria-valuetext', '轻度')
    slider.focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect(slider).toHaveAttribute('aria-valuetext', '标准')
    await expect(trigger).toHaveTextContent('GPT-5.6 Terra标准')
    await userEvent.click(body.getByRole('button', { name: '启用快速模式' }))
    await expect(args.onValueChange).toHaveBeenLastCalledWith({ modelId: 'GPT-5.6 Terra', effort: 'medium', fast: true })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(body.queryByRole('slider')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}

export const KeyboardAndDefault: Story = {
  args: { initialView: 'models' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole('button', { name: /选择模型，当前/ })
    await userEvent.click(trigger)
    const sol = await body.findByRole('button', { name: 'GPT-5.6 Sol' })
    sol.focus()
    await userEvent.keyboard('{Home}{Enter}')
    await expect(args.onValueChange).toHaveBeenLastCalledWith({ modelId: 'default', effort: undefined, fast: false })
    await expect(trigger).toHaveTextContent('Default')
    await waitFor(() => expect(body.queryByRole('group', { name: '选择模型' })).not.toBeInTheDocument())
  },
}

export const BackToModels: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole('button', { name: /选择模型，当前/ }))
    await userEvent.click(await body.findByRole('button', { name: '选择模型' }))
    await expect(await body.findByRole('button', { name: 'GPT-5.6 Sol' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.keyboard('{Escape}')
  },
}

export const MotionStressTest: Story = {
  args: { initialView: 'models' },
  parameters: { docs: { description: { story: '连续切换、关闭后重开及动画最终尺寸验收。系统开启减少动态效果时自动停用位移和过渡。' } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole('button', { name: /选择模型，当前/ })
    await userEvent.click(trigger)
    for (const name of ['GPT-6 Astra', 'GPT-5.6 Terra', 'GPT-5.6 Sol']) {
      await userEvent.click(await body.findByRole('button', { name }))
      await expect(await body.findByRole('slider')).toHaveAttribute('aria-valuetext', '轻度')
      await userEvent.click(body.getByRole('button', { name: '选择模型' }))
    }
    await waitFor(() => expect(Math.round(body.getByRole('dialog').getBoundingClientRect().height)).toBe(291))
    await userEvent.click(body.getByRole('button', { name: 'GPT-5.6 Sol' }))
    await waitFor(() => expect(Math.round(body.getByRole('dialog').getBoundingClientRect().height)).toBe(88))
    await userEvent.click(body.getByRole('button', { name: '选择模型' }))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(trigger)
    await expect(await body.findByRole('button', { name: 'GPT-5.6 Sol' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}

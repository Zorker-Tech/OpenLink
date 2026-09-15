import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { App as ThinkingPlayground } from '@/components/thinking/demo/App'
import { App as SimpleThinkingDemo } from '@/components/thinking/demo/SimpleApp'
import '@/components/thinking/demo/styles.css'
import '@/components/thinking/demo/simple.css'

const meta = { title: 'Product/Thinking Demos', parameters: { layout: 'fullscreen' } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Playground: Story = { render: () => <ThinkingPlayground /> }
export const Simple: Story = { render: () => <SimpleThinkingDemo /> }

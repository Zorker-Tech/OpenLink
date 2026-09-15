import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { Canvas } from '@/components/ai-elements/canvas'
import { Node, NodeHeader, NodeTitle, NodeContent } from '@/components/ai-elements/node'
import { Edge } from '@/components/ai-elements/edge'
import { Connection } from '@/components/ai-elements/connection'
import { Controls } from '@/components/ai-elements/controls'
import { Panel } from '@/components/ai-elements/panel'
import { Toolbar } from '@/components/ai-elements/toolbar'

function AgentNode({ data }: { data: { label: string } }) { return <Node handles={{ source: true, target: true }}><NodeHeader><NodeTitle>{data.label}</NodeTitle></NodeHeader><NodeContent>拖动节点或连接端口</NodeContent><Toolbar><button>节点操作</button></Toolbar></Node> }
const nodeTypes = { agent: AgentNode }
const edgeTypes = { animated: Edge.Animated, temporary: Edge.Temporary }
const meta = { title: 'AI Elements/Workflow Canvas', parameters: { layout: 'fullscreen' } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
export const Connected: Story = { render: () => <div className="h-[600px]"><Canvas nodeTypes={nodeTypes} edgeTypes={edgeTypes} connectionLineComponent={Connection} defaultNodes={[{ id: 'a', type: 'agent', position: { x: 0, y: 80 }, data: { label: '规划' } }, { id: 'b', type: 'agent', position: { x: 500, y: 80 }, data: { label: '执行' } }]} defaultEdges={[{ id: 'ab', source: 'a', target: 'b', type: 'animated' }]}><Controls /><Panel position="top-left">Agent Workflow</Panel></Canvas></div> }
export const Empty: Story = { render: () => <div className="h-[420px]"><Canvas defaultNodes={[]} defaultEdges={[]}><Controls /><Panel position="top-left">暂无节点</Panel></Canvas></div> }

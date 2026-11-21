'use client'

import { Fragment, memo, useMemo } from 'react'
import { defaultRehypePlugins } from 'streamdown'
import { MessageResponse, type MessageResponseProps } from '@/components/ai-elements/message'
import { createMessageMentionMatcher, splitMessagePrompt } from '@/lib/bot-message-content'
import type { BotGroupMemberSummary } from '@/lib/bot-types'

type MarkdownNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  value?: string
  children?: MarkdownNode[]
}

type MessageContentProps = {
  content: string
  members?: readonly BotGroupMemberSummary[]
}

const EMPTY_MEMBERS: readonly BotGroupMemberSummary[] = []

function element(tagName: string, properties: Record<string, unknown>, children: MarkdownNode[]): MarkdownNode {
  return { type: 'element', tagName, properties, children }
}

function blockKind(node: MarkdownNode) {
  if (node.tagName === 'table') return 'table'
  if (node.tagName === 'pre') return 'code'
  if (node.tagName === 'p' && node.children?.length === 1 && node.children[0]?.tagName === 'img') return 'media'
  return null
}

function messageBlocks(matchMentions: ReturnType<typeof createMessageMentionMatcher>) {
  function annotate(nodes: MarkdownNode[]): MarkdownNode[] {
    return nodes.flatMap(node => {
      if (node.type === 'text' && node.value) {
        return matchMentions(node.value).map(part => part.kind === 'mention'
          ? element('span', { dataBotMention: part.id }, [{ type: 'text', value: part.value }])
          : { type: 'text', value: part.value })
      }
      if (node.children && !['a', 'code', 'pre', 'math', 'svg'].includes(node.tagName ?? '')) {
        node.children = annotate(node.children)
      }
      return [node]
    })
  }

  return () => (tree: unknown) => {
    const root = tree as { children: MarkdownNode[] }
    const blocks: MarkdownNode[] = []
    let prose: MarkdownNode[] = []
    const addProse = () => {
      if (!prose.length) return
      blocks.push(element('div', { className: ['bot-markdown-prose'] }, annotate(prose)))
      prose = []
    }
    for (const node of root.children) {
      const kind = blockKind(node)
      if (kind) {
        addProse()
        blocks.push(element('div', { className: [`bot-markdown-${kind}`] }, kind === 'table' ? annotate([node]) : [node]))
      } else if (node.type !== 'text' || node.value?.trim()) {
        prose.push(node)
      }
    }
    addProse()
    root.children = blocks
  }
}

function Mention({ member, label }: {
  member: BotGroupMemberSummary
  label: string
}) {
  return (
    <span className="bot-message-mention">
      <img alt="" className="bot-message-mention-avatar" decoding="async" height={14} loading="lazy" src={`/api/bots/${encodeURIComponent(member.id)}/avatar?v=${encodeURIComponent(member.updatedAt)}`} width={14} />
      {label}
    </span>
  )
}

export const BotMarkdown = memo(function BotMarkdown({ content, members = EMPTY_MEMBERS }: MessageContentProps) {
  const { components, rehypePlugins } = useMemo(() => {
    const byId = new Map(members.map(member => [member.id, member]))
    const components: MessageResponseProps['components'] = {
      span: ({ node, children, ...props }) => {
        const id = node?.properties?.dataBotMention
        const member = typeof id === 'string' ? byId.get(id) : undefined
        return member && typeof children === 'string'
          ? <Mention label={children} member={member} />
          : <span {...props}>{children}</span>
      },
    }
    const rehypePlugins: MessageResponseProps['rehypePlugins'] = [
      ...Object.values(defaultRehypePlugins), messageBlocks(createMessageMentionMatcher(members)),
    ]
    return { components, rehypePlugins }
  }, [members])

  return (
    <MessageResponse
      className="zbd-app-markdown bot-markdown-root"
      components={components}
      flattenTables={false}
      lineNumbers
      mode="static"
      rehypePlugins={rehypePlugins}
    >
      {content}
    </MessageResponse>
  )
})

export const BotPrompt = memo(function BotPrompt({ content, members = EMPTY_MEMBERS }: MessageContentProps) {
  const matcher = useMemo(() => createMessageMentionMatcher(members), [members])
  const byId = useMemo(() => new Map(members.map(member => [member.id, member])), [members])
  return (
    <div className="bot-prompt-text">
      {splitMessagePrompt(content, matcher).map((part, index) => {
        if (part.kind === 'link') {
          return <a href={part.value} key={index} rel="noreferrer" target="_blank">{part.value}</a>
        }
        const member = part.kind === 'mention' ? byId.get(part.id) : undefined
        return member
          ? <Mention key={index} label={part.value} member={member} />
          : <Fragment key={index}>{part.value}</Fragment>
      })}
    </div>
  )
})

'use client'

import { defaultRehypePlugins } from 'streamdown'
import { MessageResponse, type MessageResponseProps } from '@/components/ai-elements/message'

type MarkdownNode = {
  type: string
  tagName?: string
  properties?: { className: string[] }
  value?: string
  children?: MarkdownNode[]
}

// Split top-level tables from prose while preserving the parser's structure
// for code, lists, and quotes.
function groupBotMarkdown() {
  return (tree: unknown) => {
    const root = tree as { children: MarkdownNode[] }
    const groups: MarkdownNode[] = []
    let prose: MarkdownNode[] = []
    const wrap = (className: string, children: MarkdownNode[]): MarkdownNode => ({
      type: 'element', tagName: 'div', properties: { className: [className] }, children,
    })

    for (const node of root.children) {
      if (node.type === 'element' && node.tagName === 'table') {
        if (prose.length) groups.push(wrap('bot-markdown-prose', prose))
        groups.push(wrap('bot-markdown-table', [node]))
        prose = []
      } else if (prose.length || node.type !== 'text' || node.value?.trim()) {
        prose.push(node)
      }
    }
    if (prose.length) groups.push(wrap('bot-markdown-prose', prose))
    root.children = groups
  }
}

const rehypePlugins: MessageResponseProps['rehypePlugins'] = [
  ...Object.values(defaultRehypePlugins), groupBotMarkdown,
]

export function BotMarkdown({ content }: { content: string }) {
  return (
    <MessageResponse
      className="zbd-app-markdown bot-markdown-root"
      flattenTables={false}
      lineNumbers
      mode="static"
      rehypePlugins={rehypePlugins}
    >
      {content}
    </MessageResponse>
  )
}

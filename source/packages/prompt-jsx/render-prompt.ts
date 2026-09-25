/**
 * Rendering a prompt tree into what a model receives.
 *
 * Two renderings come out of one tree. `renderToMessages` produces the conversation: the role
 * components become messages, and everything else is content inside them. `renderContent` produces
 * the text of one message, and that is where the layout rules live — paragraphs are separated by a
 * blank line, headings become markdown, lists keep their nesting with indentation, `<pre>` keeps its
 * whitespace, and a section becomes an XML-ish tag whose name comes from its title. The same tree can
 * therefore serve both a chat-completions shape and a plain-text prompt without being written twice.
 */

import { builtinComponents } from "./components.ts"
import type { PromptElement, PromptNode, PromptProps } from "./element.ts"

export interface PromptMessage {
  readonly role: string
  readonly content: string
  readonly name?: unknown
  readonly toolCallId?: unknown
}

export interface RenderOptions {
  readonly components?: Readonly<Record<string, (props: PromptProps) => PromptNode>> | undefined
}

interface Paragraph {
  readonly content: string
  readonly isSection: boolean
}

type ComponentMap = Readonly<Record<string, (props: PromptProps) => PromptNode>>

function isElement(value: PromptNode): value is PromptElement {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "type" in value
}

/** Tags that carry structure rather than content: they are rendered inside a message, not as one. */
const LAYOUT_TAGS = new Set(["p", "section", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "x", "pre", "br"])
const LIST_MARKER_WIDTH = 3

class RenderContext {
  readonly metadata: Record<string, unknown> = {}
  private readonly components: ComponentMap

  constructor(options: RenderOptions) {
    this.components = Object.assign({}, builtinComponents, options.components)
  }

  renderToMessages(node: PromptNode): PromptMessage[] {
    if (node == null || typeof node === "boolean") return []
    if (typeof node === "string" || typeof node === "number") return [{ role: "user", content: String(node) }]
    if (Array.isArray(node)) return node.flatMap(child => this.renderToMessages(child))
    return this.renderElement(node)
  }

  private renderElement(element: PromptElement): PromptMessage[] {
    if (typeof element.type === "function") return this.renderToMessages(element.type(element.props))
    if (typeof element.type === "string") return this.renderIntrinsicElement(element.type, element.props)
    throw new Error(`Unknown element type: ${String(element.type)}`)
  }

  private renderIntrinsicElement(type: string, props: PromptProps): PromptMessage[] {
    if (type === "Fragment") return this.renderToMessages(props.children)
    if (LAYOUT_TAGS.has(type)) return []
    const content = this.renderContent(props.children)
    const named = props.name ? { name: props.name } : {}
    switch (type) {
      case "System": return [{ role: "system", content, ...named }]
      case "User": return [{ role: "user", content, ...named }]
      case "Assistant": return [{ role: "assistant", content, ...named }]
      case "Tool": return [{ role: "tool", content, toolCallId: props.tool_call_id, ...named }]
      default: {
        const component = this.components[type]
        if (component !== undefined) return this.renderToMessages(component(props))
        throw new Error(`Unknown component type: ${type}`)
      }
    }
  }

  renderContent(children: PromptNode): string {
    if (children == null || typeof children === "boolean") return ""
    if (typeof children === "string" || typeof children === "number") return String(children)
    if (Array.isArray(children)) return this.renderParagraphAwareContent(children)
    return this.renderContentNode(children)
  }

  private renderContentNode(node: PromptNode): string {
    if (node == null || typeof node === "boolean") return ""
    if (typeof node === "string" || typeof node === "number") return String(node)
    if (Array.isArray(node)) return this.renderParagraphAwareContent(this.flattenNodes(node))
    const element = node
    if (typeof element.type === "function") return this.renderContent(element.type(element.props))
    switch (element.type) {
      case "p":
      case "Fragment":
        return this.renderContent(element.props.children)
      case "br":
        return "\n"
      case "li":
        return `- ${this.renderContent(element.props.children)}`
      case "pre":
        return this.renderPreContent(element.props.children)
      case "x":
        return this.renderTaggedElement(element.props)
      case "section":
        return this.renderSection(element.props)
      case "ul":
        return this.renderList(element.props.children, "unordered")
      case "ol":
        return this.renderList(element.props.children, "ordered")
      default:
        if (/^h[1-6]$/.test(element.type)) {
          return this.formatHeading(element.type, this.renderContent(element.props.children))
        }
        return this.renderToMessages(element).map(message => message.content).join("\n")
    }
  }

  /**
   * Inline content collects into paragraphs; block content ends the paragraph it interrupts. Two
   * paragraphs are separated by a blank line unless the previous one already ends with newlines.
   */
  private renderParagraphAwareContent(nodes: PromptNode[]): string {
    const paragraphs: Paragraph[] = []
    let inline: string[] = []
    const flushInline = (): void => {
      if (inline.length === 0) return
      const content = inline.join("")
      if (content.trim()) paragraphs.push({ content: this.normalizeWhitespace(content), isSection: false })
      else if (content.includes("\n")) paragraphs.push({ content, isSection: false })
      inline = []
    }

    for (const node of this.flattenNodes(nodes)) {
      if (!isElement(node)) {
        const rendered = this.renderContentNode(node)
        if (rendered !== null && rendered !== undefined) inline.push(rendered)
        continue
      }
      const element = node
      if (typeof element.type === "function") {
        const resolved = element.type(element.props)
        if (this.isBlockNode(resolved)) {
          flushInline()
          const content = this.renderContentNode(resolved)
          if (content.trim()) paragraphs.push({ content: content.trim(), isSection: this.isSectionNode(resolved) })
        } else {
          for (const child of this.flattenNodes(Array.isArray(resolved) ? resolved : [resolved])) {
            const rendered = this.renderContentNode(child)
            if (rendered) inline.push(rendered)
          }
        }
        continue
      }
      if (this.isBlockTag(element.type)) {
        flushInline()
        const content = this.renderContentNode(element)
        const isPre = element.type === "pre"
        const finalContent = isPre ? content : content.trim()
        if (finalContent || isPre) paragraphs.push({ content: finalContent, isSection: element.type === "section" })
        continue
      }
      const rendered = this.renderContentNode(node)
      if (rendered !== null && rendered !== undefined) inline.push(rendered)
    }
    flushInline()

    let result = paragraphs.length > 0 ? paragraphs[0]?.content ?? "" : ""
    for (let index = 1; index < paragraphs.length; index++) {
      const previous = paragraphs[index - 1] as Paragraph
      const current = paragraphs[index] as Paragraph
      const currentIsOnlyNewlines = !current.content.trim()
      const previousEndsWithNewline = Boolean(previous.content.trim()) && previous.content.endsWith("\n")
      if (currentIsOnlyNewlines || previousEndsWithNewline) result += current.content
      else result += `\n\n${current.content}`
    }
    return result.replace(/^\n+/, "").replace(/\n+$/, "")
  }

  private renderList(children: PromptNode, kind: "ordered" | "unordered", indent = 0, baseIndentWidth = 0): string {
    if (children == null) return ""
    const items: string[] = []
    const indentString = " ".repeat(baseIndentWidth)
    const markerWidth = kind === "ordered" ? LIST_MARKER_WIDTH : 2
    let itemNumber = 1
    for (const child of this.flattenListChildren(Array.isArray(children) ? children : [children])) {
      if (!isElement(child) || child.type !== "li") {
        const rendered = this.renderContentNode(child)
        if (rendered.trim()) items.push(indentString + rendered.trim())
        continue
      }
      const { textContent, nestedLists } = this.extractListItem(
        child.props.children,
        indent + 1,
        baseIndentWidth + markerWidth,
      )
      if (!textContent.trim() && nestedLists.length === 0) continue
      const marker = kind === "ordered" ? `${itemNumber}. ` : "- "
      if (textContent.trim()) {
        items.push(`${indentString}${marker}${textContent.trim()}`)
        items.push(...nestedLists)
      } else if (nestedLists.length > 0 && kind === "unordered") {
        // An unordered item with no text of its own has no marker to place: its nested list already
        // carries the indentation the nested call added.
        items.push(...nestedLists)
      } else if (nestedLists.length > 0) {
        // An ordered item keeps its number on the first line of what it nested.
        const combined = nestedLists.join("\n")
        const firstNewline = combined.indexOf("\n")
        const totalIndent = baseIndentWidth + markerWidth
        if (firstNewline === -1) {
          items.push(`${indentString}${marker}${combined.trimStart()}`)
        } else {
          items.push(`${indentString}${marker}${combined.substring(0, firstNewline).trimStart()}`)
          items.push(combined.substring(firstNewline + 1).split("\n").map(line => " ".repeat(totalIndent) + line.trimStart()).join("\n"))
        }
      }
      itemNumber += 1
    }
    return items.join("\n")
  }

  private flattenListChildren(children: PromptNode[]): PromptNode[] {
    const flattened: PromptNode[] = []
    for (const child of children) {
      if (Array.isArray(child)) flattened.push(...this.flattenListChildren(child))
      else flattened.push(child)
    }
    return flattened
  }

  private extractListItem(
    children: PromptNode,
    nestedIndent: number,
    baseIndentWidth = 0,
  ): { textContent: string; nestedLists: string[] } {
    if (children == null) return { textContent: "", nestedLists: [] }
    const textParts: string[] = []
    const nestedLists: string[] = []
    for (const child of this.flattenListChildren(Array.isArray(children) ? children : [children])) {
      if (!isElement(child)) {
        const rendered = this.renderContentNode(child)
        if (rendered) textParts.push(rendered)
        continue
      }
      let element = child
      if (typeof element.type === "function") {
        const resolved = element.type(element.props)
        if (isElement(resolved)) element = resolved
        else {
          const rendered = this.renderContent(resolved)
          if (rendered) textParts.push(rendered)
          continue
        }
      }
      if (element.type === "ul") {
        const rendered = this.renderList(element.props.children, "unordered", nestedIndent, baseIndentWidth)
        if (rendered.trim()) nestedLists.push(rendered)
      } else if (element.type === "ol") {
        const rendered = this.renderList(element.props.children, "ordered", nestedIndent, baseIndentWidth)
        if (rendered.trim()) nestedLists.push(rendered)
      } else {
        const rendered = this.renderContentNode(element)
        if (rendered) textParts.push(rendered)
      }
    }
    return { textContent: textParts.join(""), nestedLists }
  }

  /** Whitespace inside `<pre>` is content: it is copied, not normalized. */
  private renderPreContent(children: PromptNode): string {
    if (children == null || typeof children === "boolean") return ""
    if (typeof children === "string" || typeof children === "number") return String(children)
    if (Array.isArray(children)) return children.map(child => this.renderPreContent(child)).join("")
    if (typeof children.type === "function") return this.renderPreContent(children.type(children.props))
    if (children.type === "Fragment") return this.renderPreContent(children.props.children)
    if (children.type === "br") return "\n"
    return this.renderPreContent(children.props.children)
  }

  private renderTaggedElement(props: PromptProps): string {
    const { children, key: _key, tag, ...attributes } = props
    const tagName = typeof tag === "string" && tag.length > 0 ? tag : "x"
    return this.wrapInTag(tagName, this.renderContent(children), attributes)
  }

  /** A section is named by its title: `title="Build steps"` becomes `<build-steps>`. */
  private renderSection(props: PromptProps): string {
    const { children, key: _key, title, ...attributes } = props
    const tagName = String(title).toLowerCase().replace(/\s+/g, "-")
    const content = this.renderContent(children)
    if (!content.trim()) return this.wrapInTag(tagName, "", attributes)
    return `<${tagName}${this.renderAttributes(attributes)}>\n${content}\n</${tagName}>`
  }

  private wrapInTag(tagName: string, content: string, attributes: Record<string, unknown>): string {
    const attributePrefix = this.renderAttributes(attributes)
    return !content.trim()
      ? `<${tagName}${attributePrefix} />`
      : `<${tagName}${attributePrefix}>${content}</${tagName}>`
  }

  private renderAttributes(attributes: Record<string, unknown>): string {
    const rendered = Object.keys(attributes)
      .filter(attribute => attributes[attribute] != null)
      .map(attribute => {
        const value = attributes[attribute]
        if (typeof value === "boolean") return value ? attribute : ""
        return `${attribute}="${String(value).replace(/"/g, "&quot;")}"`
      })
      .filter(attribute => attribute)
      .join(" ")
    return rendered ? ` ${rendered}` : ""
  }

  private flattenNodes(nodes: PromptNode[]): PromptNode[] {
    const result: PromptNode[] = []
    for (const node of nodes) {
      if (node == null || typeof node === "boolean") continue
      if (Array.isArray(node)) {
        result.push(...this.flattenNodes(node))
        continue
      }
      if (!isElement(node)) {
        result.push(node)
        continue
      }
      if (node.type === "Fragment") {
        const children = node.props.children
        if (children != null) result.push(...this.flattenNodes(Array.isArray(children) ? children : [children]))
        continue
      }
      if (typeof node.type === "function") {
        const resolved = node.type(node.props)
        if (resolved != null) result.push(...this.flattenNodes(Array.isArray(resolved) ? resolved : [resolved]))
        continue
      }
      result.push(node)
    }
    return result
  }

  private isBlockTag(type: string | ((props: PromptProps) => PromptNode)): boolean {
    return typeof type === "string" && (type === "p" || type === "section" || type === "ul" || type === "ol" ||
      type === "x" || type === "pre" || /^h[1-6]$/.test(type))
  }

  private isBlockNode(node: PromptNode): boolean {
    if (!isElement(node)) return false
    return this.isBlockTag(node.type)
  }

  private isSectionNode(node: PromptNode): boolean {
    return isElement(node) && node.type === "section"
  }

  private formatHeading(type: string, content: string): string {
    if (!content.trim()) return ""
    const level = Number.parseInt(type.slice(1), 10)
    return `${"#".repeat(level)} ${content.trim()}`
  }

  private normalizeWhitespace(text: string): string {
    const trailing = text.match(/\n+$/)?.[0] ?? ""
    return text.replace(/ +/g, " ").trim() + trailing
  }
}

export function renderContent(element: PromptNode, options?: RenderOptions): string {
  return new RenderContext(options || {}).renderContent(element)
}

export function renderToMessages(element: PromptNode, options?: RenderOptions): PromptMessage[] {
  return new RenderContext(options || {}).renderToMessages(element)
}

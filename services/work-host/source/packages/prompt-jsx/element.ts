/**
 * The element model prompts are written in.
 *
 * A prompt is authored as a tree of elements — the same shape JSX compiles to — and rendered later
 * into the messages a model receives. The tree carries only what the renderer needs: a type that is
 * either a built-in tag or a component function, its props, and its children. Children that render to
 * nothing (null, booleans, empty strings) are dropped at construction, so no downstream code has to
 * filter them again.
 */

export interface PromptElement {
  readonly type: string | ((props: PromptProps) => PromptNode)
  readonly props: PromptProps
  readonly children?: PromptNode[] | undefined
}

export interface PromptProps {
  readonly children?: PromptNode | PromptNode[] | undefined
  readonly [key: string]: unknown
}

export type PromptNode =
  | PromptElement
  | PromptNode[]
  | string
  | number
  | boolean
  | null
  | undefined

function keepPromptChild(child: PromptNode): boolean {
  return child !== null && child !== undefined && typeof child !== "boolean" && child !== ""
}

function childrenToRead(declared: PromptProps["children"], positional: PromptNode[]): PromptNode[] {
  if (declared === undefined) return positional
  return Array.isArray(declared) ? declared : [declared]
}

export function jsx(
  type: PromptElement["type"],
  props: PromptProps | null | undefined,
  ...children: PromptNode[]
): PromptElement {
  const baseProps = props ?? {}
  const visibleChildren = childrenToRead(baseProps.children, children).filter(keepPromptChild)
  const childValue = visibleChildren.length === 0 ? undefined : visibleChildren

  return {
    type,
    props: { ...baseProps, children: childValue },
    children: childValue,
  }
}

/** A group with no output of its own: it exists so a component can return several children. */
export function Fragment(props: PromptProps): PromptElement {
  return jsx("Fragment", props)
}

/** The plural form the JSX transform emits when a component has several static children. */
export function jsxs(type: PromptElement["type"], props: PromptProps): PromptElement {
  return jsx(type, props)
}

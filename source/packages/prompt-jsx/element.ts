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

function isRenderable(child: PromptNode): boolean {
  return child != null && typeof child !== "boolean" && child !== ""
}

export function jsx(
  type: PromptElement["type"],
  props: PromptProps | null | undefined,
  ...children: PromptNode[]
): PromptElement {
  const normalizedProps = props || {}
  const propChildren = normalizedProps.children
  const allChildren = propChildren
    ? Array.isArray(propChildren) ? propChildren : [propChildren]
    : children
  const kept = allChildren.filter(isRenderable)
  return {
    type,
    props: Object.assign({}, normalizedProps, {
      children: kept.length > 0 ? kept : undefined,
    }),
    children: kept.length > 0 ? kept : undefined,
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

/** The action vocabulary used by Slate when accounting for an interactive screen session. */
export type ComputerUseActionKind =
  | "pointer-move"
  | "click"
  | "button-down"
  | "button-up"
  | "drag"
  | "scroll"
  | "type-text"
  | "key-press"
  | "pause"
  | "screenshot"
  | "pointer-position"
  | undefined

export interface ComputerUseActionLike {
  readonly kind: ComputerUseActionKind
}

export interface ComputerUseActionCounts {
  readonly mouse_move: number
  readonly click: number
  readonly mouse_down: number
  readonly mouse_up: number
  readonly drag: number
  readonly scroll: number
  readonly type: number
  readonly key: number
  readonly wait: number
  readonly screenshot: number
  readonly cursor_position: number
}

export const COMPUTER_USE_SCREENSHOT_SETTLE_DELAY_MS = 2_000

const COUNT_FIELD_BY_ACTION: Readonly<Partial<Record<Exclude<ComputerUseActionKind, undefined>, keyof ComputerUseActionCounts>>> = {
  "pointer-move": "mouse_move",
  click: "click",
  "button-down": "mouse_down",
  "button-up": "mouse_up",
  drag: "drag",
  scroll: "scroll",
  "type-text": "type",
  "key-press": "key",
  pause: "wait",
  screenshot: "screenshot",
  "pointer-position": "cursor_position",
}

export function summarizeComputerUseActions(
  actions: readonly ComputerUseActionLike[],
): { readonly actionCount: number; readonly actionCounts: ComputerUseActionCounts } {
  const actionCounts: Record<keyof ComputerUseActionCounts, number> = {
    mouse_move: 0,
    click: 0,
    mouse_down: 0,
    mouse_up: 0,
    drag: 0,
    scroll: 0,
    type: 0,
    key: 0,
    wait: 0,
    screenshot: 0,
    cursor_position: 0,
  }

  for (const { kind } of actions) {
    const field = kind === undefined ? undefined : COUNT_FIELD_BY_ACTION[kind]
    if (field !== undefined) actionCounts[field] += 1
  }
  return { actionCount: actions.length, actionCounts }
}

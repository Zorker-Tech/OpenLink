export interface PromptEnterKeyState {
  key: string
  keyCode: number
  shiftKey: boolean
  isComposing: boolean
}

/**
 * Browser IMEs do not consistently keep `isComposing` true for the Enter
 * keydown that confirms a candidate. WebKit commonly reports that key as the
 * legacy process key (229), so both signals are required before Enter can be
 * treated as a prompt submission.
 */
export function shouldSubmitPromptOnEnter(event: PromptEnterKeyState): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
}

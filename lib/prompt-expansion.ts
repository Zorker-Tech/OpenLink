/** Keep an editing session expanded: expanded width must not undo wrapping
 * detected at the narrower compact width. Clear/send resets the layout. */
export function promptShouldExpand(value: string, scrollHeight: number, expanded: boolean): boolean {
  return value.length > 0 && (expanded || value.includes('\n') || scrollHeight > 24)
}

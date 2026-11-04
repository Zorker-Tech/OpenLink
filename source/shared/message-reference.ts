const turnAddress = String.raw`t(?:\d+u(?:a\d+)?|(?:\d+|b)[as]\d+)`

/** The exact grammar used by Slate surfaces when they refer to a transcript message. */
export const MESSAGE_ADDRESS_EXACT = new RegExp(`^${turnAddress}$`)

export function isMessageAddress(value: string): boolean {
  return MESSAGE_ADDRESS_EXACT.test(value)
}

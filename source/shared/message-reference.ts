/** The pattern a message address has to match. */
const MESSAGE_ADDRESS_PATTERN = /^t(?:\d+u(?:a\d+)?|(?:\d+|b)[as]\d+)$/;

/** The addresses a message can be referred to by, as a surface spells them. */
export const MESSAGE_ADDRESS_EXACT = MESSAGE_ADDRESS_PATTERN;

/** Whether a surface's spelling names a message. */
export function isMessageAddress(candidate: string): boolean {
  return MESSAGE_ADDRESS_EXACT.test(candidate);
}

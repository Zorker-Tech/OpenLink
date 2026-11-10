/**
 * Comparing two arrays of the same kind.
 *
 * The agent's state holds lists that are re-derived on every update — the model's messages, its tool
 * definitions, its history — and a change to any of them means work. Reference comparison cannot tell a
 * rewritten list from a changed one, and the lists are short enough that comparing element by element
 * is cheaper than the deep equality a general helper would do.
 */

export const isEqual = <T>(a: readonly T[], b: readonly T[]): boolean => {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

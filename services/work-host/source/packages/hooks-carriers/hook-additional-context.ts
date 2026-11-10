/** Context contributed by a hook, expressed in the host's own vocabulary. */
export type HookContextEntry = Readonly<{
  event: string
  text: string
}>

export const HOOK_CONTEXT_MAX_CHARACTERS = 10_000

export class HookContextLimitError extends Error {
  readonly event: string
  readonly actualCharacters: number
  readonly maximumCharacters: number

  constructor(input: { event: string; actualCharacters: number; maximumCharacters: number }) {
    super(`Hook response for ${input.event} contained ${input.actualCharacters} characters; the limit is ${input.maximumCharacters}.`)
    this.name = "HookContextLimitError"
    this.event = input.event
    this.actualCharacters = input.actualCharacters
    this.maximumCharacters = input.maximumCharacters
  }
}

function trimmedText(text: string | null | undefined): string | undefined {
  const value = text?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

export function createHookContextEntries(input: {
  event: string
  text: string | null | undefined
}): HookContextEntry[] {
  const value = trimmedText(input.text)
  if (value === undefined) return []
  if (value.length > HOOK_CONTEXT_MAX_CHARACTERS) {
    throw new HookContextLimitError({
      event: input.event,
      actualCharacters: value.length,
      maximumCharacters: HOOK_CONTEXT_MAX_CHARACTERS,
    })
  }
  return [{ event: input.event, text: value }]
}

export function appendHookContextEntries(
  destination: HookContextEntry[] | undefined,
  additions: readonly HookContextEntry[],
): void {
  if (destination !== undefined && additions.length !== 0) destination.push(...additions)
}

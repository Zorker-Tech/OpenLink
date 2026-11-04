export type SlateSourceMode = "local" | "agent-store"

export interface SlateSourceEntry {
  readonly sourceId: string
  readonly mode: SlateSourceMode
}

export const BOX_STORE_SOURCE_KEY = "box-store"

export type SlateSourceMapValue = Record<string, SlateSourceEntry>

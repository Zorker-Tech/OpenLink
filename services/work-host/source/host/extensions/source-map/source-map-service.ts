import { randomUUID } from "node:crypto"
import { readSlateSourceMap, writeSlateSourceMap, getSourceMapPath } from "./source-map-storage.ts"
import { BOX_STORE_SOURCE_KEY, type SlateSourceEntry, type SlateSourceMode, type SlateSourceMapValue } from "./source-map-contracts.ts"

export { BOX_STORE_SOURCE_KEY, getSourceMapPath }
export type { SlateSourceEntry, SlateSourceMode }

export class SlateSourceMap {
  private cache: SlateSourceMapValue | undefined

  constructor(
    private readonly filePath = getSourceMapPath(),
    private readonly createId: () => string = () => randomUUID(),
  ) {}

  async getOrCreate(agentId: string): Promise<SlateSourceEntry> {
    const mappings = await this.load()
    const saved = mappings[agentId]
    if (saved != null) return saved

    const entry: SlateSourceEntry = { sourceId: this.createId(), mode: "local" }
    mappings[agentId] = entry
    await this.save(mappings)
    return entry
  }

  getOrCreateBoxStore(): Promise<SlateSourceEntry> {
    return this.getOrCreate(BOX_STORE_SOURCE_KEY)
  }

  async getBoxStore(): Promise<SlateSourceEntry | null> {
    return (await this.load())[BOX_STORE_SOURCE_KEY] ?? null
  }

  async setMode(agentId: string, mode: SlateSourceMode): Promise<SlateSourceEntry> {
    const mappings = await this.load()
    const saved = mappings[agentId]
    const entry = { sourceId: saved?.sourceId ?? this.createId(), mode }
    mappings[agentId] = entry
    await this.save(mappings)
    return entry
  }

  private async load(): Promise<SlateSourceMapValue> {
    if (this.cache !== undefined) return this.cache
    this.cache = await readSlateSourceMap(this.filePath)
    return this.cache
  }

  private async save(mappings: SlateSourceMapValue): Promise<void> {
    this.cache = mappings
    await writeSlateSourceMap(this.filePath, mappings)
  }
}

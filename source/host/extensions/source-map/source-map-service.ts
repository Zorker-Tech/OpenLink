/**
 * Where the code an agent is working on came from.
 *
 * A source is either a folder on this machine or a store the platform keeps, and the service lists them, opens one and
 * remembers which mode it was opened in, so the rest of the host asks the source rather than the filesystem.
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { getSlateRootDir } from "../../host-paths.ts";

export type SlateSourceMode = "local" | "agent-store";
export interface SlateSourceEntry { readonly sourceId: string; readonly mode: SlateSourceMode; }
export const BOX_STORE_SOURCE_KEY = "box-store";

export function getSourceMapPath(): string { return join(getSlateRootDir(), "source-map.json"); }

function parseSourceMap(value: unknown): Record<string, SlateSourceEntry> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return {};
  const result: Record<string, SlateSourceEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry == null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.sourceId === "string" && record.sourceId.length > 0 && (record.mode === "local" || record.mode === "agent-store")) result[key] = { sourceId: record.sourceId, mode: record.mode };
  }
  return result;
}

export class SlateSourceMap {
  private cache: Record<string, SlateSourceEntry> | undefined;
  constructor(private readonly path = getSourceMapPath(), private readonly createId: () => string = () => crypto.randomUUID()) {}

  async getOrCreate(agentId: string): Promise<SlateSourceEntry> {
    const map = await this.load();
    const existing = map[agentId];
    if (existing != null) return existing;
    const entry: SlateSourceEntry = { sourceId: this.createId(), mode: "local" };
    map[agentId] = entry;
    await this.save(map);
    return entry;
  }
  getOrCreateBoxStore(): Promise<SlateSourceEntry> { return this.getOrCreate(BOX_STORE_SOURCE_KEY); }
  async getBoxStore(): Promise<SlateSourceEntry | null> { return (await this.load())[BOX_STORE_SOURCE_KEY] ?? null; }
  async setMode(agentId: string, mode: SlateSourceMode): Promise<SlateSourceEntry> {
    const map = await this.load();
    const entry = map[agentId] ?? { sourceId: this.createId(), mode };
    const next = { sourceId: entry.sourceId, mode };
    map[agentId] = next;
    await this.save(map);
    return next;
  }
  private async load(): Promise<Record<string, SlateSourceEntry>> {
    if (this.cache != null) return this.cache;
    try { this.cache = parseSourceMap(JSON.parse(await fs.readFile(this.path, "utf8")) as unknown); }
    catch { this.cache = {}; }
    return this.cache;
  }
  private async save(map: Record<string, SlateSourceEntry>): Promise<void> {
    this.cache = map;
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(map, null, 2), "utf8");
    await fs.rename(tempPath, this.path);
  }
}


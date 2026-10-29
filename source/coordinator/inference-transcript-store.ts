import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { SlateInferenceProvider } from "../shared/inference-router.ts"

const MAX_ENTRIES_PER_AGENT = 200
const EMPTY_TRANSCRIPT: StoredTranscript = { schemaVersion: 2, agents: {} }

export type RoutedProvider = Exclude<SlateInferenceProvider, "slate">

export interface StoredEntry {
  readonly provider: RoutedProvider
  readonly role: "user" | "assistant"
  readonly content: string
  readonly richText?: string
  readonly id: string
  readonly clientNonce?: string
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[]
  readonly timestampMs: number
}

export interface StoredTranscript {
  readonly schemaVersion: 2
  readonly agents: Readonly<Record<string, readonly StoredEntry[]>>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isStoredEntry(row: Record<string, unknown>): boolean {
  if (row.provider !== "codex" && row.provider !== "claude-code" && row.provider !== "openrouter") return false
  if (row.role !== "user" && row.role !== "assistant") return false
  if (typeof row.content !== "string" || typeof row.id !== "string" || typeof row.timestampMs !== "number") return false
  if (row.clientNonce !== undefined && typeof row.clientNonce !== "string") return false
  if (row.richText !== undefined && typeof row.richText !== "string") return false
  if (row.reactions === undefined) return true
  if (!Array.isArray(row.reactions)) return false
  return row.reactions.every((value) => {
    const reaction = asRecord(value)
    return reaction !== undefined && typeof reaction.emoji === "string" && typeof reaction.by === "string"
  })
}

/** Read only rows the file can prove belong to the external-provider transcript. */
export function parseInferenceRouterTranscriptStore(value: unknown): StoredTranscript {
  const root = asRecord(value)
  const rawAgents = root?.schemaVersion === 2 ? asRecord(root.agents) : undefined
  if (rawAgents === undefined) return EMPTY_TRANSCRIPT

  const agents: Record<string, StoredEntry[]> = {}
  for (const [agentId, value] of Object.entries(rawAgents)) {
    if (!Array.isArray(value)) continue
    const rows: StoredEntry[] = []
    for (const candidate of value) {
      const row = asRecord(candidate)
      if (row !== undefined && isStoredEntry(row)) rows.push(row as unknown as StoredEntry)
    }
    agents[agentId] = rows.slice(-MAX_ENTRIES_PER_AGENT)
  }
  return { schemaVersion: 2, agents }
}

/** Gives a surface its own row vocabulary without exposing the storage envelope. */
export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  const shared = {
    id: entry.id,
    timestampMs: entry.timestampMs,
    ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
  }
  if (entry.role === "assistant") {
    return { kind: "send-message", ...shared, message: { type: "text", content: entry.content } }
  }
  return {
    kind: "message",
    ...shared,
    role: "user",
    content: entry.content,
    ...(entry.richText === undefined ? {} : { richText: entry.richText }),
    isStreaming: false,
    ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }),
  }
}

function turnNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const matched = /^t(\d+)(?:u|s\d+)$/.exec(value)
  if (matched === null) return undefined
  const turn = Number(matched[1])
  return Number.isSafeInteger(turn) ? turn : undefined
}

/** The next shared transcript turn after both the backend tail and the local journal. */
export function nextInferenceRouterTurn(
  remoteEntries: readonly unknown[],
  localEntries: readonly StoredEntry[],
): number {
  let latest = -1
  for (const value of remoteEntries) {
    latest = Math.max(latest, turnNumber(asRecord(value)?.id) ?? -1)
  }
  for (const entry of localEntries) {
    latest = Math.max(latest, turnNumber(entry.id) ?? -1)
  }
  return latest + 1
}

/** Durable append-only rows for turns routed through a provider outside the host backend. */
export class InferenceTranscriptStore {
  private readonly path: string
  private pendingMutation: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.path = join(dataDir, "inference-router-transcript.json")
  }

  async load(): Promise<StoredTranscript> {
    try {
      return parseInferenceRouterTranscriptStore(JSON.parse(await readFile(this.path, "utf8")))
    } catch {
      return EMPTY_TRANSCRIPT
    }
  }

  append(agentId: string, entries: readonly StoredEntry[]): Promise<StoredTranscript> {
    return this.serializeMutation(async () => {
      const current = await this.load()
      const next: StoredTranscript = {
        schemaVersion: 2,
        agents: {
          ...current.agents,
          [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-MAX_ENTRIES_PER_AGENT),
        },
      }
      await this.persist(next)
      return next
    })
  }

  toggleReaction(agentId: string, entryId: string, emoji: string): Promise<Record<string, unknown> | null> {
    const normalizedEmoji = emoji.trim()
    if (agentId.length === 0 || entryId.length === 0 || normalizedEmoji.length === 0) {
      return Promise.resolve(null)
    }

    return this.serializeMutation(async () => {
      const current = await this.load()
      const entries = current.agents[agentId]
      if (entries === undefined) return null
      const index = entries.findIndex((entry) => entry.id === entryId)
      if (index < 0) return null

      const before = entries[index]!
      const existing = before.reactions ?? []
      const alreadySet = existing.some((reaction) => reaction.emoji === normalizedEmoji && reaction.by === "me")
      const reactions = alreadySet
        ? existing.filter((reaction) => !(reaction.emoji === normalizedEmoji && reaction.by === "me"))
        : [...existing, { emoji: normalizedEmoji, by: "me" }]
      const { reactions: _previous, ...withoutReactions } = before
      const updated = reactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions }
      const nextEntries = [...entries]
      nextEntries[index] = updated
      await this.persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } })
      return projectInferenceRouterTranscriptEntry(updated)
    })
  }

  private serializeMutation<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pendingMutation.then(work, work)
    this.pendingMutation = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(snapshot: StoredTranscript): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const stagingPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(stagingPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    await rename(stagingPath, this.path)
  }
}

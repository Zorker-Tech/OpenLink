/**
 * An agent's conversation, kept as blobs with a small structure on top.
 *
 * The conversation is a *structure* — the ids of the turns, steps, todos and summary — and the
 * content behind those ids lives in the blob store. Checkpointing therefore writes one small
 * structure plus whatever changed, and rebuilding the full conversation walks the structure and reads
 * the blobs it points at. The structure is the thing a caller can hold on to cheaply; the conversation
 * is the thing it can ask for.
 *
 * The agent's own metadata (its name, mode, approval setting, model, plan) is separate: it is small,
 * changes often, and is what a renderer subscribes to.
 */

import { z } from "zod"

import { Disposable } from "../utils/disposable.ts"
import type { BlobStore } from "./blob-store.ts"
import { getBlobId } from "./blob-store.ts"
import { fromHex, toHex, utf8Serde } from "./serde.ts"
import type { AgentConversationBundle, AgentConversationCodec } from "./agent-conversation-store-contracts.ts"

export const AgentModes = ["default", "plan", "debug", "search"] as const
export const ApprovalModeSettings = ["allowlist", "unrestricted", "auto-review"] as const
export type AgentMode = (typeof AgentModes)[number]
export type ApprovalModeSetting = (typeof ApprovalModeSettings)[number]

const BLOB_ENCRYPTION_KEY_LENGTH_BYTES = 32
const BLOB_ENCRYPTION_KEY_HEX_PATTERN = /^[0-9a-f]+$/

export interface AgentSubagentInfo {
  parentAgentId: string
  rootParentAgentId: string
  toolCallId: string
  typeName: string
}

export interface AgentMetadata {
  agentId: string
  latestRootBlobId: Uint8Array
  name: string
  mode: AgentMode
  isRunEverything: boolean
  approvalMode?: ApprovalModeSetting | undefined
  createdAt: number
  lastUsedModel?: string | undefined
  lastDebugServerPort?: number | undefined
  currentPlanUri?: string | undefined
  subagentInfo?: AgentSubagentInfo | undefined
  blobEncryptionKey?: string | undefined
}

export type AgentMetadataKey = keyof AgentMetadata

export interface AgentMetadataStore {
  subscribe(key: AgentMetadataKey, callback: () => void): () => void
  set<Key extends AgentMetadataKey>(key: Key, value: AgentMetadata[Key]): unknown
  get<Key extends AgentMetadataKey>(key: Key): AgentMetadata[Key]
}

/** A fresh key per agent: blobs are encrypted with a key that never leaves the metadata. */
export function generateBlobEncryptionKeyHex(): string {
  const bytes = new Uint8Array(BLOB_ENCRYPTION_KEY_LENGTH_BYTES)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

export function isValidBlobEncryptionKeyHex(value: unknown): value is string {
  return typeof value === "string" &&
    value.length === BLOB_ENCRYPTION_KEY_LENGTH_BYTES * 2 &&
    BLOB_ENCRYPTION_KEY_HEX_PATTERN.test(value)
}

let metadataSchema: z.ZodType<AgentMetadata> | null = null

/** What a stored agent's metadata must look like to be usable. */
export function getAgentMetadataSchema(): z.ZodType<AgentMetadata> {
  metadataSchema ??= z.object({
    agentId: z.string(),
    latestRootBlobId: z.custom<Uint8Array>(value => value instanceof Uint8Array, {
      message: "Expected Uint8Array",
    }),
    name: z.string(),
    createdAt: z.number(),
    mode: z.enum(AgentModes),
    isRunEverything: z.boolean(),
    approvalMode: z.enum(ApprovalModeSettings).optional(),
    lastUsedModel: z.string().optional(),
    lastDebugServerPort: z.number().int().positive().optional(),
    currentPlanUri: z.string().optional(),
    subagentInfo: z.union([
      z.object({
        parentAgentId: z.string().min(1),
        rootParentAgentId: z.string().min(1),
        toolCallId: z.string().min(1),
        typeName: z.string().min(1),
      }),
      z.undefined(),
    ]),
    blobEncryptionKey: z.string().optional(),
  })
  return metadataSchema
}

export function getDefaultAgentMetadata(agentId?: string | null): AgentMetadata {
  return {
    agentId: agentId ?? crypto.randomUUID(),
    latestRootBlobId: new Uint8Array(),
    name: "New Agent",
    mode: "default",
    isRunEverything: false,
    approvalMode: undefined,
    createdAt: Date.now(),
    lastUsedModel: undefined,
    lastDebugServerPort: undefined,
    currentPlanUri: undefined,
    subagentInfo: undefined,
    blobEncryptionKey: generateBlobEncryptionKeyHex(),
  }
}

const agentModeSet = new Set<string>(AgentModes)
const approvalModeSettingSet = new Set<string>(ApprovalModeSettings)

function parseSubagentInfo(value: unknown): AgentSubagentInfo | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<AgentSubagentInfo>
  if (
    typeof candidate.parentAgentId !== "string" || candidate.parentAgentId.length === 0 ||
    typeof candidate.rootParentAgentId !== "string" || candidate.rootParentAgentId.length === 0 ||
    typeof candidate.toolCallId !== "string" || candidate.toolCallId.length === 0 ||
    typeof candidate.typeName !== "string" || candidate.typeName.length === 0
  ) return undefined
  return {
    parentAgentId: candidate.parentAgentId,
    rootParentAgentId: candidate.rootParentAgentId,
    toolCallId: candidate.toolCallId,
    typeName: candidate.typeName,
  }
}

/**
 * Metadata is stored as JSON with the blob id in hex, because the id is bytes and the store is text.
 * Reading is deliberately forgiving: an unknown mode falls back to the default, an old `auto-run`
 * mode becomes "run everything", and a key that is not a key is replaced — a stored agent should
 * never fail to load because a field it does not recognize appeared.
 */
export class AgentMetadataSerde {
  serialize(value: AgentMetadata): Uint8Array {
    return utf8Serde.serialize(JSON.stringify({ ...value, latestRootBlobId: toHex(value.latestRootBlobId) }))
  }

  deserialize(blob: Uint8Array): AgentMetadata {
    const json = JSON.parse(utf8Serde.deserialize(blob)) as Record<string, unknown>
    const defaults = getDefaultAgentMetadata(typeof json.agentId === "string" ? json.agentId : undefined)
    const latestRootBlobId = typeof json.latestRootBlobId === "string"
      ? fromHex(json.latestRootBlobId)
      : defaults.latestRootBlobId
    let isRunEverything = json.isRunEverything === true
    let rawMode = json.mode
    if (rawMode === "auto-run") {
      rawMode = "default"
      isRunEverything = true
    }
    const mode = typeof rawMode === "string" && agentModeSet.has(rawMode) ? rawMode as AgentMode : "default"
    const rawApprovalMode = json.approvalMode
    const approvalMode = typeof rawApprovalMode === "string" && approvalModeSettingSet.has(rawApprovalMode)
      ? rawApprovalMode as ApprovalModeSetting
      : undefined
    return getAgentMetadataSchema().parse({
      ...defaults,
      ...json,
      mode,
      isRunEverything,
      approvalMode,
      latestRootBlobId,
      subagentInfo: parseSubagentInfo(json.subagentInfo),
      blobEncryptionKey: isValidBlobEncryptionKeyHex(json.blobEncryptionKey)
        ? json.blobEncryptionKey
        : defaults.blobEncryptionKey,
    })
  }

  getBlobType(): { kind: "json" } {
    return { kind: "json" }
  }
}

export class AgentConversationStore<Context = unknown, Checkpoint = unknown, Conversation = unknown> {
  private readonly blobStore: BlobStore<Context>
  private readonly metadataStore: AgentMetadataStore
  private readonly codec: AgentConversationCodec<Context, Checkpoint, Conversation>
  private readonly fixedRootBlobId: Uint8Array | undefined
  private conversationStateStructure: Checkpoint

  constructor(
    blobStore: BlobStore<Context>,
    metadataStore: AgentMetadataStore,
    options: { codec: AgentConversationCodec<Context, Checkpoint, Conversation>; fixedRootBlobId?: Uint8Array },
  ) {
    this.blobStore = blobStore
    this.metadataStore = metadataStore
    this.codec = options.codec
    this.fixedRootBlobId = options.fixedRootBlobId
    this.conversationStateStructure = this.codec.createEmptyCheckpoint()
  }

  subscribeToMetadata<Key extends AgentMetadataKey>(
    key: Key,
    callback: (value: AgentMetadata[Key]) => void,
  ): () => void {
    return this.metadataStore.subscribe(key, () => callback(this.metadataStore.get(key)))
  }

  setMetadata<Key extends AgentMetadataKey>(key: Key, value: AgentMetadata[Key]): void {
    this.metadataStore.set(key, value)
  }

  getMetadata<Key extends AgentMetadataKey>(key: Key): AgentMetadata[Key] {
    return this.metadataStore.get(key)
  }

  getId(): string {
    return this.getMetadata("agentId")
  }

  getBlobStore(): BlobStore<Context> {
    return this.blobStore
  }

  getConversationStateStructure(): Checkpoint {
    return this.conversationStateStructure
  }

  /** The request id of the newest agent turn, which is how a caller resumes a stream. */
  async getLastRequestIdFromConversation(ctx: Context): Promise<string | null> {
    return this.codec.getLastRequestId(ctx, this.conversationStateStructure, this.blobStore)
  }

  async getFullConversation(ctx: Context): Promise<Conversation> {
    return this.deserializeConversationStateStructure(ctx, this.conversationStateStructure)
  }

  async deserializeConversationStateStructure(
    ctx: Context,
    structure: Checkpoint,
  ): Promise<Conversation> {
    return this.codec.hydrateConversation(ctx, structure, this.blobStore)
  }

  /** The conversation plus every subagent's own conversation, keyed by subagent id. */
  async getFullConversationWithSubagents(ctx: Context): Promise<AgentConversationBundle<Conversation>> {
    const structure = this.conversationStateStructure
    const conversationState = await this.codec.hydrateConversation(ctx, structure, this.blobStore)
    const subagentStates: AgentConversationBundle<Conversation>["subagentStates"] = {}
    const persisted = await this.codec.resolveSubconversations(ctx, structure, this.blobStore)
    for (const [agentId, state] of Object.entries(persisted)) {
      if (state.conversationState === undefined) continue
      subagentStates[agentId] = {
        conversationState: await this.codec.hydrateConversation(ctx, state.conversationState, this.blobStore),
        createdTimestampMs: state.createdTimestampMs,
        lastUsedTimestampMs: state.lastUsedTimestampMs,
        ...(state.subagentType === undefined ? {} : { subagentType: state.subagentType }),
      }
    }
    return { conversationState, subagentStates }
  }

  getLatestCheckpoint(): Checkpoint {
    return this.getConversationStateStructure()
  }

  /** Writes the structure as the new root blob and remembers its id as the agent's latest. */
  async handleCheckpoint(ctx: Context, checkpoint: Checkpoint): Promise<void> {
    const ownedCheckpoint = this.codec.normalizeCheckpoint === undefined
      ? checkpoint
      : this.codec.normalizeCheckpoint(checkpoint)
    this.conversationStateStructure = ownedCheckpoint
    const bytes = this.codec.encodeCheckpoint(ownedCheckpoint)
    const blobId = this.fixedRootBlobId ?? await getBlobId(bytes)
    await this.blobStore.setBlob(ctx, blobId, bytes)
    this.setMetadata("latestRootBlobId", blobId)
  }

  async resetFromDb(ctx: Context): Promise<void> {
    await this.tryResetFromDb(ctx)
  }

  /** Reloads the structure from the agent's latest root blob; `false` means there was nothing to load. */
  async tryResetFromDb(ctx: Context): Promise<boolean> {
    try {
      const rootBlobId = this.getMetadata("latestRootBlobId")
      if (!rootBlobId || rootBlobId.length === 0) {
        this.conversationStateStructure = this.codec.createEmptyCheckpoint()
        return false
      }
      const bytes = await this.blobStore.getBlob(ctx, rootBlobId)
      if (!bytes) {
        this.conversationStateStructure = this.codec.createEmptyCheckpoint()
        return false
      }
      this.conversationStateStructure = this.codec.decodeCheckpoint(bytes)
      return true
    } catch {
      this.conversationStateStructure = this.codec.createEmptyCheckpoint()
      return false
    }
  }

  async dispose(): Promise<void> {
    if (this.blobStore instanceof Disposable) await this.blobStore.dispose()
  }
}

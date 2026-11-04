import type { Context as OperationContext } from "../context/context.ts"
import { createLogger } from "../context/logging.ts"
import { createCounter, createHistogram } from "../metrics/index.ts"
import { BlobNotFoundError } from "./blob-not-found-error.ts"
import { getBlobId, isBlobDurable, type BlobStore } from "./blob-store.ts"
import { toHex, type BlobType, type Serde } from "./serde.ts"
import { metadataObserverForStore } from "./typed-blob-store.ts"

const logger = createLogger("agent-kv:reference")
const LARGE_LAZY_REFERENCE_BLOB_BYTES = 512 * 1024
const SLOW_LAZY_REFERENCE_DESERIALIZE_MS = 100

const lazyReferenceCacheMiss = createCounter("agent_kv.lazy_reference.cache_miss", {
  description: "Lazy values materialized after a large or slow blob read",
  labelNames: ["blob_type"],
})
const lazyReferenceDeserializeBytes = createHistogram("agent_kv.lazy_reference.deserialize_bytes", {
  description: "Bytes loaded when a lazy value crosses an observation threshold",
  labelNames: ["blob_type"],
})
const lazyReferenceDeserializeDuration = createHistogram("agent_kv.lazy_reference.deserialize_ms", {
  description: "Time spent decoding a lazy value that crosses an observation threshold",
  labelNames: ["blob_type"],
})

/** A domain value that supplies its own persistent representation. */
export abstract class Writeable<Context = unknown> {
  abstract writeToBlobStore(context: Context): Promise<Uint8Array>
}

interface SavedEagerValue<T> {
  readonly value: T
  readonly blobId: Uint8Array
  readonly bytes: Uint8Array
}

interface SavedLazyValue<T> {
  readonly value: T
  readonly bytes: Uint8Array
}

function blobTypeLabel(serde: Serde<unknown>): string {
  const type = serde.getBlobType?.()
  if (type === undefined) return "unknown"

  switch (type.kind) {
    case "proto":
      return type.typeName as string
    case "json":
    case "string":
      return type.kind
    case "image":
      return "image:" + String(type.mimeType)
    case "file":
      return type.mimeType ? "file:" + type.mimeType : "file"
    default:
      return type.kind
  }
}

function reportBlobMetadata<T, Context>(
  serde: Serde<T>,
  blobStore: BlobStore<Context>,
  blobId: Uint8Array,
): void {
  const observe = metadataObserverForStore(blobStore)
  const type = serde.getBlobType?.()
  if (observe !== undefined && type !== undefined) observe({ blobId, blobType: type })
}

async function persistSerializedValue<T, Context>(
  value: T,
  serde: Serde<T>,
  blobStore: BlobStore<Context>,
  context: Context,
): Promise<{ readonly blobId: Uint8Array; readonly bytes: Uint8Array }> {
  const bytes = serde.serialize(value)
  const blobId = await getBlobId(bytes)
  reportBlobMetadata(serde, blobStore, blobId)
  await blobStore.setBlob(context, blobId, bytes)
  return { blobId, bytes }
}

function recordExpensiveRead(
  context: OperationContext,
  blobType: string,
  byteLength: number,
  elapsedMs: number,
): void {
  if (byteLength < LARGE_LAZY_REFERENCE_BLOB_BYTES && elapsedMs < SLOW_LAZY_REFERENCE_DESERIALIZE_MS) return

  lazyReferenceCacheMiss.increment(context, 1, { blob_type: blobType })
  lazyReferenceDeserializeBytes.histogram(context, byteLength, { blob_type: blobType })
  lazyReferenceDeserializeDuration.histogram(context, elapsedMs, { blob_type: blobType })
  logger.warn(context, "Lazy blob decoding exceeded its observation threshold", {
    blobType,
    blobBytes: byteLength,
    deserializeDurationMs: elapsedMs,
  })
}

export class EagerReference<T, Context = unknown> {
  readonly serde: Serde<T>
  readonly blobStore: BlobStore<Context>
  value: T
  private saved: SavedEagerValue<T> | undefined

  constructor(serde: Serde<T>, blobStore: BlobStore<Context>, value: T) {
    this.serde = serde
    this.blobStore = blobStore
    this.value = value
    this.saved = undefined
  }

  get(_context: Context): Promise<T> {
    return Promise.resolve(this.value)
  }

  set(value: T): void {
    this.value = value
  }

  async writeToBlobStore(context: Context): Promise<Uint8Array> {
    const value = this.value
    if (value instanceof Writeable) return value.writeToBlobStore(context)

    const saved = this.saved
    if (saved !== undefined && value === saved.value) {
      if (!isBlobDurable(this.blobStore, saved.blobId)) {
        await this.blobStore.setBlob(context, saved.blobId, saved.bytes)
      }
      return saved.blobId
    }

    const result = await persistSerializedValue(value, this.serde, this.blobStore, context)
    this.saved = { value, blobId: result.blobId, bytes: result.bytes }
    return result.blobId
  }
}

export class LazyReference<T, Context extends OperationContext = OperationContext> {
  readonly serde: Serde<T>
  readonly blobStore: BlobStore<Context>
  blobId: Uint8Array
  private valuePromise: Promise<T> | undefined
  private saved: SavedLazyValue<T> | undefined

  constructor(serde: Serde<T>, blobStore: BlobStore<Context>, blobId: Uint8Array) {
    this.serde = serde
    this.blobStore = blobStore
    this.blobId = blobId
    this.valuePromise = undefined
    this.saved = undefined
  }

  async get(context: Context): Promise<T> {
    if (this.valuePromise === undefined) {
      const blobType = blobTypeLabel(this.serde as Serde<unknown>)
      this.valuePromise = this.loadValue(context, blobType)
    }
    return this.valuePromise
  }

  private async loadValue(context: Context, blobType: string): Promise<T> {
    const bytes = await this.blobStore.getBlob(context, this.blobId)
    if (bytes === undefined) throw new BlobNotFoundError([toHex(this.blobId)])

    const startedAt = performance.now()
    const value = this.serde.deserialize(bytes)
    const elapsedMs = performance.now() - startedAt
    this.saved = { value, bytes }
    recordExpensiveRead(context, blobType, bytes.byteLength, elapsedMs)
    return value
  }

  set(value: T): void {
    this.valuePromise = Promise.resolve(value)
  }

  async writeToBlobStore(context: Context): Promise<Uint8Array> {
    if (this.valuePromise === undefined) return this.blobId

    const value = await this.get(context)
    if (value instanceof Writeable) return value.writeToBlobStore(context)

    const saved = this.saved
    if (saved !== undefined && value === saved.value) {
      if (!isBlobDurable(this.blobStore, this.blobId)) {
        await this.blobStore.setBlob(context, this.blobId, saved.bytes)
      }
      return this.blobId
    }

    const result = await persistSerializedValue(value, this.serde, this.blobStore, context)
    this.saved = { value, bytes: result.bytes }
    this.blobId = result.blobId
    return result.blobId
  }
}

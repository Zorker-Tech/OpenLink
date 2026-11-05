import type { Message } from "@bufbuild/protobuf"
import { ConversationSummary, ConversationSummaryArchive } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  toRedactedConversationSummary,
  toRedactedConversationSummaryArchive,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { DataClassification, PrivacyCapability, type DataClassification as DataClassificationValue } from "../../../packages/redaction/classification.ts"
import { createRedactedString } from "../../../packages/redaction/create.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { fromHex, toHex, utf8Serde } from "../../../packages/agent-kv/serde.ts"
import type { Serde } from "../../../packages/agent-kv/serde-contracts.ts"
import type { SlateCheckpointUnknownField } from "../../../packages/agent/conversation-checkpoint-state.ts"
import type {
  SlateConversationSummary,
  SlateConversationSummaryArchive,
  SlateStoredConversationSummary,
  SlateStoredConversationSummaryArchive,
} from "../../../packages/agent/conversation-summary-state.ts"

const SUMMARY_STORAGE_HEADER = utf8Serde.serialize("SLATE-AGENT-SUMMARY\n")
const SUMMARY_STORAGE_FORMAT = "slate.agent-conversation-summary"
const SUMMARY_ARCHIVE_STORAGE_HEADER = utf8Serde.serialize("SLATE-AGENT-SUMMARY-ARCHIVE\n")
const SUMMARY_ARCHIVE_STORAGE_FORMAT = "slate.agent-summary-archive"
const CLASSIFICATIONS = new Set<string>(Object.values(DataClassification))

function copyUnknownFields(fields: readonly SlateCheckpointUnknownField[] | undefined): SlateCheckpointUnknownField[] {
  return (fields ?? []).map(field => ({
    ...field,
    path: field.path.map(step => ({ ...step })),
  }))
}

function collectUnknownFields(summary: Message): SlateCheckpointUnknownField[] {
  return summary.getType().runtime.bin.listUnknownFields(summary).map(field => ({
    path: [],
    number: field.no,
    wireType: field.wireType,
    dataHex: toHex(field.data),
  }))
}

function restoreUnknownFields(summary: Message, fields: readonly SlateCheckpointUnknownField[] | undefined): void {
  for (const field of fields ?? []) {
    if (field.path.length !== 0) throw new TypeError("Conversation summary legacy-field path must be empty")
    summary.getType().runtime.bin.onUnknownField(
      summary,
      field.number,
      field.wireType as Parameters<typeof ConversationSummary.runtime.bin.onUnknownField>[2],
      fromHex(field.dataHex),
    )
  }
}

function isUnknownField(value: unknown): value is SlateCheckpointUnknownField {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const field = value as Record<string, unknown>
  return Object.keys(field).every(key => ["path", "number", "wireType", "dataHex"].includes(key)) &&
    Array.isArray(field.path) && field.path.length === 0 &&
    Number.isInteger(field.number) && (field.number as number) > 0 && (field.number as number) <= 536_870_911 &&
    Number.isInteger(field.wireType) && (field.wireType as number) >= 0 && (field.wireType as number) <= 5 &&
    typeof field.dataHex === "string" && /^(?:[0-9a-f]{2})*$/.test(field.dataHex)
}

function isStoredSummary(value: unknown): value is {
  readonly format: typeof SUMMARY_STORAGE_FORMAT
  readonly version: 1
  readonly summary: {
    readonly content: string
    readonly classification: DataClassificationValue
    readonly fieldName: string
  }
  readonly compatibility?: { readonly legacyUnknownFields?: readonly SlateCheckpointUnknownField[] }
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!Object.keys(envelope).every(key => ["format", "version", "summary", "compatibility"].includes(key)) ||
      envelope.format !== SUMMARY_STORAGE_FORMAT || envelope.version !== 1 ||
      envelope.summary === null || typeof envelope.summary !== "object" || Array.isArray(envelope.summary)) return false
  const summary = envelope.summary as Record<string, unknown>
  if (!Object.keys(summary).every(key => ["content", "classification", "fieldName"].includes(key)) ||
      typeof summary.content !== "string" || typeof summary.classification !== "string" ||
      !CLASSIFICATIONS.has(summary.classification) || typeof summary.fieldName !== "string") return false
  if (envelope.compatibility !== undefined) {
    if (envelope.compatibility === null || typeof envelope.compatibility !== "object" || Array.isArray(envelope.compatibility)) return false
    const compatibility = envelope.compatibility as Record<string, unknown>
    if (!Object.keys(compatibility).every(key => key === "legacyUnknownFields") ||
        (compatibility.legacyUnknownFields !== undefined &&
          (!Array.isArray(compatibility.legacyUnknownFields) || !compatibility.legacyUnknownFields.every(isUnknownField)))) return false
  }
  return true
}

export function redactSlateConversationSummary(
  summary: SlateConversationSummary,
  privacyMode: PrivacyMode,
): SlateStoredConversationSummary {
  return {
    content: createRedactedString(summary.content, DataClassification.CODE, "summary", privacyMode),
    ...(summary.compatibility === undefined
      ? {}
      : { compatibility: { legacyUnknownFields: copyUnknownFields(summary.compatibility.legacyUnknownFields) } }),
  }
}

function summaryText(value: SlateStoredConversationSummary["content"]): string {
  return value instanceof RedactedString
    ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : value
}

export function toInteropConversationSummary(summary: SlateStoredConversationSummary): ConversationSummary {
  const interop = new ConversationSummary({ summary: summaryText(summary.content) })
  restoreUnknownFields(interop, summary.compatibility?.legacyUnknownFields)
  return interop
}

export function createSlateConversationSummarySerde(privacyMode: PrivacyMode): Serde<SlateStoredConversationSummary> {
  return {
    serialize(summary) {
      const content = summary.content instanceof RedactedString
        ? {
            content: summary.content.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
            classification: summary.content.__classification,
            fieldName: summary.content.__fieldName,
          }
        : { content: summary.content, classification: DataClassification.CODE, fieldName: "summary" }
      const fields = summary.compatibility?.legacyUnknownFields
      if (fields?.some(field => !isUnknownField(field))) throw new TypeError("Conversation summary compatibility is invalid")
      const envelope = {
        format: SUMMARY_STORAGE_FORMAT,
        version: 1,
        summary: content,
        ...(fields === undefined || fields.length === 0
          ? {}
          : { compatibility: { legacyUnknownFields: copyUnknownFields(fields) } }),
      }
      return utf8Serde.serialize(`SLATE-AGENT-SUMMARY\n${JSON.stringify(envelope)}`)
    },
    deserialize(bytes) {
      if (bytes.length >= SUMMARY_STORAGE_HEADER.length &&
          SUMMARY_STORAGE_HEADER.every((byte, index) => bytes[index] === byte)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(SUMMARY_STORAGE_HEADER.length)))
        } catch (error) {
          throw new TypeError("Stored Slate conversation summary is not valid JSON", { cause: error })
        }
        if (!isStoredSummary(parsed)) throw new TypeError("Stored Slate conversation summary envelope is invalid")
        return {
          content: createRedactedString(
            parsed.summary.content,
            parsed.summary.classification,
            parsed.summary.fieldName,
            privacyMode,
          ),
          ...(parsed.compatibility === undefined
            ? {}
            : { compatibility: { legacyUnknownFields: copyUnknownFields(parsed.compatibility.legacyUnknownFields) } }),
        }
      }
      const legacy = ConversationSummary.fromBinary(bytes)
      const redacted = toRedactedConversationSummary(legacy, privacyMode)
      const fields = collectUnknownFields(legacy)
      return {
        content: redacted.summary as unknown as RedactedString,
        ...(fields.length === 0 ? {} : { compatibility: { legacyUnknownFields: fields } }),
      }
    },
    getBlobType() {
      return { kind: "json", typeName: SUMMARY_STORAGE_FORMAT }
    },
  }
}

export function deserializeSlateConversationSummaryInterop(bytes: Uint8Array): ConversationSummary {
  const summary = createSlateConversationSummarySerde("unspecified").deserialize(bytes)
  return toInteropConversationSummary(summary)
}

export function redactSlateConversationSummaryArchive(
  archive: SlateConversationSummaryArchive,
  privacyMode: PrivacyMode,
): SlateStoredConversationSummaryArchive {
  const text = archive.summary instanceof RedactedString
    ? createRedactedString(
        archive.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
        archive.summary.__classification,
        archive.summary.__fieldName,
        privacyMode,
      )
    : createRedactedString(archive.summary, DataClassification.CODE, "summary", privacyMode)
  return {
    summarizedMessageBlobIds: archive.summarizedMessageBlobIds.map(id => new Uint8Array(id)),
    summary: text,
    summaryMessageBlobId: new Uint8Array(archive.summaryMessageBlobId),
    unsummarizedWindowTail: archive.unsummarizedWindowTail,
    ...(archive.compatibility === undefined
      ? {}
      : { compatibility: { legacyUnknownFields: copyUnknownFields(archive.compatibility.legacyUnknownFields) } }),
  }
}

function summaryArchiveText(value: SlateStoredConversationSummaryArchive["summary"]): string {
  return value instanceof RedactedString
    ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED)
    : value
}

export function toInteropConversationSummaryArchive(
  archive: SlateStoredConversationSummaryArchive,
): ConversationSummaryArchive {
  const interop = new ConversationSummaryArchive({
    summarizedMessages: archive.summarizedMessageBlobIds.map(id => new Uint8Array(id)),
    summary: summaryArchiveText(archive.summary),
    summaryMessage: new Uint8Array(archive.summaryMessageBlobId),
    windowTail: archive.unsummarizedWindowTail,
  })
  restoreUnknownFields(interop, archive.compatibility?.legacyUnknownFields)
  return interop
}

function isStoredSummaryArchive(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  if (!Object.keys(envelope).every(key => ["format", "version", "archive", "compatibility"].includes(key)) ||
      envelope.format !== SUMMARY_ARCHIVE_STORAGE_FORMAT || envelope.version !== 1 ||
      envelope.archive === null || typeof envelope.archive !== "object" || Array.isArray(envelope.archive)) return false
  if (envelope.compatibility !== undefined) {
    if (envelope.compatibility === null || typeof envelope.compatibility !== "object" || Array.isArray(envelope.compatibility)) return false
    const compatibility = envelope.compatibility as Record<string, unknown>
    if (!Object.keys(compatibility).every(key => key === "legacyUnknownFields") ||
        (compatibility.legacyUnknownFields !== undefined &&
          (!Array.isArray(compatibility.legacyUnknownFields) || !compatibility.legacyUnknownFields.every(isUnknownField)))) return false
  }
  const archive = envelope.archive as Record<string, unknown>
  if (!Object.keys(archive).every(key => [
    "summarizedMessageBlobIds", "summary", "summaryMessageBlobId", "unsummarizedWindowTail",
  ].includes(key)) ||
      !Array.isArray(archive.summarizedMessageBlobIds) ||
      !archive.summarizedMessageBlobIds.every(id => typeof id === "string" && /^(?:[0-9a-f]{2})*$/.test(id)) ||
      archive.summary === null || typeof archive.summary !== "object" || Array.isArray(archive.summary) ||
      typeof archive.summaryMessageBlobId !== "string" || !/^(?:[0-9a-f]{2})*$/.test(archive.summaryMessageBlobId) ||
      !Number.isInteger(archive.unsummarizedWindowTail) || (archive.unsummarizedWindowTail as number) < 0 ||
      (archive.unsummarizedWindowTail as number) > 0xffff_ffff) return false
  const summary = archive.summary as Record<string, unknown>
  return Object.keys(summary).every(key => ["content", "classification", "fieldName"].includes(key)) &&
    typeof summary.content === "string" && typeof summary.classification === "string" &&
    CLASSIFICATIONS.has(summary.classification) && typeof summary.fieldName === "string"
}

export function createSlateConversationSummaryArchiveSerde(
  privacyMode: PrivacyMode,
): Serde<SlateStoredConversationSummaryArchive> {
  return {
    serialize(archive) {
      if (!Number.isInteger(archive.unsummarizedWindowTail) ||
          archive.unsummarizedWindowTail < 0 || archive.unsummarizedWindowTail > 0xffff_ffff) {
        throw new TypeError("Slate summary archive window tail is invalid")
      }
      const summary = archive.summary instanceof RedactedString
        ? {
            content: archive.summary.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
            classification: archive.summary.__classification,
            fieldName: archive.summary.__fieldName,
          }
        : { content: archive.summary, classification: DataClassification.CODE, fieldName: "summary" }
      const fields = archive.compatibility?.legacyUnknownFields
      if (fields?.some(field => !isUnknownField(field))) throw new TypeError("Slate summary archive compatibility is invalid")
      const envelope = {
        format: SUMMARY_ARCHIVE_STORAGE_FORMAT,
        version: 1,
        archive: {
          summarizedMessageBlobIds: archive.summarizedMessageBlobIds.map(toHex),
          summary,
          summaryMessageBlobId: toHex(archive.summaryMessageBlobId),
          unsummarizedWindowTail: archive.unsummarizedWindowTail,
        },
        ...(fields === undefined || fields.length === 0
          ? {}
          : { compatibility: { legacyUnknownFields: copyUnknownFields(fields) } }),
      }
      return utf8Serde.serialize(`SLATE-AGENT-SUMMARY-ARCHIVE\n${JSON.stringify(envelope)}`)
    },
    deserialize(bytes) {
      if (bytes.length >= SUMMARY_ARCHIVE_STORAGE_HEADER.length &&
          SUMMARY_ARCHIVE_STORAGE_HEADER.every((byte, index) => bytes[index] === byte)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(utf8Serde.deserialize(bytes.subarray(SUMMARY_ARCHIVE_STORAGE_HEADER.length)))
        } catch (error) {
          throw new TypeError("Stored Slate summary archive is not valid JSON", { cause: error })
        }
        if (!isStoredSummaryArchive(parsed)) throw new TypeError("Stored Slate summary archive envelope is invalid")
        const envelope = parsed as {
          readonly archive: {
            readonly summarizedMessageBlobIds: readonly string[]
            readonly summary: { readonly content: string; readonly classification: DataClassificationValue; readonly fieldName: string }
            readonly summaryMessageBlobId: string
            readonly unsummarizedWindowTail: number
          }
          readonly compatibility?: SlateConversationSummaryArchive["compatibility"]
        }
        return {
          summarizedMessageBlobIds: envelope.archive.summarizedMessageBlobIds.map(fromHex),
          summary: createRedactedString(
            envelope.archive.summary.content,
            envelope.archive.summary.classification,
            envelope.archive.summary.fieldName,
            privacyMode,
          ),
          summaryMessageBlobId: fromHex(envelope.archive.summaryMessageBlobId),
          unsummarizedWindowTail: envelope.archive.unsummarizedWindowTail,
          ...(envelope.compatibility === undefined
            ? {}
            : { compatibility: { legacyUnknownFields: copyUnknownFields(envelope.compatibility.legacyUnknownFields) } }),
        }
      }
      const legacy = ConversationSummaryArchive.fromBinary(bytes)
      const fields = collectUnknownFields(legacy)
      const redacted = toRedactedConversationSummaryArchive(legacy, privacyMode)
      return {
        summarizedMessageBlobIds: legacy.summarizedMessages.map(id => new Uint8Array(id)),
        summary: redacted.summary as unknown as RedactedString,
        summaryMessageBlobId: new Uint8Array(legacy.summaryMessage),
        unsummarizedWindowTail: legacy.windowTail,
        ...(fields.length === 0 ? {} : { compatibility: { legacyUnknownFields: fields } }),
      }
    },
    getBlobType() {
      return { kind: "json", typeName: SUMMARY_ARCHIVE_STORAGE_FORMAT }
    },
  }
}

export function deserializeSlateConversationSummaryArchiveInterop(bytes: Uint8Array): ConversationSummaryArchive {
  const archive = createSlateConversationSummaryArchiveSerde("unspecified").deserialize(bytes)
  return toInteropConversationSummaryArchive(archive)
}

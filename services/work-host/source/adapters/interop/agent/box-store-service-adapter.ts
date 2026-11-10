/** Translates the counterpart's box-store service messages to Slate's object-store port. */

import type { BoxStoreServicePort, BoxStoreWritePlan, BoxStoreWriteInstruction } from "../../../host/boxes/box-store-sync/box-store-service-contract.ts"

export interface InteropBoxStoreWriteInstruction {
  readonly relPath: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly multipart?: {
    readonly context: unknown | null
    readonly parts: readonly {
      readonly partNumber: number
      readonly offsetBytes: bigint
      readonly sizeBytes: bigint
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }[]
  }
}

export interface InteropBoxStoreServiceClient {
  presignSandBoxStoreReads(args: { readonly relPaths: readonly string[] }): Promise<{ readonly instructions: readonly { readonly relPath: string; readonly url: string; readonly expiresAtMs: bigint | number }[] }>
  statSandBoxStoreObject(args: { readonly relPath: string }): Promise<{ readonly exists: boolean; readonly etag: string }>
  presignSandBoxStoreWrites(args: { readonly files: readonly {
    readonly relPath: string
    readonly sha256: string
    readonly sizeBytes: bigint
    readonly contentAddressed: boolean
    readonly ifMatchEtag: string
    readonly expectAbsent: boolean
    readonly multipartParts?: readonly { readonly partNumber: number; readonly sizeBytes: bigint; readonly sha256: string }[]
  }[] }): Promise<{ readonly instructions: readonly InteropBoxStoreWriteInstruction[] }>
  completeSandBoxStoreMultipartWrites(args: { readonly completions: readonly {
    readonly context: unknown
    readonly parts: readonly { readonly partNumber: number; readonly etag: string }[]
  }[] }): Promise<{ readonly results: readonly {
    readonly outcome:
      | { readonly case: "success"; readonly value?: unknown }
      | { readonly case: "failure"; readonly value: { readonly code: number } }
      | { readonly case: undefined; readonly value?: undefined }
  }[] }>
  abortSandBoxStoreMultipartWrites(args: { readonly uploads: readonly { readonly context: unknown }[] }): Promise<unknown>
  listSandBoxStoreObjects(args: { readonly prefix: string; readonly cursor: string; readonly maxEntries: number }): Promise<{
    readonly entries: readonly { readonly relPath: string }[]
    readonly truncated: boolean
    readonly nextCursor: string
  }>
}

function toInteropWritePlan(plan: BoxStoreWritePlan) {
  return {
    relPath: plan.key,
    sha256: plan.digest,
    sizeBytes: plan.size,
    contentAddressed: plan.contentAddressed,
    ifMatchEtag: plan.expectedEtag,
    expectAbsent: plan.requireAbsent,
    ...(plan.multipartParts === undefined ? {} : {
      multipartParts: plan.multipartParts.map(part => ({
        partNumber: part.partNumber,
        sizeBytes: part.size,
        sha256: part.digest,
      })),
    }),
  }
}

function fromInteropWriteInstruction(instruction: InteropBoxStoreWriteInstruction): BoxStoreWriteInstruction {
  return {
    key: instruction.relPath,
    url: instruction.url,
    headers: instruction.headers,
    ...(instruction.multipart == null ? {} : {
      multipart: {
        uploadContext: instruction.multipart.context,
        parts: instruction.multipart.parts.map(part => ({
          partNumber: part.partNumber,
          offset: part.offsetBytes,
          length: part.sizeBytes,
          url: part.url,
          headers: part.headers,
        })),
      },
    }),
  }
}

const MULTIPART_FAILURE_NAMES = [
  "UNSPECIFIED",
  "PRECONDITION_FAILED",
  "UPLOAD_NOT_FOUND",
  "INVALID_PARTS",
  "CHECKSUM_MISMATCH",
  "TRANSIENT",
  "INTERNAL",
  "RESTART_REQUIRED",
] as const

function multipartCompletionFromInterop(code: number):
  | { readonly kind: "already-present" }
  | { readonly kind: "retryable-failure"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string } {
  if (code === 1) return { kind: "already-present" }
  const message = MULTIPART_FAILURE_NAMES[code] ?? `UNKNOWN_${code}`
  return code === 5 ? { kind: "retryable-failure", message } : { kind: "rejected", message }
}

/** Keeps counterpart field names and one-of cases on this edge of the box-store implementation. */
export function adaptInteropBoxStoreService(client: InteropBoxStoreServiceClient): BoxStoreServicePort {
  return {
    async presignReads(keys) {
      const response = await client.presignSandBoxStoreReads({ relPaths: [...keys] })
      return response.instructions.map(instruction => ({
        key: instruction.relPath,
        url: instruction.url,
        expiresAtMs: Number(instruction.expiresAtMs),
      }))
    },
    statObject: key => client.statSandBoxStoreObject({ relPath: key }),
    async presignWrites(plans) {
      const response = await client.presignSandBoxStoreWrites({ files: plans.map(toInteropWritePlan) })
      return response.instructions.map(fromInteropWriteInstruction)
    },
    async completeMultipartUpload({ uploadContext, parts }) {
      const response = await client.completeSandBoxStoreMultipartWrites({
        completions: [{ context: uploadContext, parts: [...parts] }],
      })
      const outcome = response.results[0]?.outcome
      if (outcome?.case === "success") return { kind: "success" }
      if (outcome?.case === "failure") return multipartCompletionFromInterop(outcome.value.code)
      return { kind: "missing" }
    },
    async abortMultipartUpload(uploadContext) {
      await client.abortSandBoxStoreMultipartWrites({ uploads: [{ context: uploadContext }] })
    },
    async listPage({ prefix, cursor, pageSize }) {
      const page = await client.listSandBoxStoreObjects({ prefix, cursor, maxEntries: pageSize })
      return { keys: page.entries.map(entry => entry.relPath), hasMore: page.truncated, nextCursor: page.nextCursor }
    },
  }
}

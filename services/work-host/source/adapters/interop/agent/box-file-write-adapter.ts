import type { Context } from "../../../packages/context/context.ts"
import { writeExecutorResource, type WriteExecutor } from "../../../packages/agent-exec/write-operation.ts"

export interface BoxFileWriteAccessor {
  get(resource: typeof writeExecutorResource): WriteExecutor
}

export type BoxFileWriteOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "other"; readonly case: string | undefined }

export async function writeBoxFileBytesThroughInterop(
  context: Context,
  accessor: BoxFileWriteAccessor,
  path: string,
  bytes: Uint8Array,
  toolCallId: string,
): Promise<BoxFileWriteOutcome> {
  const response = await accessor.get(writeExecutorResource).execute(
    context,
    {
      path,
      bytes: Uint8Array.from(bytes),
      toolCallId,
    },
  )

  if (response.kind === "success") return { kind: "success" }
  if (response.kind === "error") return { kind: "error", message: response.error }
  if (response.kind === "rejected") return { kind: "rejected", reason: response.reason }
  if (response.kind === "permission-denied") return { kind: "other", case: "permissionDenied" }
  if (response.kind === "no-space") return { kind: "other", case: "noSpace" }
  return { kind: "other", case: undefined }
}

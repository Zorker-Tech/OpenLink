import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.ts"
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
    new WriteArgs({
      path,
      fileBytes: Uint8Array.from(bytes),
      toolCallId,
    }),
  )

  const result = response.result
  if (result.case === "success") return { kind: "success" }
  if (result.case === "error") return { kind: "error", message: result.value.error }
  if (result.case === "rejected") return { kind: "rejected", reason: result.value.reason }
  return { kind: "other", case: result.case }
}

import type { Context } from "../../../packages/context/context.ts"
import {
  InvocationContext,
  type InvocationContext as InvocationContextMessage,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import {
  readInvocationBlob,
  type InvocationContextBlobStore,
} from "../../../packages/agent/context/invocation-hydration.ts"

export interface HydrateSelectedInvocationContextArgs {
  readonly ctx: Context
  readonly invocationContext?: InvocationContextMessage | undefined
  readonly blobStore?: InvocationContextBlobStore | undefined
}

export async function hydrateSelectedInvocationContext({
  ctx,
  invocationContext,
  blobStore,
}: HydrateSelectedInvocationContextArgs): Promise<InvocationContextMessage | undefined> {
  if (!invocationContext) return undefined
  if (invocationContext.data.case !== "blobId") return invocationContext

  const bytes = await readInvocationBlob({
    ctx,
    blobId: invocationContext.data.value,
    blobStore,
  })
  return InvocationContext.fromBinary(bytes)
}

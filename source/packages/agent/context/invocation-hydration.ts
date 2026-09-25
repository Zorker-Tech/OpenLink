/**
 * Turning an invocation reference into the invocation itself.
 *
 * A message can point at a previous invocation rather than carrying it, which keeps the conversation
 * small but means the reference has to be resolved before the turn can use it. A reference that points at
 * a blob is fetched and decoded; one that already carries the data is returned as it is. Both failures
 * are thrown rather than swallowed: a turn told to continue from an invocation it cannot read would
 * otherwise proceed as if there were nothing to continue from.
 */

import type { Context } from "../../context/context.ts"
import {
  InvocationContext,
  type InvocationContext as InvocationContextMessage,
} from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface InvocationContextBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
}

export interface HydrateInvocationContextArgs {
  readonly ctx: Context
  readonly invocationContext?: InvocationContextMessage | undefined
  readonly blobStore?: InvocationContextBlobStore | undefined
}

export async function hydrateSelectedInvocationContext({
  ctx,
  invocationContext,
  blobStore,
}: HydrateInvocationContextArgs): Promise<InvocationContextMessage | undefined> {
  if (!invocationContext) return undefined
  if (invocationContext.data.case === "blobId") {
    if (!blobStore) throw new Error("Blob store is required to hydrate invocation context blob")
    const blobData = await blobStore.getBlob(ctx, invocationContext.data.value)
    if (!blobData) throw new Error("Invocation context blob not found")
    return InvocationContext.fromBinary(blobData)
  }
  return invocationContext
}

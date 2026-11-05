import type { Context } from "../../../packages/context/context.ts"
import {
  InvocationContext,
  type InvocationContext as InvocationContextMessage,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import {
  readInvocationBlob,
  type InvocationContextBlobStore,
} from "../../../packages/agent/context/invocation-hydration.ts"
import type { SlateInvocationSelection } from "../../../packages/agent/context/selected-context-processing-contracts.ts"
import type { SlateInvocationContext } from "../../../packages/agent/context/invocation-platforms.ts"
import { toSlateInvocationContext } from "./invocation-platforms-adapter.ts"

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

/** Resolves Slate's invocation selection while keeping the historical blob decoder inside interop. */
export async function resolveSlateInvocationSelection(input: {
  readonly ctx: Context
  readonly selection: SlateInvocationSelection | undefined
  readonly blobStore?: InvocationContextBlobStore | undefined
}): Promise<SlateInvocationContext | undefined> {
  const { selection } = input
  if (selection === undefined) return undefined
  if (selection.kind === "inline") return selection.context

  const bytes = await readInvocationBlob({
    ctx: input.ctx,
    blobId: selection.blobId,
    blobStore: input.blobStore,
  })
  return toSlateInvocationContext(InvocationContext.fromBinary(bytes))
}

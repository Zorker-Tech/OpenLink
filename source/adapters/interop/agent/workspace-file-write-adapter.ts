/** Encodes a Slate workspace-file write as the counterpart executor request. */

import type { Context } from "../../../packages/context/context.ts"
import { writeExecutorResource, type WriteExecutorArgs } from "../../../packages/agent-exec/write-operation.ts"

export interface InteropWorkspaceFileWriteAccessor {
  get(resource: typeof writeExecutorResource): {
    execute(context: Context, args: WriteExecutorArgs): Promise<unknown>
  }
}

export function writeWorkspaceBytesThroughInterop(
  accessor: InteropWorkspaceFileWriteAccessor,
  context: Context,
  path: string,
  content: Uint8Array,
): Promise<unknown> {
  return accessor.get(writeExecutorResource).execute(context, {
    path,
    bytes: new Uint8Array(content),
    includeContentAfterWrite: false,
  })
}

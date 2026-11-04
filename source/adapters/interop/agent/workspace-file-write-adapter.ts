/** Encodes a Slate workspace-file write as the counterpart executor request. */

import type { Context } from "../../../packages/context/context.ts"
import { writeExecutorResource } from "../../../packages/agent-exec/write-operation.ts"
import { WriteArgs } from "../proto/generated/agent/v1/write_exec_pb.ts"

export interface InteropWorkspaceFileWriteAccessor {
  get(resource: typeof writeExecutorResource): {
    execute(context: Context, args: WriteArgs): Promise<unknown>
  }
}

export function writeWorkspaceBytesThroughInterop(
  accessor: InteropWorkspaceFileWriteAccessor,
  context: Context,
  path: string,
  content: Uint8Array,
): Promise<unknown> {
  return accessor.get(writeExecutorResource).execute(context, new WriteArgs({
    path,
    fileBytes: new Uint8Array(content),
    returnFileContentAfterWrite: false,
  }))
}

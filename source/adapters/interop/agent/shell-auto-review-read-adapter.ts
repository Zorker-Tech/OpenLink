/** Executes the read requests used by shell auto-review and projects generated file responses to a Slate text record. */

import { ReadArgs } from "../proto/generated/agent/v1/read_exec_pb.ts"
import { readExecutorResource } from "../../../packages/agent-exec/read-operation.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { BoundedText, SlateShellReadAccessor } from "../../../host/runner/slate-shell-auto-review-enrichment.ts"

export function slateShellReadAccessorFromInterop(
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
): SlateShellReadAccessor<Context> {
  return {
    async read(context, request): Promise<BoundedText | undefined> {
      const result = await resourceAccessor.get(readExecutorResource).execute(
        context,
        new ReadArgs({
          path: request.path,
          toolCallId: request.toolCallId,
          offset: request.offset,
          limit: request.limit,
        }),
      )
      if (result.result.case !== "success") return undefined
      const response = result.result.value
      if (response.output.case !== "content") return undefined
      return {
        content: response.output.value,
        totalLines: response.totalLines,
        truncated: response.truncated,
      }
    },
  }
}

/** Executes shell-review reads through Slate's contract and projects text into the review record. */

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
        {
          path: request.path,
          toolCallId: request.toolCallId,
          offset: request.offset,
          limit: request.limit,
        },
      )
      if (result.kind !== "success" || result.output?.kind !== "text") return undefined
      return {
        content: result.output.text,
        totalLines: result.totalLines,
        truncated: result.truncated,
      }
    },
  }
}

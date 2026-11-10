/** Reads plan text through Slate's executor contract and projects the result into the plan policy. */
import type { Context } from "../../../packages/context/context.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import { readExecutorResource } from "../../../packages/agent-exec/read-operation.ts"

export type PlanFileReadOutcome =
  | { readonly kind: "content"; readonly content: string }
  | { readonly kind: "read_failed"; readonly resultCase: string | undefined }
  | { readonly kind: "not_text"; readonly outputCase: string | undefined }

export async function readPlanFileForTodoSync(input: {
  readonly context: Context
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>
  readonly path: string
  readonly toolCallId: string
  readonly execId: string
}): Promise<PlanFileReadOutcome> {
  const readExecutor = input.resourceAccessor.get(readExecutorResource)
  const result = await readExecutor.execute(input.context, { path: input.path, toolCallId: input.toolCallId }, {
    execId: input.execId,
  })
  if (result.kind !== "success") return { kind: "read_failed", resultCase: result.kind === "unrecognized" ? result.caseName : result.kind }
  if (result.output?.kind !== "text") return { kind: "not_text", outputCase: result.output?.kind }
  return { kind: "content", content: result.output.text }
}

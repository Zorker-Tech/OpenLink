/** Reads plan text through the generated executor request and projects its result into a Slate outcome. */
import type { Context } from "../../../packages/context/context.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import { readExecutorResource } from "../../../packages/agent-exec/read-operation.ts"
import { ReadArgs } from "../proto/generated/agent/v1/read_exec_pb.ts"

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
  const result = await readExecutor.execute(input.context, new ReadArgs({ path: input.path, toolCallId: input.toolCallId }), {
    execId: input.execId,
  })
  if (result.result.case !== "success") return { kind: "read_failed", resultCase: result.result.case }
  const output = result.result.value.output
  if (output.case !== "content") return { kind: "not_text", outputCase: output.case }
  return { kind: "content", content: output.value }
}

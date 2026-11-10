import { createReadonlyExecRefusalExecutors } from "../../adapters/interop/agent/readonly-exec-refusal-adapter.ts"
import { backgroundShellExecutorResource } from "./background-shell.ts"
import { deleteExecutorResource } from "./delete.ts"
import { mcpExecutorResource } from "./mcp-operations.ts"
import type { RemoteExecManager } from "./executor-resources.ts"
import {
  CombinedResourceAccessor,
  type RemoteResource,
  type ResourceAccessor,
} from "./resource-provider.ts"
import { shellExecutorResource } from "./shell.ts"
import { shellStreamExecutorResource } from "./shell-stream-operation.ts"
import { writeExecutorResource } from "./write-operation.ts"

const REFUSAL_REASON = "This operation is not allowed in readonly mode. The subagent was launched with readonly: true, which restricts write operations."

function deniedResources(wrapShell: boolean): Array<readonly [RemoteResource<unknown, RemoteExecManager>, unknown]> {
  const denied = createReadonlyExecRefusalExecutors(REFUSAL_REASON)
  const overrides: Array<readonly [RemoteResource<unknown, RemoteExecManager>, unknown]> = [
    [writeExecutorResource, denied.write],
    [deleteExecutorResource, denied.delete],
    [mcpExecutorResource, denied.mcp],
  ]
  if (wrapShell) {
    overrides.push(
      [shellExecutorResource, denied.shell],
      [shellStreamExecutorResource, denied.shellStream],
      [backgroundShellExecutorResource, denied.backgroundShell],
    )
  }
  return overrides
}

/** Replace mutating operations with refusals while leaving every other resource on its original accessor. */
export function createReadonlyResourceAccessor(
  baseAccessor: ResourceAccessor<RemoteExecManager>,
  wrapShell: boolean,
): ResourceAccessor<RemoteExecManager> {
  return new CombinedResourceAccessor(baseAccessor, deniedResources(wrapShell))
}

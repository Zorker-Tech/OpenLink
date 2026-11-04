import { computerUseExecutorResource } from "../../adapters/interop/agent/computer-use-executor-adapter.ts"
import { readExecutorResource } from "../../packages/agent-exec/read-operation.ts"
import {
  CombinedResourceAccessor,
  RemoteResourceAccessor,
  resourceEntry,
  type ResourceAccessor,
} from "../../packages/agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts"
import type { FileTransferAccessor } from "./box-file-transfer.ts"
import type { ShellAccessor } from "./box-windows.ts"
import { noMonitorComputerUseExecutor } from "../ports/box.ts"

export type ProductionGeneratedBoxAccessor = ResourceAccessor<RemoteExecManager> & ShellAccessor & FileTransferAccessor

export function createProductionBoxAccessPolicies() {
  return {
    createResourceAccessor(manager: RemoteExecManager): ProductionGeneratedBoxAccessor {
      return new RemoteResourceAccessor(manager)
    },
    withFileReadGuard(
      accessor: ProductionGeneratedBoxAccessor,
      assertFileReadAllowed: (path: string) => Promise<void>,
    ): ProductionGeneratedBoxAccessor {
      return new CombinedResourceAccessor(accessor, [
        resourceEntry(readExecutorResource, {
          async execute(ctx, args, options) {
            await assertFileReadAllowed(args.path)
            return await accessor.get(readExecutorResource).execute(ctx, args, options)
          },
        }),
      ])
    },
    withNoMonitorComputerUse(accessor: ProductionGeneratedBoxAccessor): ProductionGeneratedBoxAccessor {
      return new CombinedResourceAccessor(accessor, [
        resourceEntry(computerUseExecutorResource, noMonitorComputerUseExecutor),
      ])
    },
  }
}

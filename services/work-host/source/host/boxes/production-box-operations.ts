import {
  applyBoxEnvironmentViaTransport,
} from "./box-environment-control.ts"
import { uploadFileViaExecDaemon } from "./box-file-transfer.ts"
import {
  createBoxRemoteResourceAccessorFromTransport,
  pingBoxTransportClassified,
  type BoxEndpoint,
} from "./box-remote-accessor.ts"
import type { LoopbackOperations, PingResult } from "./loopback-box-contracts.ts"
import type { ShellAccessor } from "./box-windows.ts"
import type { FileTransferAccessor } from "./box-file-transfer.ts"
import type { ProductionBoxGeneratedPorts } from "./production.ts"
import { executeBoxWindowShellCommand } from "../../adapters/interop/agent/box-window-shell-result-adapter.ts"

/** Keep the transport and generated client factories behind one loopback capability set. */
export function createProductionBoxOperations<
  Transport,
  Accessor extends ShellAccessor & FileTransferAccessor,
>(
  generated: ProductionBoxGeneratedPorts<Transport, Accessor>,
  transportFor: (endpoint: BoxEndpoint) => Transport,
): LoopbackOperations<Accessor> {
  const controlClientFor = (transport: Transport) => generated.createControlClient(transport)

  return {
    async ping(context, endpoint): Promise<PingResult> {
      const outcome = await pingBoxTransportClassified(
        context,
        transportFor(endpoint),
        controlClientFor,
      )
      return outcome.causeSummary === undefined
        ? { outcome: outcome.outcome }
        : { outcome: outcome.outcome, causeSummary: outcome.causeSummary }
    },

    createRemoteAccessor(endpoint): Accessor {
      const transport = transportFor(endpoint)
      return createBoxRemoteResourceAccessorFromTransport(transport, {
        createExecClient: generated.createExecClient,
        createResourceAccessor: generated.createResourceAccessor,
      })
    },

    protectRemoteAccessor(accessor, assertFileReadAllowed): Accessor {
      return generated.withFileReadGuard(accessor, assertFileReadAllowed)
    },

    executeWindowCommand: executeBoxWindowShellCommand,

    async applyEnvironment(context, endpoint, update): Promise<void> {
      await applyBoxEnvironmentViaTransport(
        context,
        transportFor(endpoint),
        update,
        controlClientFor,
      )
    },

    async loadMcpServers(context, endpoint, configJson): Promise<string[]> {
      const client = controlClientFor(transportFor(endpoint))
      return await client.loadServers(context, configJson)
    },

    async uploadFile(context, accessor, path, data): Promise<void> {
      await uploadFileViaExecDaemon(context, accessor, path, data)
    },
  }
}

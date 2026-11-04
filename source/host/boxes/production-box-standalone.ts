import type { HostBoxInner } from "./forever-box/host-box.ts"
import type { FileTransferAccessor } from "./box-file-transfer.ts"
import type { LoopbackBox } from "./loopback-slate-box.ts"
import { decodeBoxEnvironmentUpdate } from "./production-box-environment.ts"
import type { ProductionBoxInner } from "./production.ts"
import type { ShellAccessor } from "./box-windows.ts"

/** Present a single-window image through the same host capability surface. */
export function createSingleWindowBoxInner<Accessor extends ShellAccessor & FileTransferAccessor>(
  box: LoopbackBox<Accessor>,
  withoutDesktopMonitoring: (accessor: Accessor) => Accessor,
): ProductionBoxInner {
  return {
    ensureReady: async (context, agentId) => {
      const connection = await box.ensureReady(context, agentId)
      return {
        ...connection,
        remoteAccessor: withoutDesktopMonitoring(connection.remoteAccessor),
        vncUrl: "",
      }
    },
    runState: () => box.runState(),
    listBoxes: () => box.listBoxes(),
    uploadFile: (context, agentId, path, bytes) => box.uploadFile(context, agentId, path, bytes),
    downloadFile: (context, agentId, path) => box.downloadFile(context, agentId, path),
    releaseWindow: async () => {},
    getAgentWindowIndex: () => 1,
    maxWindows: () => 1,
    getTerminalsFolder: () => box.getTerminalsFolder(),
    isAvailable: () => box.isAvailable(),
    describe: () => box.describe(),
    applyEnvironment: (context, update) => box.applyEnvironment(context, decodeBoxEnvironmentUpdate(update)),
    loadMcpServers: (context, configJson) => box.loadMcpServers(context, configJson),
    mcpResourceAccessor: (context) => box.mcpResourceAccessor(context),
    dispose: () => box.dispose(),
  } satisfies HostBoxInner & { dispose(): Promise<void> }
}

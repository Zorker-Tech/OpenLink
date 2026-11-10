import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, SLATE_NO_LOCAL_MACHINE_MESSAGE, localExecFileTooLargeMessage } from "../../shared/local-exec-gateway.ts";
import {
  SlateLocalToolPermissionDeniedError,
  authorizeLocalToolAction,
  slateLocalToolScopeKey,
  type SlateLocalToolScope,
} from "../../shared/local-tool-permission-machinery.ts";
import type { BoxContext, GatewayLocalExecCodec, GatewayLocalToolGate, LocalExecFailureReport } from "./gateway-local-exec-contracts.ts";
import { GatewayLocalExecManager } from "./gateway-local-exec-manager.ts";
import { SlateLocalExecError } from "./local-exec-error.ts";
import { SlateLocalExecBridge } from "./local-exec-bridge.ts";

export const FALLBACK_TERMINALS_FOLDER = "terminals";

export interface GatewayLocalExecBoxOptions<Client = unknown, Accessor = GatewayLocalExecManager<Client>> {
  readonly gate: GatewayLocalToolGate;
  readonly codec: GatewayLocalExecCodec<Client, Accessor>;
  readonly computerId?: string;
  readonly maxFileBytes?: number;
  readonly reportFailure?: (report: LocalExecFailureReport) => void;
}

interface FilePermission {
  readonly conversationScope: SlateLocalToolScope | undefined;
  readonly approvalId: string | undefined;
}

export class GatewayLocalExecBox<Client = unknown, Accessor = GatewayLocalExecManager<Client>> {
  private readonly authorizationGate: GatewayLocalToolGate;
  private readonly targetComputerId: string | undefined;
  private readonly fileLimitBytes: number;

  constructor(private readonly bridgePort: SlateLocalExecBridge, private readonly capabilityConfig: GatewayLocalExecBoxOptions<Client, Accessor>) {
    this.authorizationGate = capabilityConfig.gate;
    this.targetComputerId = capabilityConfig.computerId;
    this.fileLimitBytes = capabilityConfig.maxFileBytes ?? DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES;
  }

  terminalsFolder(): string {
    return this.bridgePort.getProviderInfo()?.terminalsFolder ?? FALLBACK_TERMINALS_FOLDER;
  }

  async ensureReady(_context: BoxContext, _agentId: string): Promise<{ remoteAccessor: Accessor; vncUrl: ""; terminalsFolder: string }> {
    const manager = new GatewayLocalExecManager(
      this.bridgePort,
      this.authorizationGate,
      () => this.terminalsFolder(),
      this.capabilityConfig.codec,
      this.capabilityConfig.reportFailure,
    );
    return {
      remoteAccessor: this.capabilityConfig.codec.createRemoteAccessor(manager),
      vncUrl: "",
      terminalsFolder: this.terminalsFolder(),
    };
  }

  async hibernate(_context: BoxContext, _agentId: string): Promise<void> {}

  async runState(_context: BoxContext, _agentId: string): Promise<"running" | "absent"> {
    return this.bridgePort.hasProvider() ? "running" : "absent";
  }

  async listBoxes(): Promise<[]> {
    return [];
  }

  async uploadFile(context: BoxContext, _agentId: string, boxPath: string, data: Uint8Array): Promise<void> {
    if (data.length > this.fileLimitBytes) {
      throw new SlateLocalExecError(localExecFileTooLargeMessage(data.length, this.fileLimitBytes));
    }
    const { conversationScope, approvalId } = await this.requireFilePermission(context, "upload", "write-file", boxPath);
    const frames = this.bridgePort.request(
      this.executionContext(context, conversationScope),
      { kind: "upload", path: boxPath, bytesBase64: Buffer.from(data).toString("base64"), ...(approvalId === undefined ? {} : { approvalId }) },
      this.targetComputerId,
    );
    for await (const frame of frames) {
      if (frame.kind === "file") return;
      if (frame.kind === "file-error" && typeof frame.error === "string") throw new SlateLocalExecError(frame.error);
    }
    throw new SlateLocalExecError(SLATE_NO_LOCAL_MACHINE_MESSAGE);
  }

  async downloadFile(context: BoxContext, _agentId: string, boxPath: string): Promise<Uint8Array> {
    const { conversationScope, approvalId } = await this.requireFilePermission(context, "download", "read-file", boxPath);
    const frames = this.bridgePort.request(
      this.executionContext(context, conversationScope),
      { kind: "download", path: boxPath, ...(approvalId === undefined ? {} : { approvalId }) },
      this.targetComputerId,
    );
    for await (const frame of frames) {
      if (frame.kind === "file" && typeof frame.bytesBase64 === "string") {
        return new Uint8Array(Buffer.from(frame.bytesBase64, "base64"));
      }
      if (frame.kind === "file-error" && typeof frame.error === "string") throw new SlateLocalExecError(frame.error);
    }
    throw new SlateLocalExecError(SLATE_NO_LOCAL_MACHINE_MESSAGE);
  }

  private async requireFilePermission(
    context: BoxContext,
    site: "upload" | "download",
    action: "write-file" | "read-file",
    target: string,
  ): Promise<FilePermission> {
    const refusalReason = this.authorizationGate.blockedReason();
    if (refusalReason !== undefined) throw new SlateLocalToolPermissionDeniedError(refusalReason);
    const conversationScope = context.get(slateLocalToolScopeKey);
    const contextAgentId = conversationScope?.agentId;
    this.bridgePort.assertComputerAvailable(this.targetComputerId, {
      site,
      ...(contextAgentId === undefined ? {} : { agentId: contextAgentId }),
    });
    const approvalId = await authorizeLocalToolAction(this.authorizationGate, conversationScope, { action, target, signal: context.signal });
    return { conversationScope, approvalId };
  }

  private executionContext(context: BoxContext, scope: SlateLocalToolScope | undefined) {
    const contextAgentId = scope?.agentId;
    return { signal: context.signal, ...(contextAgentId === undefined ? {} : { agentId: contextAgentId }) };
  }
}

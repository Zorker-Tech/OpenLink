import {
  SLATE_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE,
  SlateLocalToolPermissionDeniedError,
  authorizeLocalToolAction,
  describeLocalExec,
  slateLocalToolScopeKey,
  type LocalExecMessage,
} from "../../shared/local-tool-permission-machinery.ts";
import { classifyLocalExecFailure } from "./local-exec-failure-classifier.ts";
import type {
  BoxContext,
  GatewayExecControl,
  GatewayExecServerMessage,
  GatewayLocalExecCodec,
  GatewayLocalToolGate,
  LocalExecFailureReport,
} from "./gateway-local-exec-contracts.ts";
import { SlateLocalExecBridge } from "./local-exec-bridge.ts";

function toVisibleExecRequest(
  serverMessage: GatewayExecServerMessage,
): { readonly message: LocalExecMessage } | undefined {
  const message = serverMessage.message;
  if (typeof message?.case !== "string" || message.value == null || typeof message.value !== "object" || Array.isArray(message.value)) {
    return undefined;
  }
  return { message: { case: message.case, value: message.value } };
}

export class GatewayLocalExecManager<Client = unknown> {
  private nextRequestOrdinal = 0;

  constructor(
    private readonly bridgePort: SlateLocalExecBridge,
    private readonly authorizationGate: GatewayLocalToolGate,
    private readonly terminalFolder: () => string,
    private readonly responseCodec: GatewayLocalExecCodec<Client>,
    private readonly failureReporter?: (report: LocalExecFailureReport) => void,
  ) {}

  async *createExecInstance(
    context: BoxContext,
    serializeArguments: (requestOrdinal: number) => GatewayExecServerMessage,
  ): AsyncGenerator<Client> {
    const requestEnvelope = serializeArguments(this.nextRequestOrdinal++);
    const visibleShape = toVisibleExecRequest(requestEnvelope);
    const actionForApproval = visibleShape === undefined
      ? undefined
      : describeLocalExec(visibleShape, this.terminalFolder());
    const conversationScope = context.get(slateLocalToolScopeKey);
    const refusalReason = this.authorizationGate.blockedReason();

    if (refusalReason !== undefined) throw new SlateLocalToolPermissionDeniedError(refusalReason);
    if (actionForApproval === undefined && this.authorizationGate.requiresApproval()) {
      throw new SlateLocalToolPermissionDeniedError(SLATE_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE);
    }

    const contextAgentId = conversationScope?.agentId;
    const attribution = contextAgentId === undefined ? {} : { agentId: contextAgentId };
    this.bridgePort.assertComputerAvailable(undefined, {
      site: "exec",
      ...attribution,
    });
    const approvalId = actionForApproval === undefined
      ? undefined
      : await authorizeLocalToolAction(this.authorizationGate, conversationScope, { ...actionForApproval, signal: context.signal });
    const bridgeContext = { signal: context.signal, ...attribution };
    const frames = this.bridgePort.request(
      bridgeContext,
      {
        kind: "exec",
        serverMessage: this.responseCodec.encodeRequest?.(requestEnvelope) ?? requestEnvelope.toJson(),
        ...(approvalId === undefined ? {} : { approvalId }),
      },
      undefined,
      { watchResponse: true },
    );

    for await (const frame of frames) {
      if (frame.kind === "client") {
        yield this.responseCodec.decodeClient(frame.message);
        continue;
      }
      if (frame.kind !== "control") continue;
      const control: GatewayExecControl = this.responseCodec.decodeControl(frame.message);
      if (control.case === "throw") {
        const message = control.error;
        this.failureReporter?.({
          ...classifyLocalExecFailure(message),
          site: "exec",
          ...(contextAgentId === undefined ? {} : { conversationId: contextAgentId }),
        });
        const error = new Error(message);
        if (control.stackTrace != null && control.stackTrace.length > 0) error.stack = control.stackTrace;
        throw error;
      }
      if (control.case === "streamClose") return;
    }
  }
}

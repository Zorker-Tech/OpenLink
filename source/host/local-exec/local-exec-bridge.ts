/** Routes host requests to the selected local machine and returns its matching frames. */
import { randomUUID } from "node:crypto";
import type { IdleWatchdogPolicy } from "../extensions/scheduling.ts";
import { SlateLocalExecError } from "./local-exec-error.ts";
import { LocalExecProviderDirectory } from "./local-exec-provider-directory.ts";
import { LocalExecResponseChannels } from "./local-exec-response-channels.ts";
import { slateComputerUnavailableMessage } from "../../shared/local-exec-gateway.ts";
import type {
  LocalExecBridgeContext,
  LocalExecBridgeDeps,
  LocalExecBridgeFrame,
  LocalExecComputer,
  LocalExecProviderInfo,
} from "./local-exec-bridge-contracts.ts";

export {
  DEFAULT_SLATE_COMPUTER_ID,
  SUPERVISED_RANK,
  TELEMETRY_VARIANTS,
  VARIANT_RANKS,
  boundedLocalExecVariant,
  localExecProviderRank,
} from "./local-exec-bridge-contracts.ts";
export type {
  LocalExecBridgeContext,
  LocalExecBridgeDeps,
  LocalExecBridgeFrame,
  LocalExecComputer,
  LocalExecProviderInfo,
  LocalExecProviderReport,
  LocalExecRefusedReport,
} from "./local-exec-bridge-contracts.ts";

export class SlateLocalExecBridge {
  private readonly providerDirectory: LocalExecProviderDirectory;
  private readonly responses = new LocalExecResponseChannels();

  constructor(private readonly deps: LocalExecBridgeDeps) {
    this.providerDirectory = new LocalExecProviderDirectory({
      clock: deps.clock,
      ...(deps.report === undefined ? {} : { report: deps.report }),
      ...(deps.randomId === undefined ? {} : { randomId: deps.randomId }),
    });
  }

  registerProvider(send: (frame: LocalExecBridgeFrame) => void): () => void {
    return this.providerDirectory.register(send);
  }

  hasProvider(): boolean {
    return this.providerDirectory.hasProvider();
  }

  isComputerLive(computerId: string): boolean {
    return this.providerDirectory.isComputerLive(computerId);
  }

  assertComputerAvailable(computerId: string | undefined, gate: { readonly site: string; readonly agentId?: string }): void {
    this.providerDirectory.assertComputerAvailable(computerId, gate);
  }

  checkLiveComputerForAsk(agentId?: string): boolean {
    return this.providerDirectory.checkLiveComputerForAsk(agentId);
  }

  listComputers(): LocalExecComputer[] {
    return this.providerDirectory.listComputers();
  }

  activeComputer(): LocalExecComputer | undefined {
    return this.providerDirectory.activeComputer();
  }

  getProviderInfo(): LocalExecProviderInfo | undefined {
    return this.providerDirectory.getProviderInfo();
  }

  submitResponses(batch: { readonly providerId?: string; readonly frames?: readonly LocalExecBridgeFrame[] }): void {
    const provider = this.providerDirectory.providerForBatch(batch.providerId);
    for (const frame of batch.frames ?? []) {
      if (frame.kind === "hello") {
        if (provider !== undefined) this.providerDirectory.acceptHello(provider, frame);
        continue;
      }
      if (frame.kind === "ping") {
        if (provider !== undefined) this.providerDirectory.acceptHeartbeat(provider, frame);
        continue;
      }
      this.responses.route(frame);
    }
  }

  retireApproval(approvalId: string): void {
    for (const provider of this.providerDirectory.all()) {
      try {
        provider.send({ kind: "retire-approval", requestId: this.nextId(), approvalId });
      } catch {
        // One disconnected provider must not prevent other machines from retiring the approval.
      }
    }
  }

  async *request(
    context: LocalExecBridgeContext,
    frame: LocalExecBridgeFrame,
    computerId?: string,
    options?: { readonly watchResponse?: boolean },
  ): AsyncGenerator<LocalExecBridgeFrame> {
    if (context.signal.aborted) return;
    const blockedReason = this.deps.blockedReason();
    if (blockedReason !== undefined) throw new SlateLocalExecError(blockedReason);

    const provider = this.providerDirectory.require(computerId, {
      site: frame.kind,
      ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
    });
    const requestId = this.nextId();
    const replies = this.responses.open(requestId);
    const cancelRemote = () => {
      try {
        provider.send({ kind: "cancel", requestId });
      } catch {
        // Cancellation is best effort because the provider may already have closed.
      }
    };
    const abortRequest = () => {
      cancelRemote();
      this.responses.close(requestId);
    };
    context.signal.addEventListener("abort", abortRequest, { once: true });

    let timedOut = false;
    let responseWatchdog: ReturnType<IdleWatchdogPolicy["arm"]> | undefined;
    const refreshWatchdog = () => {
      if (options?.watchResponse !== true) return;
      if (responseWatchdog === undefined) {
        responseWatchdog = this.deps.responseWatchdog.arm(() => {
          timedOut = true;
          abortRequest();
        });
      } else {
        responseWatchdog.kick();
      }
    };

    try {
      provider.send({ requestId, ...frame });
      refreshWatchdog();
      for await (const response of replies) {
        refreshWatchdog();
        yield response;
      }
      if (timedOut) throw new SlateLocalExecError(slateComputerUnavailableMessage(provider.label));
    } finally {
      responseWatchdog?.dispose();
      this.responses.close(requestId);
      context.signal.removeEventListener("abort", abortRequest);
      if (!context.signal.aborted) cancelRemote();
    }
  }

  private nextId(): string {
    return this.deps.randomId?.() ?? randomUUID();
  }
}

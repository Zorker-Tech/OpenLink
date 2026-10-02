/**
 * The transcript, declared as a host extension.
 *
 * Starting it builds the transcript manager over the host's own pieces — the session store, telemetry and its tracing
 * flusher, memory, content search, attachments and trays — rooted under the host's data directory, hands the roster an
 * outline stream to coalesce, mirrors the turn execution the host declared, and tells the host what the transcript is
 * doing, until the host stops it and everything is let go.
 */
import {
  createDebouncePolicy,
  realClock,
} from "../extensions/scheduling.ts";
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { getSlateRootDir } from "../host-paths.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { PromptAcceptanceLedger } from "./prompt-acceptance-ledger.ts";
import { OUTLINE_STREAM_COALESCE_MS } from "./roster-projection.ts";
import { SlateAckObligationStore } from "./slate-ack-obligation-store.ts";
import { SlatePendingWakeStore } from "./slate-pending-wake-store.ts";
import { SlateUpgradeResumeStore } from "./slate-upgrade-resume-store.ts";
import {
  TranscriptManager,
  type TurnExecutionPort,
} from "./transcript-manager.ts";

interface TranscriptHost {
  readonly events: {
    emit(topic: string, payload: unknown): Promise<void> | void;
  };
}

interface TranscriptExtensionDeps {
  readonly session: { readonly store: any };
  readonly telemetry: {
    readonly brain: any;
    readonly analytics: any;
    readonly flushTracing: () => void;
  };
  readonly memory: any;
  readonly "content-search": any;
  readonly attachments: any;
  readonly trays: any;
  readonly "turn-execution": {
    readonly canExecute: boolean;
    isRunReady(): Promise<boolean>;
    createRunner(...args: any[]): any;
    createGroupMemberRunner(...args: any[]): any;
  };
}

export const transcriptExtension = defineHostExtension<
  TranscriptManager,
  TranscriptHost
>({
  id: HostExtensions.Transcript,
  dependencies: [
    HostExtensions.Attachments,
    HostExtensions.ContentSearch,
    HostExtensions.Memory,
    HostExtensions.Session,
    HostExtensions.Telemetry,
    HostExtensions.Trays,
    HostExtensions.TurnExecution,
  ],
  start: (context) => {
    const deps = context.deps as unknown as TranscriptExtensionDeps;
    const slateRoot = getSlateRootDir();
    const manager = new TranscriptManager(
      deps.session.store,
      new SlateUpgradeResumeStore(slateRoot),
      new SlateAckObligationStore(slateRoot),
      new PromptAcceptanceLedger(slateRoot),
      new SlatePendingWakeStore(slateRoot),
    );
    manager.setTelemetry(deps.telemetry.brain);
    manager.setProductAnalytics(deps.telemetry.analytics);
    manager.setTraceFlusher(deps.telemetry.flushTracing);
    manager.setMemory(deps.memory);
    manager.setContentSearch(deps[HostExtensions.ContentSearch]);
    manager.setAttachments(deps.attachments);
    manager.setTrayErrors(deps.trays);
    const outlineCoalescing = createDebouncePolicy(realClock, {
      name: "transcript-outline-stream",
      delayMs: OUTLINE_STREAM_COALESCE_MS,
    });
    const setOutlineStreamCoalescing = (
      manager.roster as unknown as {
        setOutlineStreamCoalescing?: (policy: typeof outlineCoalescing) => void;
      }
    ).setOutlineStreamCoalescing;
    setOutlineStreamCoalescing?.call(manager.roster, outlineCoalescing);

    const execution = deps[HostExtensions.TurnExecution];
    manager.setTurnExecution({
      get canExecute() {
        return execution.canExecute;
      },
      get canExecuteGroupMember() {
        return execution.canExecute;
      },
      isRunReady: () => execution.isRunReady(),
      createRunner: (...args: any[]) => execution.createRunner(...args),
      createGroupMemberRunner: (...args: any[]) =>
        execution.createGroupMemberRunner(...args),
    } satisfies TurnExecutionPort);
    manager.setAutomationConfigChanged(() => {
      void context.host.events.emit("transcript.automation-config-changed", {});
    });
    manager.setListenerConnectObserver(
      ({ agentId, platform }: { agentId: string; platform: string }) => {
        void context.host.events.emit("transcript.listener-connect-card", {
          agentId,
          platform,
        });
      },
    );
    manager.setAgentRunLifecycleObserver(
      (event: { type: "started" | "ended"; requestId: string }) => {
        void context.host.events.emit(
          event.type === "started"
            ? "transcript.run-started"
            : "transcript.run-ended",
          { requestId: event.requestId },
        );
      },
    );
    context.onStop(() => manager.dispose());
    return manager;
  },
});

import { SLATE_AUTO_REVIEW_STALE, SLATE_AUTO_REVIEW_STALE_MESSAGE } from "../../../shared/transcript.ts";
import {
  resolveSlateAutoReviewModes,
  SlateAutoReviewController,
  type SlateAutoReviewEvent,
  type SlateAutoReviewResolution,
} from "../../runner/slate-auto-review.ts";
import { AUTO_REVIEW_AWAITING_TAB_ID, ReviewAwaitingBridge } from "./slate-auto-review-awaiting.ts";
import { AutoReviewApprovalRegistry } from "./auto-review-approval-registry.ts";
import { publishAutoReviewApprovalEvent } from "./auto-review-approval-updates.ts";
import {
  parseLocalAutoReviewMode,
  type AutoReviewServiceDeps,
  type AutoReviewUpdateSink,
} from "./auto-review-service-contracts.ts";

export { SETTLED_APPROVAL_MEMORY, parseLocalAutoReviewMode } from "./auto-review-service-contracts.ts";
export type { AutoReviewServiceDeps, AutoReviewUpdateSink } from "./auto-review-service-contracts.ts";

/** Coordinates approval lifetimes and the host-facing effects of each controller event. */
export class AutoReviewService<Classifier = unknown, Auth = unknown> {
  readonly #now: () => number;
  readonly #ports: AutoReviewServiceDeps<Classifier, Auth>;
  readonly #approvals = new AutoReviewApprovalRegistry();
  readonly #awaitingBridge: ReviewAwaitingBridge;

  constructor(deps: AutoReviewServiceDeps<Classifier, Auth>) {
    this.#ports = deps;
    this.#now = deps.now ?? Date.now;
    this.#awaitingBridge = new ReviewAwaitingBridge(deps.awaitingSink, this.#now);
  }

  /** Keep the injected host ports inspectable for extension wiring and diagnostics. */
  get deps(): AutoReviewServiceDeps<Classifier, Auth> {
    return this.#ports;
  }

  bindRunner(options: {
    readonly agentId: string;
    readonly approvalsResolvable?: boolean;
    readonly onUpdate: AutoReviewUpdateSink;
  }) {
    const getAutoReviewModes = () => this.#resolveModes();
    const autoReviewController = new SlateAutoReviewController({
      agentId: options.agentId,
      hostGeneration: this.#ports.hostGeneration,
      ...(options.approvalsResolvable === undefined ? {} : { approvalsResolvable: options.approvalsResolvable }),
      now: this.#now,
      onDisplayRecheckFailed: (report) => {
        this.#ports.telemetry.reportAutoReviewDisplayRecheckFailed({ conversationId: report.agentId });
      },
    });

    let unsubscribe = (): void => {};
    unsubscribe = autoReviewController.subscribe((event) => {
      this.#handleRunnerEvent(autoReviewController, unsubscribe, options.onUpdate, event);
    });

    return {
      autoReviewController,
      autoReviewModes: getAutoReviewModes(),
      getAutoReviewModes,
      autoReviewClassifierExecutor: this.#ports.createClassifierExecutor(this.#ports.auth),
      getAutoReviewInstructions: () => this.#ports.settings.getAutoReviewInstructions(),
    };
  }

  async resolveApproval(args: {
    readonly requestId: string;
    readonly resolution: SlateAutoReviewResolution;
    readonly agentId: string;
    readonly entryId: string;
  }): Promise<void> {
    const owner = this.#approvals.ownerOf(args.requestId);
    if (owner?.resolveApproval(args.requestId, args.resolution) != null) return;
    if (this.#approvals.wasRecentlySettled(args.requestId)) return;

    const settled = await this.#ports.transcript.settleStaleAutoReviewCard({
      agentId: args.agentId,
      entryId: args.entryId,
      requestId: args.requestId,
    });
    if (settled) return;
    throw new Error(`${SLATE_AUTO_REVIEW_STALE}: ${SLATE_AUTO_REVIEW_STALE_MESSAGE}`);
  }

  expirePendingApprovals(): void {
    this.#approvals.expirePending();
  }

  agentIdsWithPendingApprovals(): string[] {
    return this.#approvals.pendingAgentIds();
  }

  stop(): void {
    this.#approvals.stop();
  }

  pendingAwaitingState(agentId: string) {
    return this.#awaitingBridge.pendingAwaitingState(agentId);
  }

  async sweepStaleAwaitingBadges(
    listAgentIds: () => Promise<readonly string[]>,
    ifSinceBefore: number,
  ): Promise<void> {
    try {
      const agentIds = await listAgentIds();
      for (const agentId of agentIds) {
        this.#ports.awaitingSink.clearForTab(agentId, AUTO_REVIEW_AWAITING_TAB_ID, { ifSinceBefore });
      }
    } catch {
      // A stale badge must not prevent the host extension from starting.
    }
  }

  #resolveModes() {
    const instructions = this.#ports.settings.getAutoReviewInstructions();
    const enforceEnabled = this.#ports.experiments.checkFeatureGate("slate_auto_review");
    return resolveSlateAutoReviewModes({
      settingsEnabled: instructions.isEnabled,
      enforceEnabled,
      ...(this.#ports.localMode === undefined ? {} : { localOverride: this.#ports.localMode }),
    });
  }

  #handleRunnerEvent(
    controller: SlateAutoReviewController,
    unsubscribe: () => void,
    onUpdate: AutoReviewUpdateSink,
    event: SlateAutoReviewEvent,
  ): void {
    const beforePublish: Record<SlateAutoReviewEvent["type"], () => void> = {
      created: () => this.#approvals.track(controller, unsubscribe),
      resolved: () => this.#approvals.rememberSettled(event.approval.id),
      expired: () => {},
    };
    beforePublish[event.type]();

    this.#awaitingBridge.handleEvent(event);
    publishAutoReviewApprovalEvent({
      event,
      onUpdate,
      telemetry: this.deps.telemetry,
      now: this.#now,
    });

    const afterPublish: Record<SlateAutoReviewEvent["type"], () => void> = {
      created: () => {},
      resolved: () => this.#approvals.releaseIfIdle(controller),
      expired: () => this.#approvals.releaseIfIdle(controller),
    };
    afterPublish[event.type]();
  }
}

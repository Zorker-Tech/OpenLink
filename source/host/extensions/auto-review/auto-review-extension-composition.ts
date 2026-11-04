/** Composes the review service from the host ports and restores host-owned state on startup. */

import type { HostExtensionContext } from "../host-extensions.ts"
import { HostExtensions } from "../extension-ids.generated.ts"
import { SLATE_AUTO_REVIEW_HOST_GENERATION } from "../../runner/slate-auto-review.ts"
import type { AutoReviewServiceDeps } from "./auto-review-service-contracts.ts"
import { AutoReviewService, parseLocalAutoReviewMode } from "./auto-review-service.ts"
import { createSlateBackendSmartModeClassifierExecutor } from "../../../adapters/interop/agent/auto-review-backend-executor-adapter.ts"

type AutoReviewAuth = Parameters<typeof createSlateBackendSmartModeClassifierExecutor>[0]
type AutoReviewClassifier = ReturnType<typeof createSlateBackendSmartModeClassifierExecutor>
type AutoReviewTranscript = AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["transcript"]

type AutoReviewHostPorts = Pick<
  AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>,
  "auth" | "experiments" | "settings" | "telemetry"
> & {
  readonly transcript: AutoReviewTranscript & {
    createAwaitingStateSink(): AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["awaitingSink"]
    listAgentIds(): Promise<readonly string[]>
    expireAllPendingAutoReviewApprovalCards(): Promise<unknown>
  }
}

function getHostPorts(context: HostExtensionContext): AutoReviewHostPorts {
  return {
    auth: context.deps[HostExtensions.Auth] as AutoReviewAuth,
    experiments: context.deps[HostExtensions.Experiments] as AutoReviewHostPorts["experiments"],
    settings: context.deps[HostExtensions.Settings] as AutoReviewHostPorts["settings"],
    telemetry: (context.deps[HostExtensions.Telemetry] as { logs: AutoReviewHostPorts["telemetry"] }).logs,
    transcript: context.deps[HostExtensions.Transcript] as AutoReviewHostPorts["transcript"],
  }
}

function expirePreviousHostApprovals(
  service: AutoReviewService<AutoReviewClassifier, AutoReviewAuth>,
  transcript: AutoReviewHostPorts["transcript"],
): void {
  const hostStartedAt = Date.now()
  const removeOldBadges = (): unknown => service.sweepStaleAwaitingBadges(
    () => transcript.listAgentIds(),
    hostStartedAt,
  )
  void transcript.expireAllPendingAutoReviewApprovalCards().then(removeOldBadges, removeOldBadges)
}

export function startAutoReviewServiceFromHost(
  context: HostExtensionContext,
  localMode: ReturnType<typeof parseLocalAutoReviewMode>,
): AutoReviewService<AutoReviewClassifier, AutoReviewAuth> {
  const ports = getHostPorts(context)
  const service = new AutoReviewService({
    ...ports,
    awaitingSink: ports.transcript.createAwaitingStateSink(),
    hostGeneration: SLATE_AUTO_REVIEW_HOST_GENERATION,
    ...(localMode === undefined ? {} : { localMode }),
    createClassifierExecutor: createSlateBackendSmartModeClassifierExecutor,
  })

  context.onStop(() => service.stop())
  expirePreviousHostApprovals(service, ports.transcript)
  return service
}

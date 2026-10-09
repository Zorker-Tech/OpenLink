/**
 * The auto-review, declared as a host extension.
 *
 * Starting it builds the review service over the host's own auth, experiments, settings, telemetry and transcript —
 * with the transcript also lending it the sink a waiting review writes to, and the mode read from the environment. The
 * host gets the service itself, and stopping the host stops the review. Before the host is told it is up, whatever the
 * previous life left waiting is expired and the badges that no longer belong to anything are swept away.
 */

import { defineHostExtension } from "../host-extensions.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { SLATE_AUTO_REVIEW_HOST_GENERATION } from "../../runner/slate-auto-review.ts";
import { AutoReviewService, parseLocalAutoReviewMode, type AutoReviewServiceDeps } from "./auto-review-service.ts";
import { createSlateBackendSmartModeClassifierExecutor } from "./slate-backend-smart-mode-classifier-exec.ts";

type AutoReviewAuth = Parameters<typeof createSlateBackendSmartModeClassifierExecutor>[0];
type AutoReviewClassifier = ReturnType<typeof createSlateBackendSmartModeClassifierExecutor>;
type AutoReviewTranscript = AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["transcript"];

/** What the extension reads from the host: the service's own dependencies, plus what the transcript lends it. */
type AutoReviewDependencies = Omit<AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>, "hostGeneration" | "localMode" | "now" | "createClassifierExecutor"> & {
  readonly transcript: AutoReviewTranscript & {
    createAwaitingStateSink(): AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["awaitingSink"];
    listAgentIds(): Promise<readonly string[]>;
    expireAllPendingAutoReviewApprovalCards(): Promise<unknown>;
  };
};

/** The environment variable the local review mode comes from. */
export const SLATE_AUTO_REVIEW_MODE_ENV = "SLATE_AUTO_REVIEW_MODE";

export const autoReviewExtension = defineHostExtension<AutoReviewService<AutoReviewClassifier, AutoReviewAuth>>({
  id: HostExtensions.AutoReview,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Settings, HostExtensions.Telemetry, HostExtensions.Transcript],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AutoReviewAuth;
    const experiments = context.deps[HostExtensions.Experiments] as AutoReviewDependencies["experiments"];
    const settings = context.deps[HostExtensions.Settings] as AutoReviewDependencies["settings"];
    const telemetry = (context.deps[HostExtensions.Telemetry] as { logs: AutoReviewDependencies["telemetry"] }).logs;
    const transcript = context.deps[HostExtensions.Transcript] as AutoReviewDependencies["transcript"];
    const service = new AutoReviewService({
      auth,
      experiments,
      settings,
      telemetry,
      awaitingSink: transcript.createAwaitingStateSink(),
      transcript,
      hostGeneration: SLATE_AUTO_REVIEW_HOST_GENERATION,
      localMode: parseLocalAutoReviewMode(process.env[SLATE_AUTO_REVIEW_MODE_ENV])!,
      createClassifierExecutor: createSlateBackendSmartModeClassifierExecutor,
    });
    context.onStop(() => service.stop());
    // A card from the host's previous life is not one a user can still answer, so it is expired — and the badges
    // that pointed at it are swept whether the expiring worked or not.
    const startedAtMs = Date.now();
    const sweepBadges = (): unknown => service.sweepStaleAwaitingBadges(() => transcript.listAgentIds(), startedAtMs);
    void transcript.expireAllPendingAutoReviewApprovalCards().then(sweepBadges, sweepBadges);
    return service;
  },
});

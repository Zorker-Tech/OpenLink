/** Declares auto-review and lets host composition provide its runtime dependencies. */

import { defineHostExtension } from "../host-extensions.ts"
import { HostExtensions } from "../extension-ids.generated.ts"
import { parseLocalAutoReviewMode } from "./auto-review-service.ts"
import { startAutoReviewServiceFromHost } from "./auto-review-extension-composition.ts"

export const SLATE_AUTO_REVIEW_MODE_ENV = "SLATE_AUTO_REVIEW_MODE"

export const autoReviewExtension = defineHostExtension<ReturnType<typeof startAutoReviewServiceFromHost>>({
  id: HostExtensions.AutoReview,
  dependencies: [
    HostExtensions.Auth,
    HostExtensions.Experiments,
    HostExtensions.Settings,
    HostExtensions.Telemetry,
    HostExtensions.Transcript,
  ],
  start: context => startAutoReviewServiceFromHost(
    context,
    parseLocalAutoReviewMode(process.env[SLATE_AUTO_REVIEW_MODE_ENV]),
  ),
})

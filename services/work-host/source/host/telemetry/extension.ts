/**
 * Telemetry, as a host extension.
 *
 * It owns the one service that carries everything the host reports about itself, wired to the platform's own policies:
 * how often the structured log flushes and how long a submission may take, how long the identity hold may last, how
 * often the box's logs are shipped, how often the shared desktop's health is read, how often the marker a crashed host
 * left is looked for, how long a fatal flush may take, and when a lifecycle phase counts as stuck. What it hands back
 * is that service's own surface, and the experiments' diagnostics are pinned to its log so a gate that could not be
 * read is written down with everything else.
 */

import { getBoxStoreBackendPolicy } from "../boxes/box-store-backend-policy.ts";
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { createDeadlinePolicy, createExpiryPolicy, createIdleWatchdogPolicy, createPollingPolicy, realClock } from "../extensions/scheduling.ts";
import { resolveBoxIdentityTags } from "../ports/telemetry.ts";
import { pinExperimentsDiagnosticsReporter } from "../../shared/node/experiments/experiments-diagnostics.ts";
import { BOX_LOG_SHIP_INTERVAL_MS } from "./box-log-shipper.ts";
import { createHostCrashMarkerStore } from "./host-crash-marker.ts";
import { DESKTOP_HEALTH_FORWARD_INTERVAL_MS, HostTelemetryService } from "./host-telemetry-service.ts";
import { HOST_IDENTITY_HOLD_BACKSTOP_MS, TELEMETRY_FLUSH_TICK_MS } from "./structured-log-telemetry.ts";

export const FATAL_TELEMETRY_FLUSH_TIMEOUT_MS = 2_000,
  HOST_CRASH_MARKER_FORWARD_INTERVAL_MS = 5 * 60_000,
  HOST_LIFECYCLE_STUCK_MS = 5 * 60_000,
  STRUCTURED_LOG_SUBMIT_DEADLINE_MS = 15_000;

type ServiceOptions = ConstructorParameters<typeof HostTelemetryService>[0];

export const telemetryExtension = defineHostExtension({
  id: HostExtensions.Telemetry,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Inference],
  start: async (context) => {
    const auth = context.deps[HostExtensions.Auth] as ServiceOptions["auth"];
    const experiments = context.deps[HostExtensions.Experiments] as ServiceOptions["experiments"];
    const inference = context.deps[HostExtensions.Inference] as ServiceOptions["inference"];
    const service = new HostTelemetryService({
      auth,
      experiments,
      inference,
      // What the host is, as the box it runs in says: the identity the box was given, and where its store lives.
      identityTags: { ...resolveBoxIdentityTags(), store_backend: getBoxStoreBackendPolicy().kind },
      flushPolling: createPollingPolicy(realClock, { name: "slate-host-structured-log-flush", intervalMs: TELEMETRY_FLUSH_TICK_MS }),
      submitDeadline: createDeadlinePolicy(realClock, { name: "slate-host-structured-log-submit", timeoutMs: STRUCTURED_LOG_SUBMIT_DEADLINE_MS }),
      identityHoldExpiry: createExpiryPolicy(realClock, { name: "slate-host-telemetry-identity-hold", ttlMs: HOST_IDENTITY_HOLD_BACKSTOP_MS }),
      boxLogPolling: createPollingPolicy(realClock, { name: "slate-box-log-shipping", intervalMs: BOX_LOG_SHIP_INTERVAL_MS }),
      desktopHealthPolling: createPollingPolicy(realClock, { name: "slate-desktop-health-forwarding", intervalMs: DESKTOP_HEALTH_FORWARD_INTERVAL_MS }),
      hostCrashMarkerStore: createHostCrashMarkerStore(),
      hostCrashMarkerPolling: createPollingPolicy(realClock, { name: "slate-host-crash-marker-forward", intervalMs: HOST_CRASH_MARKER_FORWARD_INTERVAL_MS }),
      fatalFlushDeadline: createDeadlinePolicy(realClock, { name: "slate-host-fatal-telemetry-flush", timeoutMs: FATAL_TELEMETRY_FLUSH_TIMEOUT_MS }),
      clock: realClock,
      hostLifecycleWatchdog: createIdleWatchdogPolicy(realClock, { name: "slate-host-lifecycle", idleMs: HOST_LIFECYCLE_STUCK_MS }),
    });
    context.onStop(() => service.dispose());
    await service.start();
    const api = service.api();
    // A gate that could not be read is written down with everything else the host reports.
    pinExperimentsDiagnosticsReporter((diagnostic) => api.logs.reportExperimentsDiagnostic(diagnostic));
    return api;
  },
});

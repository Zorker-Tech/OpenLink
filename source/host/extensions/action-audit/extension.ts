/**
 * The record of what the platform did, declared as a host extension.
 *
 * Starting it builds the auditor over the host's own auth and the experiment gate that decides whether the audit is
 * forwarded to the backend at all; what the host gets back is the auditor alone, and stopping the extension lets the
 * auditor go — which flushes what it was holding rather than dropping it.
 */

import { defineHostExtension } from "../host-extensions.ts";
import { createRealPollingPolicy } from "../scheduling.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { createSlateAuditBatchSender } from "./action-audit-backend.ts";
import { ACTION_AUDIT_FLUSH_INTERVAL_MS, createSlateActionAuditor } from "./action-audit-service.ts";

/** The gate that decides whether the audit leaves the machine at all. */
export const SLATE_ACTION_AUDIT_LOGS_GATE = "slate_action_audit_logs";

interface ActionAuditAuth {
  getAccessToken(options: { readonly backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
}

export const actionAuditExtension = defineHostExtension({
  id: HostExtensions.ActionAudit,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Telemetry],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as ActionAuditAuth;
    const experiments = context.deps[HostExtensions.Experiments] as { checkGate(name: string): boolean | Promise<boolean> };
    const telemetry = context.deps[HostExtensions.Telemetry] as { logs: { reportHostExtensionDiagnostic(value: unknown): void } };
    const service = createSlateActionAuditor({
      isBackendForwardingEnabled: () => experiments.checkGate(SLATE_ACTION_AUDIT_LOGS_GATE),
      sendBatch: createSlateAuditBatchSender({ getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId }),
      report: (diagnostic) => telemetry.logs.reportHostExtensionDiagnostic(diagnostic),
      flushPolicy: createRealPollingPolicy({ name: "action-audit-flush", intervalMs: ACTION_AUDIT_FLUSH_INTERVAL_MS }),
    });
    context.onStop(() => service.dispose());
    return service.auditor;
  },
});

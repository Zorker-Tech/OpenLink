/**
 * The record of what the platform did, declared as a host extension.
 *
 * Starting it builds the auditor over the host's own auth and the experiment gate that decides whether the audit is
 * forwarded to the backend at all; what the host gets back is the auditor alone, and stopping the extension lets the
 * auditor go — which flushes what it was holding rather than dropping it.
 */

import { defineHostExtension, type HostExtensionContext } from "../host-extensions.ts";
import { createRealPollingPolicy } from "../scheduling.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { createSlateAuditBatchSender } from "./action-audit-backend.ts";
import { ACTION_AUDIT_FLUSH_INTERVAL_MS, createSlateActionAuditor } from "./action-audit-service.ts";

/** The gate that decides whether the audit leaves the machine at all. */
export const SLATE_ACTION_AUDIT_LOGS_GATE = "slate_action_audit_logs";

interface AuthSessionPort {
  getAccessToken(options: { readonly backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
}

interface ExperimentGatePort {
  checkGate(name: string): boolean | Promise<boolean>;
}

interface DiagnosticLogPort {
  readonly logs: { reportHostExtensionDiagnostic(value: unknown): void };
}

function createAuditRecorder(hostContext: HostExtensionContext<unknown>) {
  const identity = hostContext.deps[HostExtensions.Auth] as AuthSessionPort;
  const gate = hostContext.deps[HostExtensions.Experiments] as ExperimentGatePort;
  const diagnostics = hostContext.deps[HostExtensions.Telemetry] as DiagnosticLogPort;
  const deliverBatch = createSlateAuditBatchSender({
    getAccessToken: identity.getAccessToken,
    getMachineId: identity.getMachineId,
  });

  return createSlateActionAuditor({
    isBackendForwardingEnabled: () => gate.checkGate(SLATE_ACTION_AUDIT_LOGS_GATE),
    sendBatch: deliverBatch,
    report: (diagnostic) => diagnostics.logs.reportHostExtensionDiagnostic(diagnostic),
    flushPolicy: createRealPollingPolicy({
      name: "action-audit-flush",
      intervalMs: ACTION_AUDIT_FLUSH_INTERVAL_MS,
    }),
  });
}

export const actionAuditExtension = defineHostExtension({
  id: HostExtensions.ActionAudit,
  dependencies: [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Telemetry],
  start: (context) => {
    const service = createAuditRecorder(context);
    context.onStop(() => service.dispose());
    return service.auditor;
  },
});

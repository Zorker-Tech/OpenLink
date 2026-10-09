/**
 * The attachments, declared as a host extension.
 *
 * Starting it builds the attachments service on the host's own account and on the box a forever-box lends it; what the
 * service could not do — a read that found no owner — is reported through the host's telemetry.
 */

import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { createAttachmentsService, type AttachmentsServiceDependencies } from "./attachments-service.ts";

interface AttachmentsHostDeps {
  auth: AttachmentsServiceDependencies<unknown>["auth"];
  "forever-box": { box: AttachmentsServiceDependencies<unknown>["box"] };
  telemetry: { logs: { reportHostExtensionDiagnostic(value: Record<string, unknown>): void } };
}

export const attachmentsExtension = defineHostExtension({
  id: HostExtensions.Attachments,
  dependencies: [HostExtensions.Auth, HostExtensions.ForeverBox, HostExtensions.Telemetry],
  start: (context) => {
    const deps = context.deps as unknown as AttachmentsHostDeps;
    return createAttachmentsService({
      auth: deps.auth,
      box: deps["forever-box"].box,
      // Attachments live on the host's own machine; the box they may be staged onto comes from the host itself.
      ctx: {},
      report: (diagnostic) => deps.telemetry.logs.reportHostExtensionDiagnostic(diagnostic),
    });
  },
});

/** Register the attachment service with the host's account, box, and diagnostics ports. */

import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { defineHostExtension, type HostExtensionContext } from "../extensions/host-extensions.ts";
import { createAttachmentsService, type AttachmentsServiceDependencies } from "./attachments-service.ts";

interface AttachmentsHostDependencies {
  readonly auth: AttachmentsServiceDependencies<unknown>["auth"];
  readonly "forever-box": { readonly box: AttachmentsServiceDependencies<unknown>["box"] };
  readonly telemetry: {
    readonly logs: {
      reportHostExtensionDiagnostic(value: Record<string, unknown>): void;
    };
  };
}

function startAttachmentsService(context: HostExtensionContext): ReturnType<typeof createAttachmentsService> {
  const dependencies = context.deps as unknown as AttachmentsHostDependencies;
  return createAttachmentsService({
    auth: dependencies.auth,
    box: dependencies["forever-box"].box,
    ctx: {},
    report: (diagnostic) => dependencies.telemetry.logs.reportHostExtensionDiagnostic(diagnostic),
  });
}

export const attachmentsExtension = defineHostExtension({
  id: HostExtensions.Attachments,
  dependencies: [HostExtensions.Auth, HostExtensions.ForeverBox, HostExtensions.Telemetry],
  start: startAttachmentsService,
});

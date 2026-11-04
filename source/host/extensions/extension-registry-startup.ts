import { startHostExtensions, type HostExtensionDeclaration } from "./host-extensions.ts";
import { type HostExtensionId } from "./extension-ids.generated.ts";
import { orderRegisteredHostExtensions } from "./extension-registry-assembly.ts";

export async function startWorkHostExtensions<Host extends { log(message: string): void }>(options: {
  readonly host: Host;
  readonly extensionsById: Readonly<Partial<Record<HostExtensionId, HostExtensionDeclaration<unknown, Host>>>>;
}) {
  const registry = await startHostExtensions({
    extensions: orderRegisteredHostExtensions(options.extensionsById),
    host: options.host,
    onStopFailure: (extensionId, error) => {
      options.host.log(`host extension "${extensionId}" failed to stop: ${String(error)}`);
    },
  });
  return {
    order: registry.order,
    api: (extensionId: HostExtensionId) => registry.apis[extensionId],
    stop: () => registry.stop(),
  };
}

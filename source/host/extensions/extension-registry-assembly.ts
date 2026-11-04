import type { HostExtensionDeclaration } from "./host-extensions.ts";
import { HostExtensions, type HostExtensionId } from "./extension-ids.generated.ts";
import { WORK_HOST_EXTENSION_REGISTRATION_ORDER } from "./extension-startup-order.ts";

export function orderRegisteredHostExtensions<Host>(
  byId: Readonly<Partial<Record<HostExtensionId, HostExtensionDeclaration<unknown, Host>>>>,
): HostExtensionDeclaration<unknown, Host>[] {
  return WORK_HOST_EXTENSION_REGISTRATION_ORDER.map((id) => {
    const extension = byId[id];
    if (extension === undefined) {
      throw new Error(`host extension registry is missing "${id}"`);
    }
    if (extension.id !== id) {
      throw new Error(`host extension registry slot "${id}" received "${extension.id}"`);
    }
    return extension;
  });
}

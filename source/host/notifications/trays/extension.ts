/** Expose tray notifications through the host extension graph. */

import { HostExtensions } from "../../extensions/extension-ids.generated.ts";
import { defineHostExtension } from "../../extensions/host-extensions.ts";
import { TrayManager, type ErrorTray, type TrayEvent } from "./trays-service.ts";

export interface TrayExtensionApi {
  list(): readonly ErrorTray[];
  dismiss(input: { readonly id: string }): boolean;
  clearAll(): void;
  subscribe(listener: (event: TrayEvent) => void): () => void;
  pushError(options: Parameters<TrayManager["pushError"]>[0]): ErrorTray;
  clearForAgent(agentId: string): void;
}

function exposeTrayOperations(manager: TrayManager): TrayExtensionApi {
  return {
    list: () => manager.getTrays(),
    dismiss: ({ id }) => manager.dismiss(id),
    clearAll: () => manager.clearAll(),
    subscribe: (listener) => manager.subscribe(listener),
    pushError: (options) => manager.pushError(options),
    clearForAgent: (agentId) => manager.clearForAgent(agentId),
  };
}

export const traysExtension = defineHostExtension({
  id: HostExtensions.Trays,
  dependencies: [],
  start: () => exposeTrayOperations(new TrayManager()),
});

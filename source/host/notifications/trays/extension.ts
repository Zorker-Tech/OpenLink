/** The trays as a host extension: what the platform shows a user, published to the renderer. */
import { defineHostExtension } from "../../extensions/host-extensions.ts";
import { HostExtensions } from "../../extensions/extension-ids.generated.ts";
import { TrayManager } from "./trays-service.ts";

export const traysExtension = defineHostExtension({
  id: HostExtensions.Trays, dependencies: [], start: () => {
    const trays = new TrayManager();
    return {
      list: () => trays.getTrays(), dismiss: ({ id }: { id: string }) => trays.dismiss(id), clearAll: () => trays.clearAll(),
      subscribe: (listener: Parameters<typeof trays.subscribe>[0]) => trays.subscribe(listener),
      pushError: (options: Parameters<typeof trays.pushError>[0]) => trays.pushError(options), clearForAgent: (agentId: string) => trays.clearForAgent(agentId)
    };
  }
});


import { GatewayLocalExecBox, type GatewayLocalExecBoxOptions } from "./gateway-local-exec-box.ts";
import { SlateLocalExecBridge } from "./local-exec-bridge.ts";
import { GatewayLocalExecManager } from "./gateway-local-exec-manager.ts";

export function createBridgeUserComputers<Client = unknown, Accessor = GatewayLocalExecManager<Client>>(
  localExecBridge: SlateLocalExecBridge,
  options: Omit<GatewayLocalExecBoxOptions<Client, Accessor>, "computerId">,
) {
  return {
    list: () => localExecBridge.listComputers(),
    resolve: (id?: string) => {
      const selected = id === undefined
        ? localExecBridge.activeComputer()
        : localExecBridge.listComputers().find((computer) => computer.id === id);
      if (selected === undefined) return undefined;
      return {
        id: selected.id,
        label: selected.label,
        box: new GatewayLocalExecBox(localExecBridge, { ...options, ...(id === undefined ? {} : { computerId: selected.id }) }),
      };
    },
  };
}

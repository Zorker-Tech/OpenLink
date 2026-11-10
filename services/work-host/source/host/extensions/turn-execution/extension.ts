/** Turn execution as a host extension: the executor is bound once, from here. */
import { defineHostExtension } from "../host-extensions.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { TurnExecutionRegistry } from "./turn-execution-service.ts";

export const turnExecutionExtension = defineHostExtension({ id: HostExtensions.TurnExecution, dependencies: [], start: () => new TurnExecutionRegistry() });


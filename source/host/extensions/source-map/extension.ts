/** The source map as a host extension: it is started with the rest, and stopped with them. */
import { defineHostExtension } from "../host-extensions.ts";
import { HostExtensions } from "../extension-ids.generated.ts";
import { SlateSourceMap } from "./source-map-service.ts";

export const sourceMapExtension = defineHostExtension({ id: HostExtensions.SourceMap, dependencies: [], start: () => new SlateSourceMap() });


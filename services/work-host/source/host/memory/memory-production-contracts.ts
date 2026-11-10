/** Host capabilities required to build production memory helpers. */

import type { HostExtensionContext } from "../extensions/host-extensions.ts"
import type { MemoryExtensionContext } from "./memory-extension-contracts.ts"

export type MemoryProductionContext = HostExtensionContext<unknown> & {
  readonly deps: MemoryExtensionContext["deps"]
}

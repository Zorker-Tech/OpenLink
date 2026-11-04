/** The session extension's public declaration and host dependency list. */

import { startSessionExtension } from "./session-extension-composition.ts"
import type { SessionExtensionApi, SessionExtensionContext } from "./session-extension-contracts.ts"

export type { SessionExtensionApi, SessionExtensionContext } from "./session-extension-contracts.ts"

export const sessionExtension = {
  id: "session",
  dependencies: ["experiments", "forever-box", "settings", "telemetry"] as const,
  start(context: SessionExtensionContext): SessionExtensionApi {
    return startSessionExtension(context)
  },
}

/**
 * The identifier an automation is known by, derived from what it belongs to.
 *
 * An automation is named by its agent and by a local id inside that agent, and the identifier the platform
 * uses has to be stable across restarts and across machines — two hosts that see the same pair must agree
 * on the name. So it is a digest of the pair rather than a random id, shaped like a UUID with the version
 * and variant bits set, because that is the shape everything downstream expects.
 */

import { createHash } from "node:crypto"

export function stableAutomationId(args: { agentId: string; localId: string }): string {
  const hex = createHash("sha256").update(Buffer.from(`${args.agentId}\0${args.localId}`)).digest("hex")
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

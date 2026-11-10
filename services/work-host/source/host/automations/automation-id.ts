/**
 * The identifier an automation is known by, derived from what it belongs to.
 *
 * An automation is named by its agent and by a local id inside that agent, and the identifier the platform
 * uses has to be stable across restarts and across machines — two hosts that see the same pair must agree
 * on the name. So it is a digest of the pair rather than a random id, shaped like a UUID with the version
 * and variant bits set, because that is the shape everything downstream expects.
 */

import { createHash } from "node:crypto"

const AUTOMATION_ID_VERSION = "5"
const UUID_VARIANT_MASK = 0x03
const UUID_VARIANT_PREFIX = 0x08

interface AutomationIdentity {
  readonly agentId: string
  readonly localId: string
}

function digestIdentity({ agentId, localId }: AutomationIdentity): string {
  return createHash("sha256").update(agentId).update("\0").update(localId).digest("hex")
}

function variantPrefix(digest: string): string {
  const sourceNibble = Number.parseInt(digest[16] ?? "0", 16)
  return ((sourceNibble & UUID_VARIANT_MASK) | UUID_VARIANT_PREFIX).toString(16)
}

function uuidSections(digest: string): string[] {
  const versionSection = `${AUTOMATION_ID_VERSION}${digest.slice(13, 16)}`
  const variantSection = `${variantPrefix(digest)}${digest.slice(17, 20)}`
  return [digest.slice(0, 8), digest.slice(8, 12), versionSection, variantSection, digest.slice(20, 32)]
}

export function stableAutomationId(identity: AutomationIdentity): string {
  return uuidSections(digestIdentity(identity)).join("-")
}

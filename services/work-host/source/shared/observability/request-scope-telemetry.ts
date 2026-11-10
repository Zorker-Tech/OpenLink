import { createKey, type Context } from "../../packages/context/context.ts"
import { INHERITABLE_SPAN_ATTRIBUTES_KEY } from "../../packages/context/telemetry.ts"

export const clientVersionKey = createKey<string | undefined>(Symbol("clientVersion"), undefined)
export const clientTypeKey = createKey<string | undefined>(Symbol("clientType"), undefined)
export const clientRemoteTypeKey = createKey<string | undefined>(Symbol("clientRemoteType"), undefined)
export const clientOsKey = createKey<string | undefined>(Symbol("clientOs"), undefined)
export const membershipTypeKey = createKey<string | undefined>(Symbol("membershipType"), undefined)
export const isAutoKey = createKey<boolean | undefined>(Symbol("isAuto"), undefined)
export const isPremiumKey = createKey<boolean | undefined>(Symbol("isPremium"), undefined)
export const teamIdKey = createKey<number | undefined>(Symbol("teamId"), undefined)
export const isUserApiKeyKey = createKey<boolean | undefined>(Symbol("isUserApiKey"), undefined)
export const maxModeKey = createKey<boolean | undefined>(Symbol("maxMode"), undefined)
export const autoRoutingReasonKey = createKey<string | undefined>(Symbol("autoRoutingReason"), undefined)

const SEMANTIC_VERSION =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SDK_PREFIXES = ["sdk-python-", "sdk-", "agentkit-"] as const
const SUPPORTED_OS_TAGS = new Set(["darwin", "win32", "linux", "ios", "android"])
const INTERNAL_TEAM_ID = 1

function clientVersion(ctx: Context): string {
  const raw = ctx.get(clientVersionKey)?.trim()
  if (raw === undefined || raw.length === 0) return "unknown"
  const lower = raw.toLowerCase()
  const prefix = SDK_PREFIXES.find(candidate => lower.startsWith(candidate))
  const candidate = prefix === undefined ? raw : raw.slice(prefix.length)
  return SEMANTIC_VERSION.test(candidate) ? candidate.replace(/^v/, "") : "unknown"
}

function clientOs(ctx: Context): string {
  const raw = ctx.get(clientOsKey)?.trim()
  if (raw === undefined || raw.length === 0) return "unknown"
  const normalized = raw.toLowerCase()
  if (normalized === "windows") return "win32"
  return SUPPORTED_OS_TAGS.has(normalized) ? normalized : "other"
}

export function getClientVersionMetricTagsFromContext(ctx: Context): {
  clientversion: string
  clienttype: string
} {
  return {
    clientversion: clientVersion(ctx),
    clienttype: ctx.get(clientTypeKey) ?? "unknown",
  }
}

export function getSdkFlavorMetricTagFromContext(ctx: Context): { sdkflavor: string } {
  const raw = ctx.get(clientVersionKey)?.trim().toLowerCase()
  if (raw === undefined) return { sdkflavor: "none" }
  if (raw.startsWith(SDK_PREFIXES[0])) return { sdkflavor: "python" }
  if (raw.startsWith(SDK_PREFIXES[1])) return { sdkflavor: "ts" }
  if (raw.startsWith(SDK_PREFIXES[2])) return { sdkflavor: "agentkit" }
  return { sdkflavor: "none" }
}

export function getClientRemoteTypeMetricTagFromContext(ctx: Context): { remoteType: string } {
  return { remoteType: ctx.get(clientRemoteTypeKey) ?? "unknown" }
}

export function getClientOsMetricTagFromContext(ctx: Context): { os: string } {
  return { os: clientOs(ctx) }
}

export function getMembershipTypeMetricTagsFromContext(ctx: Context): { membershiptype: string } {
  return { membershiptype: ctx.get(membershipTypeKey) ?? "unknown" }
}

export function getIsAutoFromContext(ctx: Context): boolean {
  return ctx.get(isAutoKey) === true
}

export function getIsPremiumFromContext(ctx: Context): boolean {
  return ctx.get(isPremiumKey) === true
}

export function getIsInternalTeamFromContext(ctx: Context): boolean {
  return ctx.get(teamIdKey) === INTERNAL_TEAM_ID
}

export function getIsUserApiKeyFromContext(ctx: Context): boolean {
  return ctx.get(isUserApiKeyKey) === true
}

export function getIsDevFromContext(ctx: Context): boolean {
  return ctx.get(INHERITABLE_SPAN_ATTRIBUTES_KEY)["user.is_dev"] === true
}

export function getMaxModeFromContext(ctx: Context): boolean {
  return ctx.get(maxModeKey) === true
}

export function getAutoRoutingReasonFromContext(ctx: Context): string {
  return ctx.get(autoRoutingReasonKey) ?? "unknown"
}

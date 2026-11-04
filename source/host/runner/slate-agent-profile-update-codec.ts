import { Buffer } from "node:buffer"

import { SLATE_HIDDEN_PROMPT_MARKER } from "./slate-prompt-markers.ts"
import type { AgentProfileIdentity } from "./slate-agent-profile-prompt-contracts.ts"

export const SLATE_AGENT_PROFILE_UPDATE_MARKER = "<<SLATE_AGENT_PROFILE_UPDATE:v1:"

export function normalizeAgentProfileIdentity(profile: AgentProfileIdentity): AgentProfileIdentity {
  return { name: profile.name.trim(), description: profile.description.trim() }
}

export function agentProfileIdentitiesEqual(left: AgentProfileIdentity, right: AgentProfileIdentity): boolean {
  return left.name === right.name && left.description === right.description
}

export function renderAgentProfileUpdate(identity: AgentProfileIdentity): string {
  const encoded = Buffer.from(JSON.stringify(identity)).toString("base64url")
  return [
    `${SLATE_HIDDEN_PROMPT_MARKER}${SLATE_AGENT_PROFILE_UPDATE_MARKER}${encoded}>>`,
    "<agent_profile_update>",
    "Use this profile as the current identity for the rest of the conversation. It replaces the profile summary at the start and any earlier profile update.",
    `Agent name: ${identity.name || "(no name)"}`,
    `Purpose: ${identity.description || "(no description)"}`,
    "Keep this identity in use until a future conversation summary adds it to the main profile.",
    "</agent_profile_update>",
  ].join("\n")
}

function decodeIdentity(segment: string): AgentProfileIdentity | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString())
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const fields = value as Record<string, unknown>
    if (typeof fields.name !== "string" || typeof fields.description !== "string") return undefined
    return normalizeAgentProfileIdentity({ name: fields.name, description: fields.description })
  } catch {
    return undefined
  }
}

export function parseLatestAgentProfileUpdate(text: string): AgentProfileIdentity | null {
  let latest: AgentProfileIdentity | undefined
  let cursor = 0
  while (true) {
    const markerAt = text.indexOf(SLATE_AGENT_PROFILE_UPDATE_MARKER, cursor)
    if (markerAt < 0) return latest ?? null

    const payloadStart = markerAt + SLATE_AGENT_PROFILE_UPDATE_MARKER.length
    const payloadEnd = text.indexOf(">>", payloadStart)
    if (payloadEnd < 0) return latest ?? null

    latest = decodeIdentity(text.slice(payloadStart, payloadEnd)) ?? latest
    cursor = payloadEnd + 2
  }
}

/**
 * Recognizing a named agent's own conversations, and what it is told in each.
 *
 * A named agent is a durable identity — it has a home store, a self document and a set of subscriptions —
 * and it speaks in more than one conversation: the one where the user configures it, and the ones where
 * it works. The two are told different things. The configuration conversation is told that its messages
 * are configuration rather than work and that a subscription change has to go through the subscription
 * tools; a working session is told to delegate the actual work and to keep quiet unless something
 * material happened.
 *
 * Telling them apart is what this file does, and it is deliberately narrow: a session counts as the home
 * conversation only when it came from that surface, names the home kind, is not a parent, and is not
 * itself a subagent.
 */

import { NAMED_AGENT_STORE_SELF_PATH, SUBSCRIPTIONS_MCP_SERVER_NAME } from "../../constants.ts"
import type { BackgroundAgentSource } from "../../utils/agent-config-contracts.ts"

type NamedAgentSessionProps = {
  readonly backgroundAgentSource?: BackgroundAgentSource | undefined
  readonly namedAgentSessionKind?: string | undefined
  readonly isCloudMetaAgentParent?: boolean | undefined
  readonly subagentType?: unknown
}

export type NamedAgentSessionPromptContext = {
  readonly namedAgentId: string
  readonly sessionKey: string
  readonly sessionKind: string
}

const HOME_KIND = "home"

export function isNamedAgentHomePromptSession(props: NamedAgentSessionProps): boolean {
  const identifiesNamedAgent = props.backgroundAgentSource === "named-agent"
  const identifiesHome = props.namedAgentSessionKind?.trim() === HOME_KIND
  const isStandalone = props.isCloudMetaAgentParent !== true && props.subagentType === undefined
  return identifiesNamedAgent && identifiesHome && isStandalone
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** A working session is named only when all three identifiers are present. */
export function getNamedAgentSessionPromptContext(
  props: Pick<NamedAgentSessionProps, "namedAgentSessionKind"> & {
    readonly namedAgentId?: string | undefined
    readonly namedAgentSessionKey?: string | undefined
  },
): NamedAgentSessionPromptContext | undefined {
  const namedAgentId = nonBlank(props.namedAgentId)
  const sessionKey = nonBlank(props.namedAgentSessionKey)
  const sessionKind = nonBlank(props.namedAgentSessionKind)
  if (namedAgentId === undefined || sessionKey === undefined || sessionKind === undefined) return undefined
  return { namedAgentId, sessionKey, sessionKind }
}

export function renderNamedAgentHomeUserTurnReminder(): string {
  const instructions = [
    "This is the Named Agent's configuration conversation. Treat each user message as durable configuration, not task-specific work, and answer in plain language as the agent.",
    `Use file tools to update ${NAMED_AGENT_STORE_SELF_PATH}.`,
    `For a direct subscription change, use the ${SUBSCRIPTIONS_MCP_SERVER_NAME} subscription tools immediately and report the confirmed result.`,
    "Use other connected services only to look up supporting details such as a channel identifier; do not send or post through them.",
    "A question or hypothetical example does not change any subscription.",
    "Do not begin or delegate repository or implementation work from this conversation.",
  ]
  return `<system_reminder>\n${instructions.join("\n")}\n</system_reminder>`
}

export function renderCloudMetaParentUserTurnReminder(
  taskToolName: string,
  session: NamedAgentSessionPromptContext | undefined,
): string {
  const sessionScope = session === undefined
    ? undefined
    : `This turn belongs to Named Agent ${session.namedAgentId}. Keep attention on the ${session.sessionKind} session ${session.sessionKey}.`
  const instructions = [
    `You are the parent for this Named Agent. Delegate substantive work with the ${taskToolName} tool instead of doing that work yourself.`,
    "Use connected service tools directly only for quick external actions, such as sending one message or managing subscriptions.",
    `Events from ${SUBSCRIPTIONS_MCP_SERVER_NAME} subscriptions return to this session. Timers use the wake_self strategy; new_session and per_thread delivery are unavailable here.`,
    "On notification or subscription turns, share only meaningful changes, decisions, action items, or other user-relevant facts. Do not reply just to say that nothing changed or that an item did not apply.",
    "Keep replies concise and natural. Do not narrate internal process or tool choices.",
    ...(sessionScope === undefined ? [] : [sessionScope]),
  ]
  return `<system_reminder>\n${instructions.join("\n")}\n</system_reminder>`
}

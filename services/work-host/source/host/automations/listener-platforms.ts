import { triggerListeners, type AutomationTrigger } from "../../shared/automations.ts"
import { listenerPlatformFor, type ListenerPlatformName } from "../../shared/listener-integrations.ts"

export type ListenerPlatform = ListenerPlatformName

export interface ListenerScopeIssue {
  readonly kind: "bot-not-in-channel" | "not-found"
  readonly scope: string
}

export function isListenerPlatform(value: string): value is ListenerPlatform {
  return listenerPlatformFor(value) !== undefined
}

export function listenerPlatformsInTrigger(trigger: AutomationTrigger): ListenerPlatform[] {
  const platforms = new Set<ListenerPlatform>()
  for (const listener of triggerListeners(trigger)) {
    if (isListenerPlatform(listener.type)) platforms.add(listener.type)
  }
  return [...platforms]
}

export function countListenerPlatforms(
  automations: readonly { readonly isEnabled: boolean; readonly trigger: AutomationTrigger }[],
): Record<ListenerPlatform, number> {
  const counts: Record<ListenerPlatform, number> = { github: 0, slack: 0 }
  for (const automation of automations) {
    if (!automation.isEnabled) continue
    for (const platform of listenerPlatformsInTrigger(automation.trigger)) {
      counts[platform] += 1
    }
  }
  return counts
}

export function describeScopeIssues(issues: readonly ListenerScopeIssue[]): string {
  const missingBot = issues
    .filter(issue => issue.kind === "bot-not-in-channel")
    .map(issue => issue.scope)
  const notFound = issues
    .filter(issue => issue.kind === "not-found")
    .map(issue => issue.scope)
  const parts: string[] = []
  if (missingBot.length > 0) {
    parts.push(
      `Invite @Slate to ${missingBot.join(", ")} in Slack — messages there can't reach this listener until the bot joins.`,
    )
  }
  if (notFound.length > 0) {
    parts.push(
      `Couldn't find ${notFound.join(", ")} — check the name, or invite @Slate to it first if it's a private channel.`,
    )
  }
  return parts.join(" ")
}

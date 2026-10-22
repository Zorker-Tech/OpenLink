/**
 * Which channel a gateway event belongs on.
 *
 * A gateway pushes events of many kinds, and a client subscribes to the families it cares about; the mapping says which
 * channel each family is delivered on, and how a family's name is read from an event.
 */

/** Every family a gateway pushes, and the channel it is delivered on. */
export const CHANNEL_OF_FAMILY = {
  transcript: "transcript",
  "client-side-tool-v2": "client-side-tool-v2",
  agents: "agents",
  "agent-upserted": "agent-upserted",
  tray: "tray",
  "agents-workflow": "workflows",
  subagents: "subagents",
  "async-tasks": "async-tasks",
  "agents-automation": "automations",
  "mcp-servers-updated": "mcp-servers",
  "forever-box": "forever-box",
  "teach-recording": "teach-recording",
  "box-disk-pressure": "box-disk-pressure",
  "computer-action": "computer-action",
  outline: "outline",
  sharing: "sharing",
  "host-settings": "host-settings",
} as const;

export type EventFamily = keyof typeof CHANNEL_OF_FAMILY;
export type SseChannel = (typeof CHANNEL_OF_FAMILY)[EventFamily];

/** The same mapping, read from the channel back to the family: a client arrives with a channel, not a family. */
const FAMILY_BY_CHANNEL: ReadonlyMap<string, EventFamily> = new Map(
  Object.entries(CHANNEL_OF_FAMILY).map(([family, channel]) => [channel, family as EventFamily]),
);

/** The family a channel carries, or nothing when this build delivers no event on that channel. */
export function familyOnChannel(channel: string): EventFamily | null {
  return FAMILY_BY_CHANNEL.get(channel) ?? null;
}

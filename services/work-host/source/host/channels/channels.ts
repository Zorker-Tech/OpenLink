/**
 * The messaging platforms an agent can be reached on.
 *
 * A channel is an outside surface — a chat platform the user connected — and each one is described the same way: what
 * it is called, how an address on it is written, and what it carries. What a surface offers is read from those
 * descriptions, so adding a platform is adding a description rather than a branch.
 */

export const DISCORD_PLATFORM = "discord";
export const SLACK_PLATFORM = "slack";

export interface ConnectorManifest {
  readonly platform: string;
  readonly displayName: string;
  readonly blurb: string;
  readonly credentialLabel: string;
  readonly availability: "available" | "coming-soon";
  readonly connectGuide: string;
}

/** A platform that is described but cannot be connected yet: no guide to follow, and it says so in its own words. */
function comingSoon(platform: string, displayName: string, blurb: string, credentialLabel: string): ConnectorManifest {
  return { platform, displayName, blurb, credentialLabel, availability: "coming-soon", connectGuide: "" };
}

export const CONNECTOR_MANIFESTS: readonly ConnectorManifest[] = [
  comingSoon(DISCORD_PLATFORM, "Discord", "Message in Discord servers and DMs (coming soon).", "bot token"),
  comingSoon(SLACK_PLATFORM, "Slack", "Message in Slack channels and DMs (coming soon).", "app token"),
];

/** The descriptions, by the platform they describe: the list is what a surface shows, this is what a caller looks up. */
const MANIFEST_BY_PLATFORM: ReadonlyMap<string, ConnectorManifest> = new Map(CONNECTOR_MANIFESTS.map((manifest) => [manifest.platform, manifest]));

export interface ChannelAddress {
  readonly platform: string;
  readonly chat: string;
}

export function findConnectorManifest(platform: string): ConnectorManifest | undefined {
  return MANIFEST_BY_PLATFORM.get(platform);
}

/** Whether a surface has anything to put in front of the user: a platform they can connect, or one already connected. */
export function hasChannelsToShow(manifests: readonly ConnectorManifest[], connections: readonly unknown[]): boolean {
  if (connections.length > 0) return true;
  return manifests.some((manifest) => manifest.availability === "available");
}

/** How an address on a platform is written, both sides of the colon. */
export function formatChannelAddress(address: ChannelAddress): string {
  return `${address.platform}:${address.chat}`;
}

/**
 * An address read back from its written form.
 *
 * Everything before the first colon is the platform and everything after it is the chat — a chat may hold colons of its
 * own, and both sides are trimmed, since an address is written by hand as often as it is built. An address with nothing
 * on one side of the colon names no channel.
 */
export function parseChannelAddress(raw: string): ChannelAddress | null {
  const written = raw.trim();
  const colon = written.indexOf(":");
  if (colon <= 0) return null;
  const platform = written.slice(0, colon).trim();
  const chat = written.slice(colon + 1).trim();
  if (platform.length === 0 || chat.length === 0) return null;
  return { platform, chat };
}

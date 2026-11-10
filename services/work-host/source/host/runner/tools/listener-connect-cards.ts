/**
 * The cards that tell a user a listener needs connecting before it can hear anything.
 *
 * What is emitted depends on what a trigger listens to: a platform that is not connected gets a card asking for it, and
 * one that is connected is not mentioned at all.
 */
export interface ConnectCardNeeds {
  readonly trigger: unknown;
  readonly platformsOf: (trigger: unknown) => readonly string[];
  readonly platformIsConnected?: (platform: string) => Promise<boolean>;
  readonly emit: (message: {
    readonly type: "listener-connect";
    readonly platform: string;
    readonly reason: string;
  }) => void;
  readonly spokenName?: (platform: string) => string;
}

/** What the card is asked for, in the words the trigger uses. */
const CARD_REASON = "so this routine can fire";

/** What the agent is told once the cards are in the chat: say it in its own words, and wait to be resumed. */
const RESUME_NOTE =
  " \u2014 say so in your own words, but don't paste a link or send them to settings, and don't ask them to report back: you're resumed automatically once it connects.";

/**
 * Whether this platform is connected, asked of whatever answers that question.
 *
 * A question that cannot be answered is answered as "connected": a card asking a user to connect something they already
 * have is worse than no card at all.
 */
async function isConnected(dependencies: ConnectCardNeeds, platform: string): Promise<boolean> {
  if (dependencies.platformIsConnected == null) return true;
  try {
    return await dependencies.platformIsConnected(platform);
  } catch {
    return true;
  }
}

/** The platforms a trigger listens to that are not connected yet, in the order the trigger holds them. */
async function disconnectedPlatforms(dependencies: ConnectCardNeeds): Promise<string[]> {
  const disconnected: string[] = [];
  for (const platform of dependencies.platformsOf(dependencies.trigger)) {
    if (!(await isConnected(dependencies, platform))) disconnected.push(platform);
  }
  return disconnected;
}

/** The names of the platforms, as the user knows them, said as a list. */
function spokenNames(dependencies: ConnectCardNeeds, platforms: readonly string[]): string {
  return platforms.map((platform) => dependencies.spokenName?.(platform) ?? platform).join(" and ");
}

/**
 * Puts a connect card in the chat for every platform the trigger needs that is not connected, and answers what the agent
 * should say about it — or nothing when there is nothing to say.
 */
export async function connectCardsFor(dependencies: ConnectCardNeeds): Promise<string | null> {
  if (dependencies.platformIsConnected == null) return null;
  if (dependencies.platformsOf(dependencies.trigger).length === 0) return null;
  const disconnected = await disconnectedPlatforms(dependencies);
  if (disconnected.length === 0) return null;
  for (const platform of disconnected) dependencies.emit({ type: "listener-connect", platform, reason: CARD_REASON });
  const names = spokenNames(dependencies, disconnected);
  const verb = disconnected.length === 1 ? "isn't" : "aren't";
  return `${names} ${verb} connected to the user's Slate account yet, so this routine won't fire until they connect. The connect card is already in the chat${RESUME_NOTE}`;
}

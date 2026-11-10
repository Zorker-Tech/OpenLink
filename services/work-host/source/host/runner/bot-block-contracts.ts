export const MAX_BLOCKED_HOST_LENGTH = 100;
export const MAX_BLOCKED_URL_LENGTH = 1_024;

export interface BotBlockCondition {
  equals?: readonly string[];
  suffix?: readonly string[];
  prefix?: readonly string[];
  includes?: readonly string[];
  startsWith?: readonly string[];
}

export interface BotBlockSignature {
  family: string;
  confidence: "high" | "low";
  host?: BotBlockCondition;
  path?: BotBlockCondition;
  title?: BotBlockCondition;
}

export interface BotBlockHit {
  family: string;
  confidence: "high" | "low";
  blockedHost: string;
  blockedUrl: string;
}

export interface BotBlockPage {
  hostname: string;
  pathname: string;
  title: string;
}

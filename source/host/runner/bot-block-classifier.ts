import { BOT_BLOCK_SIGNATURES } from "./bot-block-signatures.ts";
import type { BotBlockHit } from "./bot-block-contracts.ts";
import { matchesBotBlockSignature } from "./bot-block-matchers.ts";
import { botBlockPageIdentity, botBlockTelemetryLocation, parseBotBlockPageUrl } from "./bot-block-url.ts";

export function classifyBotBlockPage(page: { url: string; title: string }): BotBlockHit | undefined {
  const url = parseBotBlockPageUrl(page.url);
  if (url === undefined) return undefined;

  const identity = botBlockPageIdentity(url, page.title);
  for (const signature of BOT_BLOCK_SIGNATURES) {
    if (!matchesBotBlockSignature(signature, identity)) continue;
    return {
      family: signature.family,
      confidence: signature.confidence,
      ...botBlockTelemetryLocation(url),
    };
  }
  return undefined;
}

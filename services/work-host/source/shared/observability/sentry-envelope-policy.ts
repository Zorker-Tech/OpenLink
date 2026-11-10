import { projectSlateSentryEnvelope } from "./sentry-scrub.gen.ts";
import type { SlateSentryPrivacyTier } from "./sentry-privacy-mode.ts";
import { isEnvelopeRecord } from "./sentry-envelope-values.ts";
import type { SlateSentryEnvelope } from "./sentry-contracts.ts";

type AccountMatch = "match" | "mismatch" | "missing";

function accountIdentifier(header: Record<string, unknown>, payload: Record<string, unknown>): unknown {
  if (header.type === "event" && isEnvelopeRecord(payload.user)) return payload.user.id;
  if (header.type === "session") return payload.did;
  return undefined;
}

/** Whether the envelope contains a crash report from an unclassified process. */
export function isUnknownProcessEnvelope(envelope: SlateSentryEnvelope): boolean {
  return envelope[1].some(([header, payload]) =>
    header.type === "event"
      && isEnvelopeRecord(payload)
      && isEnvelopeRecord(payload.tags)
      && payload.tags["event.process"] === "unknown",
  );
}

/** Compare every event/session identity before allowing account-specific telemetry. */
export function envelopeAccount(envelope: SlateSentryEnvelope, currentUserId?: string): AccountMatch {
  if (currentUserId === undefined) return "match";

  let foundIdentity = false;
  for (const [header, item] of envelope[1]) {
    if (!isEnvelopeRecord(item)) continue;
    const identity = accountIdentifier(header, item);
    if (typeof identity !== "string" && typeof identity !== "number") continue;
    if (String(identity) !== currentUserId) return "mismatch";
    foundIdentity = true;
  }
  return foundIdentity ? "match" : "missing";
}

function tierForAccount(requested: SlateSentryPrivacyTier, match: AccountMatch): SlateSentryPrivacyTier {
  if (match === "mismatch") return "fatal-metadata";
  if (match === "missing" && requested === "full") return "scrubbed";
  return requested;
}

/** Apply the privacy tier, account downgrade and unknown-process refusal before delivery. */
export class SlateSentryPrivacyGate {
  private tier: SlateSentryPrivacyTier = "fatal-metadata";
  private userId: string | undefined;

  setTier(tier: SlateSentryPrivacyTier): void {
    this.tier = tier;
  }

  setUserId(userId?: string): void {
    this.userId = userId;
  }

  handle(envelope: SlateSentryEnvelope): SlateSentryEnvelope | undefined {
    if (isUnknownProcessEnvelope(envelope)) return undefined;
    const tier = tierForAccount(this.tier, envelopeAccount(envelope, this.userId));
    return projectSlateSentryEnvelope(envelope, tier) as SlateSentryEnvelope | undefined;
  }

  belongsToCurrentAccount(envelope: SlateSentryEnvelope): boolean {
    return envelopeAccount(envelope, this.userId) === "match";
  }
}

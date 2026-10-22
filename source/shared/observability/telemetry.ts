/**
 * The names the platform's own telemetry uses.
 *
 * The causes an account can be blocked are a fixed set, so a report that says why is one of them; the steps of
 * onboarding and the slices of what a client persists are named the same way, which is what lets a report be read
 * across versions; and the codes a queued send is flushed with are ours to define, so a failure can be looked up.
 */

/** The vocabulary once: four named lists of wire values, under the names reports already read them by. */
const SLATE_TELEMETRY_VOCABULARY = {
  accessBlockedCauses: ["wrong_account_suspected", "seat_revoked", "plan_expired", "no_plan", "unknown"],
  onboardingStepNames: ["meet", "computer-demo", "jobs", "tools", "create", "hand-off"],
  queuedFlushCauseCodes: { nonceMismatch: "SLATE-E0703", capabilityUnavailable: "SLATE-E0704", hostRejected: "SLATE-E0705", superseded: "SLATE-E0706", ackExpired: "SLATE-E0707" },
  clientPersistenceSlices: ["client-meta.account-slot", "composer-drafts", "host-settings.onboarding", "roster.agent-avatars", "roster.last-roster", "selection.last-agent", "send-journal", "sidebar.last-sections", "transcript.replicas", "ui-agent-refs", "ui-layout", "other"],
} as const;

/** The causes an account can be blocked for: a report that says why is one of these. */
export const SLATE_ACCESS_BLOCKED_CAUSES = SLATE_TELEMETRY_VOCABULARY.accessBlockedCauses;

/** The steps onboarding walks through, in order. */
export const SLATE_ONBOARDING_STEP_NAMES = SLATE_TELEMETRY_VOCABULARY.onboardingStepNames;

/** The codes a queued send is flushed with, so a failure can be looked up. */
export const SLATE_QUEUED_FLUSH_CAUSE_CODES = SLATE_TELEMETRY_VOCABULARY.queuedFlushCauseCodes;

/** The slices of client state the platform persists. */
export const SLATE_CLIENT_PERSISTENCE_SLICES = SLATE_TELEMETRY_VOCABULARY.clientPersistenceSlices;

const persistedSlices = new Set<string>(SLATE_CLIENT_PERSISTENCE_SLICES);

/** Whether a value names one of the slices the client persists. */
export function isSlateClientPersistenceSlice(value: unknown): value is (typeof SLATE_CLIENT_PERSISTENCE_SLICES)[number] {
  return typeof value === "string" && persistedSlices.has(value);
}
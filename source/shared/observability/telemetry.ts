/**
 * The names the platform's own telemetry uses.
 *
 * The causes an account can be blocked are a fixed set, so a report that says why is one of them; the steps of
 * onboarding and the slices of what a client persists are named the same way, which is what lets a report be read
 * across versions; and the codes a queued send is flushed with are ours to define, so a failure can be looked up.
 */
export const SLATE_ACCESS_BLOCKED_CAUSES = ["wrong_account_suspected", "seat_revoked", "plan_expired", "no_plan", "unknown"] as const;
export const SLATE_ONBOARDING_STEP_NAMES = ["meet", "computer-demo", "jobs", "tools", "create", "hand-off"] as const;
export const SLATE_QUEUED_FLUSH_CAUSE_CODES = { nonceMismatch: "SLATE-E0703", capabilityUnavailable: "SLATE-E0704", hostRejected: "SLATE-E0705", superseded: "SLATE-E0706", ackExpired: "SLATE-E0707" } as const;
export const SLATE_CLIENT_PERSISTENCE_SLICES = ["client-meta.account-slot", "composer-drafts", "host-settings.onboarding", "roster.agent-avatars", "roster.last-roster", "selection.last-agent", "send-journal", "sidebar.last-sections", "transcript.replicas", "ui-agent-refs", "ui-layout", "other"] as const;
const sliceSet = new Set<string>(SLATE_CLIENT_PERSISTENCE_SLICES);
export function isSlateClientPersistenceSlice(value: unknown): value is (typeof SLATE_CLIENT_PERSISTENCE_SLICES)[number] { return typeof value === "string" && sliceSet.has(value); }

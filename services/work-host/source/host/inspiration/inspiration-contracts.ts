/**
 * A Bot's proactive curiosity subscription.
 *
 * This is deliberately not a cron trigger: the host holds a stochastic
 * subscription that emits "inspiration" events, asks the Bot's own model for
 * divergent candidates, gates them, and only then wakes the Bot with a hidden
 * prompt. The Bot may act, may send a message, or may stay silent.
 */
import type { InspirationObservation, InspirationPreferences } from './inspiration-observations.ts';
import type { PreferenceSummary } from './inspiration-preference-summary.ts';

export const INSPIRATION_STORE_VERSION = 1;
export const INSPIRATION_MAX_LEDGER = 100;
export const INSPIRATION_MAX_CANDIDATES = 5;

export type InspirationTrigger = "stochastic" | "manual" | "nomination" | "event";
export type InspirationDecision = "woke" | "skipped" | "duplicate" | "budget" | "quiet" | "cap" | "unavailable" | "error";
export type InspirationOutcome = "acted" | "silent" | "failed";
export type InspirationFeedback = "useful" | "not-useful" | "dismissed";

export type InspirationLens =
  | "identity"
  | "conversation"
  | "workspace"
  | "security"
  | "performance"
  | "reliability"
  | "ux"
  | "tests"
  | "docs"
  | "user-goal"
  | "random";

export const INSPIRATION_LENSES: readonly InspirationLens[] = [
  "identity",
  "conversation",
  "workspace",
  "security",
  "performance",
  "reliability",
  "ux",
  "tests",
  "docs",
  "user-goal",
  "random",
];

export interface InspirationCadence {
  /** Mean delay of the Poisson process. */
  meanIntervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  /** Probability of a second inspiration inside the same window. */
  burstChance: number;
}

export interface InspirationConfig {
  cadence: InspirationCadence;
  lenses: InspirationLens[];
  topics: string[];
}

export interface InspirationCandidate {
  title: string;
  whyNow: string;
  firstAction: string;
  expectedValue: number;
  estimatedCost: number;
  novelty: number;
  lens: InspirationLens;
}

export interface InspirationUsage {
  dayKey: string;
  usd: number;
  tokens: number;
  runs: number;
}

export interface InspirationRecord {
  id: string;
  createdAt: number;
  trigger: InspirationTrigger;
  sourceAgentId?: string;
  lens: InspirationLens;
  candidate: InspirationCandidate | null;
  decision: InspirationDecision;
  detail?: string;
  outcome?: InspirationOutcome;
  messageCount: number;
  costUsd: number;
  tokens: number;
  feedback?: InspirationFeedback;
}

export interface InspirationNomination {
  id: string;
  fromAgentId: string;
  task: string;
  createdAt: number;
}

export interface InspirationState {
  version: typeof INSPIRATION_STORE_VERSION;
  agentId: string;
  config: InspirationConfig;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  ledger: InspirationRecord[];
  nominations: InspirationNomination[];
  feedback: { useful: number; notUseful: number; dismissed: number };
  usage: InspirationUsage;
  observationCursor: string | null;
  observations: InspirationObservation[];
  preferences: InspirationPreferences;
  preferenceSummary: PreferenceSummary | null;
  preferenceSummaryAttemptAt: number | null;
}

export interface InspirationGateResult {
  selection: number | null;
  reason: string;
}

export interface InspirationRunResult {
  decision: InspirationDecision;
  detail?: string;
  outcome?: InspirationOutcome;
  recordId?: string;
}

export const DEFAULT_INSPIRATION_CONFIG: InspirationConfig = {
  cadence: {
    meanIntervalMs: 6 * 60 * 60_000,
    minIntervalMs: 45 * 60_000,
    maxIntervalMs: 24 * 60 * 60_000,
    burstChance: 0.08,
  },
  lenses: [],
  topics: [],
};

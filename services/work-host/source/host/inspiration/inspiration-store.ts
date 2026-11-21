/**
 * Durable per-Bot inspiration subscriptions, beside the Bot's other host files.
 *
 * Work-host keeps preferences, scheduling and usage beside the transcript.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_OBSERVATIONS, normalizePreferences, observationCursor, parseObservation, type InspirationObservation } from './inspiration-observations.ts';
import { normalizePreferenceSummary } from './inspiration-preference-summary.ts';
import {
  DEFAULT_INSPIRATION_CONFIG,
  INSPIRATION_LENSES,
  INSPIRATION_MAX_LEDGER,
  INSPIRATION_STORE_VERSION,
  type InspirationCadence,
  type InspirationCandidate,
  type InspirationConfig,
  type InspirationDecision,
  type InspirationFeedback,
  type InspirationLens,
  type InspirationNomination,
  type InspirationOutcome,
  type InspirationRecord,
  type InspirationState,
  type InspirationTrigger,
  type InspirationUsage,
} from "./inspiration-contracts.ts";

const STORE_FILENAME = "inspiration.json";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function lensOf(value: unknown): InspirationLens {
  return typeof value === "string" && (INSPIRATION_LENSES as readonly string[]).includes(value)
    ? value as InspirationLens
    : "random";
}

function normalizeCadence(value: unknown): InspirationCadence {
  const record = recordOf(value);
  const mean = clamp(finite(record?.meanIntervalMs, DEFAULT_INSPIRATION_CONFIG.cadence.meanIntervalMs), 15 * MINUTE, 7 * DAY);
  const min = clamp(finite(record?.minIntervalMs, DEFAULT_INSPIRATION_CONFIG.cadence.minIntervalMs), 5 * MINUTE, mean);
  const max = clamp(finite(record?.maxIntervalMs, DEFAULT_INSPIRATION_CONFIG.cadence.maxIntervalMs), mean, 7 * DAY);
  return {
    meanIntervalMs: Math.round(mean),
    minIntervalMs: Math.round(min),
    maxIntervalMs: Math.round(max),
    burstChance: clamp(finite(record?.burstChance, DEFAULT_INSPIRATION_CONFIG.cadence.burstChance), 0, 0.5),
  };
}

export function normalizeInspirationConfig(value: unknown): InspirationConfig {
  const record = recordOf(value);
  const lensList = Array.isArray(record?.lenses) ? record.lenses : [];
  const topicList = Array.isArray(record?.topics) ? record.topics : [];
  const lenses = [...new Set(lensList.map(lensOf).filter((lens) => lens !== "random" || lensList.length === 1))].slice(0, INSPIRATION_LENSES.length);
  const topics = [...new Set(topicList.map((topic) => text(topic, 120)).filter(Boolean))].slice(0, 20);
  return {
    cadence: normalizeCadence(record?.cadence),
    lenses,
    topics,
  };
}

function normalizeCandidate(value: unknown): InspirationCandidate | null {
  const record = recordOf(value);
  const title = text(record?.title, 200);
  if (!title) return null;
  return {
    title,
    whyNow: text(record?.whyNow, 600),
    firstAction: text(record?.firstAction, 600),
    expectedValue: clamp(finite(record?.expectedValue, 0.5), 0, 1),
    estimatedCost: clamp(finite(record?.estimatedCost, 0.3), 0, 1),
    novelty: clamp(finite(record?.novelty, 0.5), 0, 1),
    lens: lensOf(record?.lens),
  };
}

function normalizeDecision(value: unknown): InspirationDecision {
  return value === "woke" || value === "skipped" || value === "duplicate" || value === "budget"
    || value === "quiet" || value === "cap" || value === "unavailable" || value === "error"
    ? value
    : "skipped";
}

function normalizeOutcome(value: unknown): InspirationOutcome | undefined {
  return value === "acted" || value === "silent" || value === "failed" ? value : undefined;
}

function normalizeTrigger(value: unknown): InspirationTrigger {
  return value === "manual" || value === "nomination" || value === "event" ? value : "stochastic";
}

function normalizeFeedback(value: unknown): InspirationFeedback | undefined {
  return value === "useful" || value === "not-useful" || value === "dismissed" ? value : undefined;
}

function normalizeRecord(value: unknown): InspirationRecord | null {
  const record = recordOf(value);
  const id = text(record?.id, 128);
  if (!id) return null;
  const outcome = normalizeOutcome(record?.outcome);
  const feedback = normalizeFeedback(record?.feedback);
  return {
    id,
    createdAt: Math.round(finite(record?.createdAt, 0)),
    trigger: normalizeTrigger(record?.trigger),
    ...(typeof record?.sourceAgentId === "string" ? { sourceAgentId: text(record.sourceAgentId, 128) } : {}),
    lens: lensOf(record?.lens),
    candidate: normalizeCandidate(record?.candidate),
    decision: normalizeDecision(record?.decision),
    ...(typeof record?.detail === "string" && record.detail.trim() ? { detail: text(record.detail, 1000) } : {}),
    ...(outcome === undefined ? {} : { outcome }),
    messageCount: Math.round(clamp(finite(record?.messageCount, 0), 0, 1000)),
    costUsd: clamp(finite(record?.costUsd, 0), 0, 1_000_000),
    tokens: Math.round(clamp(finite(record?.tokens, 0), 0, 100_000_000)),
    ...(feedback === undefined ? {} : { feedback }),
  };
}

function normalizeNomination(value: unknown): InspirationNomination | null {
  const record = recordOf(value);
  const id = text(record?.id, 128);
  const fromAgentId = text(record?.fromAgentId, 128);
  const task = text(record?.task, 2000);
  if (!id || !fromAgentId || !task) return null;
  return { id, fromAgentId, task, createdAt: Math.round(finite(record?.createdAt, 0)) };
}

function normalizeUsage(value: unknown): InspirationUsage {
  const record = recordOf(value);
  return {
    dayKey: text(record?.dayKey, 32),
    usd: Math.max(0, finite(record?.usd, 0)),
    tokens: Math.round(Math.max(0, finite(record?.tokens, 0))),
    runs: Math.round(Math.max(0, finite(record?.runs, 0))),
  };
}

export function parseInspirationState(agentId: string, value: unknown): InspirationState | null {
  const record = recordOf(value);
  if (record === null) return null;
  const config = normalizeInspirationConfig(record.config);
  const ledger = Array.isArray(record.ledger)
    ? record.ledger.map(normalizeRecord).filter((entry): entry is InspirationRecord => entry !== null).slice(-INSPIRATION_MAX_LEDGER)
    : [];
  const nominations = Array.isArray(record.nominations)
    ? record.nominations.map(normalizeNomination).filter((entry): entry is InspirationNomination => entry !== null).slice(-20)
    : [];
  const feedback = recordOf(record.feedback);
  const legacyConfig = recordOf(record.config);
  const lastDecision = ledger.at(-1)?.decision;
  const deferredByLegacyPolicy = legacyConfig !== null && "enabled" in legacyConfig
    && (lastDecision === "budget" || lastDecision === "cap" || lastDecision === "quiet");
  return {
    version: INSPIRATION_STORE_VERSION,
    agentId,
    config,
    nextFireAt: !deferredByLegacyPolicy && typeof record.nextFireAt === "number" && Number.isFinite(record.nextFireAt)
      ? record.nextFireAt : null,
    lastFiredAt: typeof record.lastFiredAt === "number" && Number.isFinite(record.lastFiredAt) ? record.lastFiredAt : null,
    ledger,
    nominations,
    feedback: {
      useful: Math.round(clamp(finite(feedback?.useful, 0), 0, 1_000_000)),
      notUseful: Math.round(clamp(finite(feedback?.notUseful, 0), 0, 1_000_000)),
      dismissed: Math.round(clamp(finite(feedback?.dismissed, 0), 0, 1_000_000)),
    },
    usage: normalizeUsage(record.usage),
    observationCursor: observationCursor(record.observationCursor),
    observations: Array.isArray(record.observations) ? record.observations.slice(-MAX_OBSERVATIONS).map(parseObservation)
      .filter((value): value is InspirationObservation => value !== null) : [],
    preferences: normalizePreferences(record.preferences),
    preferenceSummary: normalizePreferenceSummary(record.preferenceSummary),
    preferenceSummaryAttemptAt: finite(record.preferenceSummaryAttemptAt, 0) || null,
  };
}

export function defaultInspirationState(agentId: string): InspirationState {
  return {
    version: INSPIRATION_STORE_VERSION,
    agentId,
    config: {
      ...DEFAULT_INSPIRATION_CONFIG,
      cadence: { ...DEFAULT_INSPIRATION_CONFIG.cadence },
      lenses: [],
      topics: [],
    },
    nextFireAt: null,
    lastFiredAt: null,
    ledger: [],
    nominations: [],
    feedback: { useful: 0, notUseful: 0, dismissed: 0 },
    usage: { dayKey: "", usd: 0, tokens: 0, runs: 0 },
    observationCursor: null,
    observations: [],
    preferences: { samples: 0, weights: {} },
    preferenceSummary: null,
    preferenceSummaryAttemptAt: null,
  };
}

/** Keep a state's ledger and candidate list bounded before it is written. */
export function trimInspirationState(state: InspirationState): InspirationState {
  return {
    ...state,
    ledger: state.ledger.slice(-INSPIRATION_MAX_LEDGER),
    nominations: state.nominations.slice(-20),
    observations: state.observations.slice(-MAX_OBSERVATIONS),
  };
}

export class InspirationStore {
  constructor(readonly rootDir: string) {}

  private pathFor(agentId: string): string {
    if (!SAFE_ID.test(agentId)) throw new Error(`invalid inspiration agent id: ${agentId}`);
    return join(this.rootDir, agentId, STORE_FILENAME);
  }

  read(agentId: string): InspirationState {
    if (!SAFE_ID.test(agentId)) return defaultInspirationState(agentId);
    try {
      const parsed = parseInspirationState(agentId, JSON.parse(readFileSync(this.pathFor(agentId), "utf8")));
      return parsed ?? defaultInspirationState(agentId);
    } catch {
      return defaultInspirationState(agentId);
    }
  }

  write(state: InspirationState): void {
    const path = this.pathFor(state.agentId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(trimInspirationState(state), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }

  update(agentId: string, change: (state: InspirationState) => InspirationState): InspirationState {
    const next = trimInspirationState(change(this.read(agentId)));
    this.write(next);
    return next;
  }
}

/**
 * The proactive curiosity loop.
 *
 * A tick finds the Bots whose stochastic subscription is due, ranks them with a
 * dynamic trade-off score, and processes them in order. Firing gathers the Bot's
 * identity, recent conversation and workspace, asks its model for divergent
 * candidates, gates them, then runs one hidden, silence-allowed turn. The Bot
 * can investigate and call SendMessage; the final assistant text is suppressed.
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { getSlateProfilePath, readSlateProfileFile } from "../agents/agent-profile.ts";
import type { BotRuntimeBinding } from "../bot/bot-runtime-store.ts";
import { PiWorkerClient } from "../bot/pi-worker-client.ts";
import type { TranscriptEntry, TranscriptManagerLike } from "../transcript/transcript-hub.ts";
import {
  buildGatePrompt,
  buildGeneratePrompt,
  buildObservationGatePrompt,
  buildWakePrompt,
  parseInspirationCandidates,
  parseInspirationGate,
  parseObservationScore,
  pickLens,
  type InspirationIdentity,
} from "./inspiration-divergence.ts";
import { deriveInspirationPreferences, lensPreference, MAX_OBSERVATIONS, OBSERVATION_MAX_AGE_MS, observationPriority } from './inspiration-observations.ts';
import { blendInspirationPreferences, buildPreferenceSummaryPrompt, dialogueContent, parsePreferenceSummary, PREFERENCE_MIN_INTERVAL_MS, preferenceSummaryWindow, recentClassificationCodes } from './inspiration-preference-summary.ts';
import {
  type InspirationCandidate,
  type InspirationConfig,
  type InspirationFeedback,
  type InspirationRecord,
  type InspirationRunResult,
  type InspirationState,
  type InspirationTrigger,
} from "./inspiration-contracts.ts";
import {
  computeNextFireAt,
  inspirationDayKey,
  inspirationPriority,
  nextInspirationReview,
  resetUsageIfNeeded,
} from "./inspiration-scheduler.ts";
import { normalizeInspirationConfig, trimInspirationState, type InspirationStore } from "./inspiration-store.ts";

const HIDDEN_PROMPT_PREFIX = "[SLATE_HIDDEN_PROMPT]";
const FOLLOW_UP_DELAY_MS = 2 * 60_000;
const RETRY_AFTER_ERROR_MS = 2 * 60_000;
const RETRY_AFTER_BUSY_MS = 30_000;
const MIN_EVENT_SCORE = 0.64;

export interface InspirationRuntimeDeps {
  readonly tm: TranscriptManagerLike;
  readonly store: InspirationStore;
  readonly listBindings: () => BotRuntimeBinding[];
  readonly getBinding: (agentId: string) => BotRuntimeBinding | null;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timeZone?: () => string | undefined;
  readonly tickMs?: number;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
}

function identityForSession(session: Record<string, any>): InspirationIdentity {
  const profile = readSlateProfileFile(getSlateProfilePath(dirname(String(session.dbPath))));
  return {
    name: profile?.name ?? "Bot",
    description: profile?.description ?? "",
    title: profile?.title ?? "",
    instructions: profile?.instructions ?? "",
  };
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value: string): Set<string> {
  const normalized = normalizeTitle(value);
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}

/** A cheap, local duplicate check: exact normalized match or high bigram overlap. */
export function isDuplicateTitle(candidate: string, recent: readonly InspirationRecord[]): boolean {
  const target = normalizeTitle(candidate);
  if (!target) return true;
  const targetBigrams = bigrams(candidate);
  for (const record of recent) {
    const title = record.candidate?.title;
    if (!title) continue;
    if (normalizeTitle(title) === target) return true;
    const other = bigrams(title);
    if (targetBigrams.size === 0 || other.size === 0) continue;
    let overlap = 0;
    for (const gram of targetBigrams) if (other.has(gram)) overlap += 1;
    if (2 * overlap / (targetBigrams.size + other.size) >= 0.76) return true;
  }
  return false;
}

function formatTranscript(entries: readonly TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries.slice(-40)) {
    const source = dialogueContent(entry);
    const content = typeof source === "string" ? source.replace(/\s+/g, " ").trim() : "";
    if (!content) continue;
    const role = entry.kind === 'message' && entry.role === "user" ? "User" : "Bot";
    if (role === 'User' && content.startsWith(HIDDEN_PROMPT_PREFIX)) continue;
    lines.push(`${role}: ${content.slice(0, 400)}`);
  }
  return lines.slice(-24).join("\n").slice(0, 12_000);
}

function addUsage(
  state: InspirationState,
  now: number,
  timeZone: string | undefined,
  costUsd: number,
  tokens: number,
  runs: number,
): InspirationState["usage"] {
  const dayKey = inspirationDayKey(now, timeZone);
  const sameDay = state.usage.dayKey === dayKey;
  return {
    dayKey,
    usd: (sameDay ? state.usage.usd : 0) + costUsd,
    tokens: (sameDay ? state.usage.tokens : 0) + tokens,
    runs: (sameDay ? state.usage.runs : 0) + runs,
  };
}

function recordFor(input: {
  trigger: InspirationTrigger;
  lens: InspirationCandidate["lens"];
  candidate: InspirationCandidate | null;
  decision: InspirationRecord["decision"];
  detail?: string | undefined;
  outcome?: InspirationRecord["outcome"];
  messageCount?: number | undefined;
  costUsd?: number;
  tokens?: number;
  sourceAgentId?: string | undefined;
  createdAt?: number;
}): InspirationRecord {
  return {
    id: randomUUID(),
    createdAt: input.createdAt ?? Date.now(),
    trigger: input.trigger,
    ...(input.sourceAgentId === undefined ? {} : { sourceAgentId: input.sourceAgentId }),
    lens: input.lens,
    candidate: input.candidate,
    decision: input.decision,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    messageCount: input.messageCount ?? 0,
    costUsd: input.costUsd ?? 0,
    tokens: input.tokens ?? 0,
  };
}

export class InspirationRuntime {
  readonly #store: InspirationStore;
  readonly #tm: TranscriptManagerLike;
  readonly #listBindings: InspirationRuntimeDeps["listBindings"];
  readonly #getBinding: (agentId: string) => BotRuntimeBinding | null;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #timeZone: () => string | undefined;
  readonly #tickMs: number;
  readonly #logger: Pick<Console, "info" | "warn" | "error">;
  readonly #firing = new Set<string>();
  readonly #waking = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #started = false;
  #observing = false;
  #ticking = false;
  #summarizing: string | null = null;

  constructor(deps: InspirationRuntimeDeps) {
    this.#tm = deps.tm;
    this.#store = deps.store;
    this.#listBindings = deps.listBindings;
    this.#getBinding = deps.getBinding;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
    this.#timeZone = deps.timeZone ?? (() => undefined);
    this.#tickMs = Math.max(5_000, deps.tickMs ?? 30_000);
    this.#logger = deps.logger ?? console;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const cycle = () => {
      void this.collectObservations().then(() => this.tick()).catch((error) => {
        this.#logger.warn(`[inspiration] background cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    cycle();
    this.#timer = setInterval(cycle, this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#started = false;
  }

  state(agentId: string): InspirationState {
    const now = this.#now();
    const raw = this.#store.read(agentId);
    const state = resetUsageIfNeeded(raw, now, this.#timeZone());
    if (state.nextFireAt !== null || !this.#getBinding(agentId)) return state;
    const nextFireAt = computeNextFireAt({ now, config: state.config, random: this.#random });
    const next = { ...state, nextFireAt };
    this.#store.write(next);
    return next;
  }

  configure(agentId: string, patch: Partial<InspirationConfig>): InspirationState {
    const current = this.state(agentId);
    const config = normalizeInspirationConfig({ ...current.config, ...patch });
    const next = { ...current, config };
    this.#store.write(next);
    return next;
  }

  feedback(agentId: string, recordId: string, feedback: InspirationFeedback): InspirationState {
    const current = this.state(agentId);
    const old = current.ledger.find((record) => record.id === recordId);
    if (!old || old.feedback === feedback) return current;
    const ledger = current.ledger.map((record) => record.id === recordId ? { ...record, feedback } : record);
    const feedbackCounts = { ...current.feedback };
    const key = (value: InspirationFeedback) => value === 'not-useful' ? 'notUseful' : value;
    if (old.feedback) feedbackCounts[key(old.feedback)] = Math.max(0, feedbackCounts[key(old.feedback)] - 1);
    feedbackCounts[key(feedback)]++;
    const next = trimInspirationState({ ...current, ledger, feedback: feedbackCounts });
    this.#store.write(next);
    return next;
  }

  /** A sibling Bot asks this Bot to take a specific focus next. */
  nominate(fromAgentId: string, targetAgentId: string, task: string): { ok: boolean; reason?: string } {
    if (fromAgentId === targetAgentId) return { ok: false, reason: "cannot nominate itself" };
    const target = this.state(targetAgentId);
    const now = this.#now();
    const nomination = {
      id: randomUUID(),
      fromAgentId,
      task: task.trim().slice(0, 2000),
      createdAt: now,
    };
    if (!nomination.task) return { ok: false, reason: "the nomination is empty" };
    if (target.nominations.some(item => item.fromAgentId === fromAgentId && normalizeTitle(item.task) === normalizeTitle(nomination.task))) return { ok: true };
    const next = trimInspirationState({
      ...target,
      nominations: [...target.nominations, nomination].slice(-20),
    });
    this.#store.write(next);
    return { ok: true };
  }

  async runNow(agentId: string): Promise<InspirationRunResult> {
    return await this.fire(agentId, "manual");
  }

  /** Refresh preference weights and read the provisioned workers' bounded queues. */
  async collectObservations(): Promise<void> {
    if (this.#observing) return;
    this.#observing = true;
    try {
      const bindings = this.#listBindings();
      const summaries: Array<{ agentId: string; session: Record<string, any>; client: PiWorkerClient; at: number }> = [];
      for (let offset = 0; offset < bindings.length; offset += 4) {
        await Promise.all(bindings.slice(offset, offset + 4).map(async (binding) => {
          const state = this.state(binding.agentId);
          const session = await this.#resolveSession(state.agentId);
          const client = new PiWorkerClient(binding);
          const batch = await client.inspirationObservations(state.observationCursor);
          if (this.#getBinding(state.agentId)?.updatedAt !== binding.updatedAt) return;
          const latest = this.#store.read(state.agentId);
          const now = this.#now();
          const entries = session ? this.#entriesFor(session) : [];
          const preferences = session ? this.#derivePreferences(entries, latest, now) : latest.preferences;
          const latestUserMessage = entries.findLast((entry) => entry.kind === 'message' && entry.role === 'user'
            && typeof entry.content === 'string' && !entry.content.startsWith(HIDDEN_PROMPT_PREFIX));
          const userText = latestUserMessage?.content?.trim() ?? '';
          const userAt = latestUserMessage?.timestampMs;
          const followUp = latestUserMessage && latestUserMessage.id !== latest.followUp?.messageId && userText.length >= 8
            && typeof userAt === 'number' && userAt >= now - OBSERVATION_MAX_AGE_MS && userAt <= now
            ? { messageId: latestUserMessage.id, dueAt: userAt + FOLLOW_UP_DELAY_MS }
            : latest.followUp;
          const busy = this.#isBusy(state.agentId) || this.#firing.has(state.agentId);
          const lastAttempt = latest.preferenceSummaryAttemptAt ?? 0;
          if (session && !busy && now - lastAttempt >= PREFERENCE_MIN_INTERVAL_MS
            && preferenceSummaryWindow(entries, latest.preferenceSummary, now)) {
            summaries.push({ agentId: state.agentId, session, client, at: lastAttempt });
          }
          const [previousGeneration, previousSequence] = latest.observationCursor?.split(':') ?? [];
          const [generation, sequence] = batch?.cursor.split(':') ?? [];
          const alreadyRead = generation === previousGeneration ? Number(previousSequence) : 0;
          const acceptBatch = batch !== null && state.observationCursor === latest.observationCursor
            && (generation !== previousGeneration || Number(sequence) > alreadyRead);
          const observed = acceptBatch && !this.#waking.has(state.agentId) ? batch.observations.flatMap((item) => {
            if (item.sequence <= alreadyRead || item.observedAt < now - OBSERVATION_MAX_AGE_MS
              || item.observedAt > now + 60_000) return [];
            if (!busy || !item.traffic) return [item];
            return item.files.length ? [{ sequence: item.sequence, observedAt: item.observedAt, files: item.files }] : [];
          }) : [];
          const retained = latest.observations.filter(({ observedAt }) => observedAt >= now - OBSERVATION_MAX_AGE_MS);
          const changed = followUp !== latest.followUp || acceptBatch || retained.length !== latest.observations.length || JSON.stringify(preferences) !== JSON.stringify(latest.preferences);
          if (!changed) return;
          const observations = [...retained, ...observed].slice(-MAX_OBSERVATIONS);
          this.#store.write({
            ...latest, preferences, observations, followUp,
            observationCursor: acceptBatch ? batch.cursor : latest.observationCursor,
          });
        }));
      }
      if (!this.#summarizing) {
        summaries.sort((a, b) => a.at - b.at);
        const first = summaries[0];
        if (first) void this.#summarizePreferences(first.agentId, first.session, first.client).catch((error) => {
          this.#logger.warn(`[inspiration] preference summary failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } finally {
      this.#observing = false;
    }
  }

  #isBusy(agentId: string): boolean {
    return this.#summarizing === agentId || this.#tm.runLifecycle.runningAgentIds?.().has(agentId) === true;
  }

  #derivePreferences(entries: readonly TranscriptEntry[], state: InspirationState, now: number) {
    return blendInspirationPreferences(deriveInspirationPreferences(entries, state.ledger, now), state.preferenceSummary, now);
  }

  async #summarizePreferences(agentId: string, session: Record<string, any>, client: PiWorkerClient): Promise<void> {
    if (this.#summarizing || this.#firing.has(agentId) || this.#isBusy(agentId)) return;
    const now = this.#now();
    const timeZone = this.#timeZone();
    const state = this.state(agentId);
    if (now - (state.preferenceSummaryAttemptAt ?? 0) < PREFERENCE_MIN_INTERVAL_MS) return;
    const window = preferenceSummaryWindow(this.#entriesFor(session), state.preferenceSummary, now);
    if (!window) return;
    this.#summarizing = agentId;
    try {
      this.#store.update(agentId, current => ({ ...current, preferenceSummaryAttemptAt: now }));
      const result = await client.inspirationComplete({ ...buildPreferenceSummaryPrompt(window, state.preferenceSummary), maxTokens: 1_024, temperature: 0.2 });
      if (!result) return;
      const updatedAt = this.#now();
      const summary = parsePreferenceSummary(result.text, { throughId: window.throughId, throughAt: window.throughAt, updatedAt });
      if (!summary) this.#logger.warn('[inspiration] preference summary response was invalid');
      this.#store.update(agentId, (current) => {
        const accounted = { ...current, usage: addUsage(current, updatedAt, timeZone, Math.max(0, result.costUsd), Math.max(0, result.usage?.totalTokens ?? 0), 0) };
        if (!summary) return accounted;
        const next = { ...accounted, preferenceSummary: summary };
        return { ...next, preferences: this.#derivePreferences(this.#entriesFor(session), next, updatedAt) };
      });
    } finally {
      this.#summarizing = null;
    }
  }

  /** Process due subscriptions in priority order, one background evaluation at a time. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try { await this.#tickDue(); } finally { this.#ticking = false; }
  }

  async #tickDue(): Promise<void> {
    const now = this.#now();
    const due: Array<{ agentId: string; score: number }> = [];
    for (const binding of this.#listBindings()) {
      const state = this.state(binding.agentId);
      const scheduled = nextInspirationReview(state, now);
      if (!scheduled || scheduled.at > now || this.#firing.has(state.agentId)) continue;
      const session = await this.#resolveSession(state.agentId);
      if (session === null) continue;
      due.push({ agentId: state.agentId, score: this.#score(state, identityForSession(session), now) });
    }
    due.sort((a, b) => b.score - a.score);
    for (const { agentId } of due) {
      if (!this.#getBinding(agentId)) continue;
      const scheduled = nextInspirationReview(this.#store.read(agentId), this.#now());
      if (!scheduled || scheduled.at > this.#now()) continue;
      await this.fire(agentId, scheduled.trigger).catch((error) => {
        this.#logger.warn(`[inspiration] tick fire failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  #score(state: InspirationState, identity: InspirationIdentity, now: number): number {
    return inspirationPriority({
      state,
      instructions: identity.instructions,
      description: identity.description,
      now,
      random: this.#random,
    }) + 0.25 * observationPriority(state.observations.filter(({ observedAt }) => observedAt >= now - OBSERVATION_MAX_AGE_MS), state.preferences);
  }

  async #resolveSession(agentId: string): Promise<Record<string, any> | null> {
    try {
      return await this.#tm.sessions.resolveBackgroundSession(agentId);
    } catch {
      return null;
    }
  }

  async fire(
    agentId: string,
    trigger: InspirationTrigger,
  ): Promise<InspirationRunResult> {
    if (this.#firing.has(agentId)) return { decision: 'skipped', detail: 'already firing' };
    this.#firing.add(agentId);
    const timeZone = this.#timeZone();
    const initial = this.state(agentId);
    const observations = trigger === 'event' ? initial.observations.filter(({ observedAt }) => observedAt >= this.#now() - OBSERVATION_MAX_AGE_MS) : [];
    const observedKeys = new Set(observations.map(({ observedAt, sequence }) => observedAt + ':' + sequence));
    const followUp = trigger === 'follow-up' ? initial.followUp : null;
    const nomination = trigger === 'nomination' || trigger === 'manual' ? initial.nominations[0] : undefined;
    let costUsd = 0;
    let tokens = 0;
    let chargedRun = false;
    const finish = (details: {
      decision: InspirationRecord['decision']; detail?: string | undefined; candidate?: InspirationCandidate; consume?: boolean;
      outcome?: InspirationRecord['outcome']; messageCount?: number; nextAt?: number;
    }): InspirationRunResult => {
      const now = this.#now();
      const record = recordFor({
        trigger, lens: details.candidate?.lens ?? (trigger === 'event' ? 'workspace' : 'random'),
        candidate: details.candidate ?? null, decision: details.decision, detail: details.detail,
        costUsd, tokens, outcome: details.outcome, messageCount: details.messageCount,
        sourceAgentId: nomination?.fromAgentId, createdAt: now,
      });
      this.#store.update(agentId, (latest) => {
        const retained = latest.observations.filter(({ observedAt, sequence }) => (
          observedAt >= now - OBSERVATION_MAX_AGE_MS && (!details.consume || !observedKeys.has(observedAt + ':' + sequence))
        ));
        const nextFireAt = trigger === 'stochastic' && details.nextAt === undefined
          ? computeNextFireAt({ now, config: latest.config, random: this.#random })
          : latest.nextFireAt;
        return {
          ...latest, nextFireAt, observations: retained,
          retryAt: details.nextAt ?? null,
          followUp: details.consume && followUp && latest.followUp?.messageId === followUp.messageId
            ? { ...followUp, dueAt: null } : latest.followUp,
          ledger: [...latest.ledger, record],
          lastFiredAt: details.decision === 'woke' ? now : latest.lastFiredAt,
          nominations: nomination && details.consume ? latest.nominations.filter(({ id }) => id !== nomination.id) : latest.nominations,
        };
      });
      return {
        decision: record.decision, recordId: record.id,
        ...(record.detail === undefined ? {} : { detail: record.detail }),
        ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      };
    };
    try {
      if (trigger === 'event' && !observations.length) {
        return finish({ decision: 'skipped', detail: 'no current observations' });
      }
      const session = await this.#resolveSession(agentId);
      const binding = this.#getBinding(agentId);
      if (!session || !binding) {
        return finish({ decision: 'unavailable', detail: 'the Bot runtime is not provisioned', nextAt: this.#now() + RETRY_AFTER_ERROR_MS });
      }
      const hold = (): Parameters<typeof finish>[0] | null => {
        if (!this.#getBinding(agentId)) return { decision: 'unavailable', detail: 'the Bot runtime was released' };
        if (this.#isBusy(agentId)) return { decision: 'skipped', detail: 'Bot has an active turn', nextAt: this.#now() + RETRY_AFTER_BUSY_MS };
        return null;
      };
      const blocked = hold();
      if (blocked) return finish(blocked);

      const client = new PiWorkerClient(binding);
      const account = (cost: number, count: number) => {
        costUsd += Math.max(0, cost);
        tokens += Math.max(0, count);
        this.#store.update(agentId, (latest) => ({ ...latest, usage: addUsage(latest, this.#now(), timeZone, Math.max(0, cost), Math.max(0, count), 0) }));
      };
      const complete = async (input: Parameters<PiWorkerClient['inspirationComplete']>[0]) => {
        if (!chargedRun) {
          this.#store.update(agentId, (latest) => ({ ...latest, usage: addUsage(latest, this.#now(), timeZone, 0, 0, 1) }));
          chargedRun = true;
        }
        const result = await client.inspirationComplete(input);
        if (result) account(result.costUsd, result.usage?.totalTokens ?? 0);
        return result;
      };

      const entries = this.#entriesFor(session);
      const transcript = formatTranscript(entries);
      const preferences = this.#derivePreferences(entries, initial, this.#now());
      this.#store.update(agentId, (latest) => ({ ...latest, preferences }));
      const recent = initial.ledger.filter((record) => record.candidate !== null).slice(-20);
      const context = {
        identity: identityForSession(session), transcript, workspace: null as Record<string, unknown> | null,
        recentIdeas: recent, observations, preferences,
        ...(nomination === undefined ? {} : { nomination }),
        messageCodes: recentClassificationCodes(entries),
        followUp: followUp !== null,
        topics: initial.config.topics,
        lens: pickLens(initial.config.lenses, this.#random),
      };

      if (observations.length) {
        const result = await complete({ ...buildObservationGatePrompt(context), maxTokens: 220, temperature: 0.15 });
        if (!result) return finish({ decision: 'error', detail: 'the observation scorer is unavailable', nextAt: this.#now() + RETRY_AFTER_ERROR_MS });
        const judgment = parseObservationScore(result.text);
        const prior = observationPriority(observations, preferences);
        const score = judgment ? 0.82 * judgment.score + 0.18 * prior : 0;
        if (!judgment) return finish({ decision: 'error', detail: 'the observation score was invalid', nextAt: this.#now() + RETRY_AFTER_ERROR_MS });
        if (judgment.score < 0.55 || score < MIN_EVENT_SCORE) {
          return finish({ decision: 'skipped', detail: `Observation score ${score.toFixed(2)}: ${judgment.reason}`, consume: true });
        }
      }
      const beforeGeneration = hold();
      if (beforeGeneration) return finish(beforeGeneration);
      context.workspace = await client.inspirationContext();
      const beforeCompletion = hold();
      if (beforeCompletion) return finish(beforeCompletion);
      const generation = buildGeneratePrompt(context);
      const generated = await complete({ ...generation, maxTokens: 1_800, temperature: 0.5 });
      if (!generated) return finish({ decision: 'error', detail: 'the model completion failed', nextAt: this.#now() + RETRY_AFTER_ERROR_MS });

      let candidates = parseInspirationCandidates(generated.text, context.lens);
      if (!candidates) {
        const beforeRetry = hold();
        if (beforeRetry) return finish(beforeRetry);
        const repaired = await complete({
          ...generation, maxTokens: 1_200, temperature: 0.2,
          systemPrompt: `${generation.systemPrompt} Return at most two candidates and ensure the JSON is complete.`,
        });
        candidates = repaired ? parseInspirationCandidates(repaired.text, context.lens) : null;
      }
      if (!candidates) return finish({ decision: 'error', detail: 'the candidate model returned an invalid response', nextAt: this.#now() + RETRY_AFTER_ERROR_MS });
      if (candidates.length === 0) return finish({ decision: 'skipped', detail: 'the model returned no candidates', consume: true });
      const fresh = candidates.filter((candidate) => !isDuplicateTitle(candidate.title, recent));
      if (!fresh.length) return finish({ decision: 'duplicate', detail: 'all candidates repeated recent inspirations', consume: true });
      const localValue = (candidate: InspirationCandidate) =>
        (0.68 * candidate.expectedValue + 0.22 * candidate.novelty - 0.10 * candidate.estimatedCost) * lensPreference(candidate.lens, preferences);
      const ranked = fresh.filter(candidate => candidate.firstAction && candidate.expectedValue >= 0.5)
        .sort((a, b) => localValue(b) - localValue(a));
      if (!ranked.length) return finish({ decision: 'skipped', detail: 'no candidate had a concrete useful first step', consume: true });

      const beforeGate = hold();
      if (beforeGate) return finish(beforeGate);
      const gated = await complete({ ...buildGatePrompt(context, ranked), maxTokens: 768, temperature: 0.2 });
      if (!gated) return finish({ decision: 'error', detail: 'the candidate gate is unavailable', nextAt: this.#now() + RETRY_AFTER_ERROR_MS });
      const approval = parseInspirationGate(gated.text, ranked.length);
      if (!approval) return finish({ decision: 'error', detail: 'the candidate gate returned an invalid response', nextAt: this.#now() + RETRY_AFTER_ERROR_MS });
      const selected = approval.selection === null ? null : ranked[approval.selection];
      if (!selected) return finish({ decision: 'skipped', detail: approval.reason || 'the gate did not approve a candidate', consume: true });

      const beforeWake = hold();
      if (beforeWake) return finish(beforeWake);
      const wakePrompt = buildWakePrompt({ ...context, candidate: selected, mode: approval.mode });
      this.#waking.add(agentId);
      try {
        const wake = await this.#runWake(agentId, wakePrompt, (usage) => account(usage.costUsd, usage.tokens));
        if (!wake.ran) return finish({ decision: 'unavailable', detail: 'the Bot runtime was released before execution' });
        return finish({
          decision: 'woke', candidate: selected, detail: approval.reason || undefined, consume: true,
          outcome: wake.aborted ? 'failed' : wake.messageCount > 0 ? 'acted' : 'silent', messageCount: wake.messageCount,
        });
      } finally {
        this.#waking.delete(agentId);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600);
      this.#logger.warn(`[inspiration] fire failed for ${agentId}: ${detail}`);
      return finish({ decision: 'error', detail, nextAt: this.#now() + RETRY_AFTER_ERROR_MS });
    } finally {
      this.#firing.delete(agentId);
    }
  }

  #entriesFor(session: Record<string, any>): TranscriptEntry[] {
    const window = this.#tm.sessions.getAgentTranscriptTail?.(session.id, { limit: 260 });
    if (Array.isArray(window?.entries)) return window.entries;
    return session.db?.getTranscriptEntries?.() ?? [];
  }

  async #runWake(agentId: string, prompt: string,
    onInspirationUsage: (usage: { costUsd: number; tokens: number }) => void): Promise<{ messageCount: number; ran: boolean; aborted: boolean }> {
    const session = await this.#tm.sessions.resolveBackgroundSession(agentId);
    const runner = this.#tm.runnerRegistry.getRunner(session);
    this.#tm.runLifecycle.beginSessionRun(session);
    let messageCount = 0;
    let ran = false;
    let aborted = false;
    try {
      await this.#tm.runLifecycle.enqueueExclusiveRun(session.id, async () => {
        if (!this.#getBinding(agentId)) return;
        ran = true;
        this.#tm.turnRuntime.activeRequestSources.set(session.id, "inspiration");
        const result = await runner.run(prompt, {
          hidden: true,
          isSilenceAllowed: true,
          suppressFinalMessage: true,
          requestSource: "inspiration",
          onInspirationUsage,
        });
        messageCount = typeof result?.sentMessageCount === "number" ? result.sentMessageCount : 0;
        aborted = result?.aborted === true;
      }, { lane: "background", source: "inspiration" });
      await this.#tm.roster.emitAgentUpdate(session.id);
      return { messageCount, ran, aborted };
    } finally {
      this.#tm.runLifecycle.endSessionRun(session);
    }
  }
}

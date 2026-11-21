/**
 * The proactive curiosity loop.
 *
 * A tick finds the Bots whose stochastic subscription is due, ranks them with a
 * dynamic trade-off score, and fires at most one. Firing gathers the Bot's
 * identity, recent conversation and workspace, asks its model for divergent
 * candidates, gates them, then runs one hidden, silence-allowed turn. The Bot
 * can investigate and call SendMessage; the final assistant text is suppressed.
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { getSlateProfilePath, readSlateProfileFile } from "../agents/agent-profile.ts";
import type { BotRuntimeBinding } from "../bot/bot-runtime-store.ts";
import { PiWorkerClient } from "../bot/pi-worker-client.ts";
import { getTranscript } from "../transcript/transcript-store.ts";
import type { TranscriptEntry, TranscriptManagerLike } from "../transcript/transcript-hub.ts";
import {
  buildGatePrompt,
  buildGeneratePrompt,
  buildWakePrompt,
  parseInspirationCandidates,
  parseInspirationGate,
  pickLens,
  type InspirationIdentity,
} from "./inspiration-divergence.ts";
import {
  INSPIRATION_MAX_CANDIDATES,
  type InspirationCandidate,
  type InspirationConfig,
  type InspirationFeedback,
  type InspirationRecord,
  type InspirationRunResult,
  type InspirationState,
  type InspirationTrigger,
} from "./inspiration-contracts.ts";
import {
  advanceOutOfQuietHours,
  computeNextFireAt,
  dailyRuns,
  dailySpend,
  inspirationDayKey,
  inspirationPriority,
  isDue,
  isQuietHour,
  resetUsageIfNeeded,
} from "./inspiration-scheduler.ts";
import { normalizeInspirationConfig, trimInspirationState, type InspirationStore } from "./inspiration-store.ts";

const HIDDEN_PROMPT_PREFIX = "[SLATE_HIDDEN_PROMPT]";
const MANUAL_PULL_MS = 2 * 60_000;
const RESCHEDULE_AFTER_BUSY_MS = 10 * 60_000;

export interface InspirationRuntimeDeps {
  readonly tm: TranscriptManagerLike;
  readonly store: InspirationStore;
  readonly getBinding: (agentId: string) => BotRuntimeBinding | null;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timeZone?: () => string | undefined;
  readonly tickMs?: number;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
  readonly maxFiresPerTick?: number;
}

interface ProfileContext {
  identity: InspirationIdentity;
  budgetUsdPerDay: number | null;
}

function profileForSession(session: Record<string, any>): ProfileContext {
  const profile = readSlateProfileFile(getSlateProfilePath(dirname(String(session.dbPath))));
  return {
    identity: {
      name: profile?.name ?? "Bot",
      description: profile?.description ?? "",
      title: profile?.title ?? "",
      instructions: profile?.instructions ?? "",
    },
    budgetUsdPerDay: profile?.inspirationBudgetUsd ?? null,
  };
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
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
    if (overlap / Math.min(targetBigrams.size, other.size) >= 0.7) return true;
  }
  return false;
}

function formatTranscript(entries: readonly TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries.slice(-40)) {
    if (entry.kind !== "message") continue;
    const content = typeof entry.content === "string" ? entry.content.replace(/\s+/g, " ").trim() : "";
    if (!content) continue;
    if (entry.role === "user" && content.startsWith(HIDDEN_PROMPT_PREFIX)) continue;
    const role = entry.role === "user" ? "User" : "Bot";
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
  detail?: string;
  outcome?: InspirationRecord["outcome"];
  messageCount?: number;
  costUsd?: number;
  tokens?: number;
  sourceAgentId?: string;
}): InspirationRecord {
  return {
    id: randomUUID(),
    createdAt: Date.now(),
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
  readonly #getBinding: (agentId: string) => BotRuntimeBinding | null;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #timeZone: () => string | undefined;
  readonly #tickMs: number;
  readonly #logger: Pick<Console, "info" | "warn" | "error">;
  readonly #maxFiresPerTick: number;
  readonly #firing = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #started = false;

  constructor(deps: InspirationRuntimeDeps) {
    this.#tm = deps.tm;
    this.#store = deps.store;
    this.#getBinding = deps.getBinding;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
    this.#timeZone = deps.timeZone ?? (() => undefined);
    this.#tickMs = Math.max(5_000, deps.tickMs ?? 30_000);
    this.#logger = deps.logger ?? console;
    this.#maxFiresPerTick = Math.max(1, deps.maxFiresPerTick ?? 1);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.reconcile();
    this.#timer = setInterval(() => { void this.tick(); }, this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#started = false;
  }

  /** Restore a next fire for every enabled subscription after a host restart. */
  reconcile(): void {
    const now = this.#now();
    for (const raw of this.#store.list()) {
      if (!raw.config.enabled) continue;
      const state = resetUsageIfNeeded(raw, now, this.#timeZone());
      if (state.nextFireAt !== null) {
        if (state !== raw) this.#store.write(state);
        continue;
      }
      const nextFireAt = computeNextFireAt({
        now,
        config: state.config,
        random: this.#random,
        timeZone: this.#timeZone(),
      });
      this.#store.write({ ...state, nextFireAt });
    }
  }

  state(agentId: string): InspirationState {
    const state = resetUsageIfNeeded(this.#store.read(agentId), this.#now(), this.#timeZone());
    return trimInspirationState(state);
  }

  configure(agentId: string, patch: Partial<InspirationConfig>): InspirationState {
    const current = this.state(agentId);
    const config = normalizeInspirationConfig({ ...current.config, ...patch });
    const now = this.#now();
    const nextFireAt = config.enabled
      ? current.nextFireAt !== null && current.config.enabled
        ? current.nextFireAt
        : computeNextFireAt({ now, config, random: this.#random, timeZone: this.#timeZone() })
      : null;
    const next = trimInspirationState({ ...current, config, nextFireAt });
    this.#store.write(next);
    return next;
  }

  feedback(agentId: string, recordId: string, feedback: InspirationFeedback): InspirationState {
    const current = this.state(agentId);
    const ledger = current.ledger.map((record) => record.id === recordId ? { ...record, feedback } : record);
    const feedbackCounts = {
      useful: current.feedback.useful + (feedback === "useful" ? 1 : 0),
      notUseful: current.feedback.notUseful + (feedback === "not-useful" ? 1 : 0),
      dismissed: current.feedback.dismissed + (feedback === "dismissed" ? 1 : 0),
    };
    const next = trimInspirationState({ ...current, ledger, feedback: feedbackCounts });
    this.#store.write(next);
    return next;
  }

  /** A sibling Bot asks this Bot to take a specific focus next. */
  nominate(fromAgentId: string, targetAgentId: string, task: string): { ok: boolean; reason?: string } {
    if (fromAgentId === targetAgentId) return { ok: false, reason: "cannot nominate itself" };
    const target = this.state(targetAgentId);
    if (!target.config.enabled) return { ok: false, reason: "the target Bot's inspiration subscription is off" };
    const now = this.#now();
    const nomination = {
      id: randomUUID(),
      fromAgentId,
      task: task.trim().slice(0, 2000),
      createdAt: now,
    };
    if (!nomination.task) return { ok: false, reason: "the nomination is empty" };
    const nextFireAt = Math.min(target.nextFireAt ?? Number.POSITIVE_INFINITY, now + MANUAL_PULL_MS);
    const next = trimInspirationState({
      ...target,
      nominations: [...target.nominations, nomination].slice(-20),
      nextFireAt: Number.isFinite(nextFireAt) ? nextFireAt : now + MANUAL_PULL_MS,
    });
    this.#store.write(next);
    return { ok: true };
  }

  async runNow(agentId: string): Promise<InspirationRunResult> {
    return await this.fire(agentId, "manual", { force: true });
  }

  /** One global tick: rank due subscriptions and fire at most the configured cap. */
  async tick(): Promise<void> {
    const now = this.#now();
    const due: Array<{ state: InspirationState; score: number; profile: ProfileContext }> = [];
    for (const raw of this.#store.list()) {
      const state = resetUsageIfNeeded(raw, now, this.#timeZone());
      if (state !== raw) this.#store.write(state);
      if (!isDue(state, now) || this.#firing.has(state.agentId)) continue;
      const session = await this.#resolveSession(state.agentId).catch(() => null);
      if (session === null) continue;
      const profile = profileForSession(session);
      due.push({ state, profile, score: this.#score(state, profile, now) });
    }
    due.sort((a, b) => b.score - a.score);
    let fired = 0;
    for (const entry of due) {
      if (fired >= this.#maxFiresPerTick) {
        // A lower-ranked Bot waits instead of all Bots speaking at once.
        this.#store.write({ ...entry.state, nextFireAt: now + RESCHEDULE_AFTER_BUSY_MS + Math.round(this.#random() * RESCHEDULE_AFTER_BUSY_MS) });
        continue;
      }
      fired += 1;
      await this.fire(entry.state.agentId, "stochastic").catch((error) => {
        this.#logger.warn(`[inspiration] tick fire failed for ${entry.state.agentId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  #score(state: InspirationState, profile: ProfileContext, now: number): number {
    return inspirationPriority({
      state,
      instructions: profile.identity.instructions,
      description: profile.identity.description,
      budgetUsdPerDay: profile.budgetUsdPerDay,
      now,
      timeZone: this.#timeZone(),
      random: this.#random,
    });
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
    options: { force?: boolean } = {},
  ): Promise<InspirationRunResult> {
    if (this.#firing.has(agentId)) return { decision: "skipped", detail: "already firing" };
    this.#firing.add(agentId);
    const now = this.#now();
    const timeZone = this.#timeZone();
    let state = resetUsageIfNeeded(this.#store.read(agentId), now, timeZone);
    const finish = (record: InspirationRecord, nextState: InspirationState): InspirationRunResult => {
      const withRecord = trimInspirationState({ ...nextState, ledger: [...nextState.ledger, record].slice(-100) });
      this.#store.write(withRecord);
      return { decision: record.decision, ...(record.detail === undefined ? {} : { detail: record.detail }), ...(record.outcome === undefined ? {} : { outcome: record.outcome }), recordId: record.id };
    };
    const reschedule = (): number | null => computeNextFireAt({
      now: this.#now(),
      config: state.config,
      random: this.#random,
      timeZone,
    });

    try {
      if (!state.config.enabled && trigger !== "manual") {
        return finish(recordFor({ trigger, lens: "random", candidate: null, decision: "skipped", detail: "subscription disabled" }), state);
      }
      const session = await this.#resolveSession(agentId);
      if (session === null) {
        state = { ...state, nextFireAt: now + RESCHEDULE_AFTER_BUSY_MS };
        return finish(recordFor({ trigger, lens: "random", candidate: null, decision: "unavailable", detail: "the Bot has no background session" }), state);
      }
      const profile = profileForSession(session);
      const budget = profile.budgetUsdPerDay ?? state.config.budgetUsdPerDay;
      if (budget !== null && dailySpend(state, now, timeZone) >= budget) {
        state = { ...state, nextFireAt: nextDayStart(now, timeZone) + 5 * 60_000 };
        return finish(recordFor({ trigger, lens: "random", candidate: null, decision: "budget", detail: "daily inspiration budget reached" }), state);
      }
      if (trigger !== "manual" && dailyRuns(state, now, timeZone) >= state.config.cadence.dailyCap) {
        state = { ...state, nextFireAt: nextDayStart(now, timeZone) + 5 * 60_000 };
        return finish(recordFor({ trigger, lens: "random", candidate: null, decision: "cap", detail: "daily inspiration cap reached" }), state);
      }
      if (!options.force && trigger !== "manual" && isQuietHour(now, state.config.quietHours, timeZone)) {
        state = { ...state, nextFireAt: advanceOutOfQuietHours(now, state.config.quietHours, timeZone) + state.config.cadence.minIntervalMs };
        return finish(recordFor({ trigger, lens: "random", candidate: null, decision: "quiet", detail: "quiet hours" }), state);
      }
      const binding = this.#getBinding(agentId);
      if (binding === null) {
        state = { ...state, nextFireAt: now + RESCHEDULE_AFTER_BUSY_MS };
        return finish(recordFor({ trigger, lens: "random", candidate: null, decision: "unavailable", detail: "the Bot runtime is not provisioned" }), state);
      }
      const client = new PiWorkerClient(binding);
      const workspace = await client.inspirationContext();
      const transcript = this.#transcriptFor(session);
      const recent = state.ledger.filter((record) => record.candidate !== null).slice(-20);
      const nomination = state.nominations[0];
      const lens = pickLens(state.config.lenses, this.#random);
      const generate = buildGeneratePrompt({
        identity: profile.identity,
        transcript,
        workspace,
        recentIdeas: recent,
        topics: state.config.topics,
        lens,
        ...(nomination === undefined ? {} : { nomination }),
      });
      const generated = await client.inspirationComplete({
        systemPrompt: generate.systemPrompt,
        prompt: generate.prompt,
        maxTokens: 1_400,
        temperature: 1.0,
      });
      if (generated === null) {
        state = { ...state, nextFireAt: now + RESCHEDULE_AFTER_BUSY_MS };
        return finish(recordFor({ trigger, lens, candidate: null, decision: "error", detail: "the model completion failed" }), state);
      }
      const generationCost = generated.costUsd;
      const generationTokens = generated.usage?.totalTokens ?? 0;
      state = { ...state, usage: addUsage(state, now, timeZone, generationCost, generationTokens, 1) };
      const candidates = parseInspirationCandidates(generated.text, lens).slice(0, INSPIRATION_MAX_CANDIDATES);
      if (candidates.length === 0) {
        state = { ...state, nextFireAt: reschedule() };
        return finish(recordFor({ trigger, lens, candidate: null, decision: "skipped", detail: "the model returned no candidates", costUsd: generationCost, tokens: generationTokens }), state);
      }
      const fresh = candidates.filter((candidate) => !isDuplicateTitle(candidate.title, recent));
      if (fresh.length === 0) {
        state = { ...state, nextFireAt: reschedule() };
        return finish(recordFor({ trigger, lens, candidate: null, decision: "duplicate", detail: "all candidates repeated recent inspirations", costUsd: generationCost, tokens: generationTokens }), state);
      }
      let selected: InspirationCandidate | null = fresh[0] ?? null;
      let gateReason = "";
      if (fresh.length > 1) {
        const gate = buildGatePrompt({
          identity: profile.identity,
          transcript,
          workspace,
          recentIdeas: recent,
          topics: state.config.topics,
          lens,
        }, fresh);
        const gated = await client.inspirationComplete({
          systemPrompt: gate.systemPrompt,
          prompt: gate.prompt,
          maxTokens: 256,
          temperature: 0.2,
        });
        if (gated !== null) {
          const gateCost = gated.costUsd;
          const gateTokens = gated.usage?.totalTokens ?? 0;
          state = { ...state, usage: addUsage(state, now, timeZone, gateCost, gateTokens, 0) };
          const parsedGate = parseInspirationGate(gated.text, fresh.length);
          gateReason = parsedGate.reason;
          selected = parsedGate.selection === null ? null : fresh[parsedGate.selection] ?? null;
          if (selected === null) {
            state = { ...state, nextFireAt: reschedule() };
            return finish(recordFor({
              trigger,
              lens,
              candidate: null,
              decision: "skipped",
              detail: gateReason || "the gate rejected every candidate",
              costUsd: generationCost + gateCost,
              tokens: generationTokens + gateTokens,
            }), state);
          }
        }
      }
      if (selected === null) {
        state = { ...state, nextFireAt: reschedule() };
        return finish(recordFor({ trigger, lens, candidate: null, decision: "skipped", detail: "no candidate selected", costUsd: generationCost, tokens: generationTokens }), state);
      }
      const wakePrompt = buildWakePrompt({
        identity: profile.identity,
        candidate: selected,
        transcript,
        workspace,
        ...(nomination === undefined ? {} : { nomination }),
      });
      const wake = await this.#runWake(agentId, wakePrompt);
      const outcome: InspirationRecord["outcome"] = wake.messageCount > 0 ? "acted" : "silent";
      state = {
        ...state,
        lastFiredAt: now,
        nextFireAt: reschedule(),
        nominations: nomination === undefined ? state.nominations : state.nominations.slice(1),
      };
      return finish(recordFor({
        trigger,
        lens: selected.lens,
        candidate: selected,
        decision: "woke",
        outcome,
        messageCount: wake.messageCount,
        costUsd: generationCost,
        tokens: generationTokens,
        ...(nomination === undefined ? {} : { sourceAgentId: nomination.fromAgentId }),
        ...(gateReason ? { detail: gateReason } : {}),
      }), state);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600);
      this.#logger.warn(`[inspiration] fire failed for ${agentId}: ${detail}`);
      state = { ...state, nextFireAt: now + RESCHEDULE_AFTER_BUSY_MS };
      return finish(recordFor({ trigger, lens: "random", candidate: null, decision: "error", detail }), state);
    } finally {
      this.#firing.delete(agentId);
    }
  }

  #transcriptFor(session: Record<string, any>): string {
    const active = this.#tm.sessions.activeSession?.id === session.id;
    const entries: TranscriptEntry[] = active
      ? getTranscript()
      : Array.isArray(session.db?.getTranscriptEntries?.()) ? session.db.getTranscriptEntries() : [];
    return formatTranscript(entries);
  }

  async #runWake(agentId: string, prompt: string): Promise<{ messageCount: number }> {
    const session = await this.#tm.sessions.resolveBackgroundSession(agentId);
    const runner = this.#tm.runnerRegistry.getRunner(session);
    this.#tm.runLifecycle.beginSessionRun(session);
    let messageCount = 0;
    try {
      await this.#tm.runLifecycle.enqueueExclusiveRun(session.id, async () => {
        this.#tm.turnRuntime.activeRequestSources.set(session.id, "inspiration");
        const result = await runner.run(prompt, {
          hidden: true,
          isSilenceAllowed: true,
          suppressFinalMessage: true,
          requestSource: "inspiration",
        });
        messageCount = typeof result?.sentMessageCount === "number" ? result.sentMessageCount : 0;
      }, { lane: "background", source: "inspiration" });
      await this.#tm.roster.emitAgentUpdate(session.id);
      return { messageCount };
    } finally {
      this.#tm.runLifecycle.endSessionRun(session);
    }
  }
}

function nextDayStart(now: number, timeZone: string | undefined): number {
  const dayKey = inspirationDayKey(now, timeZone);
  let candidate = now + 60 * 60_000;
  for (let index = 0; index < 48; index += 1) {
    if (inspirationDayKey(candidate, timeZone) !== dayKey) return candidate;
    candidate += 60 * 60_000;
  }
  return now + 24 * 60 * 60_000;
}

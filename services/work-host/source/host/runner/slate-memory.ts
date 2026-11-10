/**
 * The memory an agent carries between conversations.
 *
 * What is remembered is bounded twice — a character budget for what a prompt carries and a count for what the panel
 * shows — so an agent with a long memory is not given an unusable prompt.
 */
export const MEMORY_RECENT_PROMPT_LIMIT = 30;
export const MEMORY_RECENT_PROMPT_CHAR_BUDGET = 4_000;
export const MEMORY_PROFILE_PROMPT_LIMIT = 100;
export const MEMORY_UI_LIMIT = 1_000;
export const MEMORY_MAX_CONTENT_LENGTH = 500;
export const MEMORY_EXTRACTION_PROMPT_MARKER = "<<SLATE_MEMORY_EXTRACTION>>";
export const MEMORY_EPISODE_PROMPT_MARKER = "<<SLATE_MEMORY_EPISODE>>";
export const MEMORY_EPISODE_PREFIX = "[episode] ";
export const MEMORY_NOTE_PREFIX = "[note] ";
export const MEMORY_EXTRACTION_NONE_SENTINEL = "NONE";
export const MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT = 500;
export const DEFAULT_EPISODE_INTERVAL = 6;
export const MEMORY_USER_PROFILE_PROMPT_LIMIT = 50;
export const MEMORY_USER_RECENT_PROMPT_LIMIT = 15;
export const MEMORY_PROJECT_PROFILE_PROMPT_LIMIT = 25;
export const MEMORY_PROJECT_RECENT_PROMPT_LIMIT = 10;
export const MEMORY_PROJECT_INJECTED_CAP = 3;
export const MEMORY_DECAY_HALF_LIFE_DAYS = 30;
export const DAY_MS = 86_400_000;

/** One remembered fact: its text, when it was learned, which tier it belongs to and which assistant recorded it. */
export interface MemoryRecord {
  readonly content: string;
  readonly createdAt: number;
  readonly id?: string;
  readonly kind?: "profile" | "log";
}

/** What an agent recalls at the start of a turn, in the two tiers its own prompt renders. */
export interface MemoryRecall {
  readonly profile: readonly MemoryRecord[];
  readonly recent: readonly MemoryRecord[];
}

/** The two changes a review of an exchange can ask for: facts to add, and facts that no longer hold. */
export interface MemoryExtraction {
  readonly additions: readonly { readonly content: string; readonly kind: "profile" | "log" }[];
  readonly removals: readonly string[];
}

/** The rendered memory a prompt used at its last compaction, kept so it can be reused until the next one. */
export interface FrozenMemorySnapshot {
  readonly render: string;
  readonly compactionEpoch: number;
}

/** The environment switches this module knows, named once. */
const FROZEN_MEMORY_DISABLE_ENV = "SLATE_DISABLE_MEMORY_FREEZE";

/** Whether the memory prompt may freeze between compactions; an explicit opt-out disables it. */
export function isMemoryFreezeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FROZEN_MEMORY_DISABLE_ENV] !== "1";
}

export function resolveFrozenMemoryPrompt(args: {
  readonly snapshot?: FrozenMemorySnapshot;
  readonly compactionEpoch: number;
  readonly renderLive: () => { readonly render: string; readonly hasFacts: boolean };
}): { readonly render: string; readonly snapshotToPersist?: FrozenMemorySnapshot } {
  const snapshot = args.snapshot;
  if (snapshot != null && snapshot.compactionEpoch === args.compactionEpoch) return { render: snapshot.render };
  const live = args.renderLive();
  if (!live.hasFacts) return { render: live.render };
  return { render: live.render, snapshotToPersist: { render: live.render, compactionEpoch: args.compactionEpoch } };
}

/***/ const EPISODE_INTERVAL_ENV = "SLATE_MEMORY_EPISODE_INTERVAL";

/** How many turns an episode covers when the deployment says; a value that is not a positive number is ignored. */
export function getEpisodeInterval(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env[EPISODE_INTERVAL_ENV];
  if (configured == null) return DEFAULT_EPISODE_INTERVAL;
  const interval = Number.parseInt(configured.trim(), 10);
  return Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_EPISODE_INTERVAL;
}

const TRIVIAL_EXCHANGES = new Set(["hi", "hey", "hello", "yo", "sup", "thanks", "thank you", "ty", "thx", "ok", "okay", "k", "kk", "cool", "nice", "great", "awesome", "perfect", "yes", "yep", "yeah", "no", "nope", "sure", "got it", "gotcha", "lol", "haha", "np", "done", "good", "bye"]);

/** A message longer than this, or one that asks something, is memorable whatever it says. */
const ALWAYS_MEMORABLE_LENGTH = 40;

export function isMemorableExchange(userMessage: string): boolean {
  const user = userMessage.trim();
  if (user.length === 0) return false;
  return user.length > ALWAYS_MEMORABLE_LENGTH || user.includes("?") || isTrivialSpelling(user);
}

/** A greeting or acknowledgement, in any spelling of it, is not worth remembering. Answers the untrivial ones. */
function isTrivialSpelling(user: string): boolean {
  return !TRIVIAL_EXCHANGES.has(user.toLowerCase().replace(/[\s!.…,~)\]]+$/g, "").replace(/\s+/g, " ").trim());
}

const WHITESPACE_RUN = /\s+/g;

/** A fact as the platform stores it: one line, trimmed, and no longer than the content limit. */
export function normalizeMemoryContent(raw: string): string {
  return raw.replace(WHITESPACE_RUN, " ").trim().slice(0, MEMORY_MAX_CONTENT_LENGTH);
}

/** What makes two facts the same fact: their normalized text, case-insensitively. */
export function memoryDedupeKey(content: string): string { return normalizeMemoryContent(content).toLowerCase(); }

const EPISODE_IMPORTANCE = 1.5;
const NOTE_IMPORTANCE = 0.5;
const ORDINARY_IMPORTANCE = 1;

/** How much a fact counts when memories compete: episodes first, notes last, ordinary facts between them. */
export function memoryImportance(contentOrRecord: string | MemoryRecord): number {
  const content = typeof contentOrRecord === "string" ? contentOrRecord : contentOrRecord.content;
  if (content.startsWith(MEMORY_EPISODE_PREFIX)) return EPISODE_IMPORTANCE;
  if (content.startsWith(MEMORY_NOTE_PREFIX)) return NOTE_IMPORTANCE;
  return ORDINARY_IMPORTANCE;
}

/** The window over which a fact's age halves its pull. */
const DECAY_WINDOW_MS = MEMORY_DECAY_HALF_LIFE_DAYS * DAY_MS;

/** A fact's recall rank: its importance, and its age measured in decay windows from the epoch. */
export function memoryRecallRank(memory: MemoryRecord): number {
  return Math.log2(memoryImportance(memory.content)) + memory.createdAt / DECAY_WINDOW_MS;
}

const UNKNOWN_DATE = "unknown date";

/** The day a fact was learned, or a phrase when the timestamp cannot name one. */
export function formatMemoryDate(createdAtMs: number): string {
  return Number.isFinite(createdAtMs) && createdAtMs > 0 ? new Date(createdAtMs).toISOString().slice(0, 10) : UNKNOWN_DATE;
}

/** One fact as a prompt line, with the day it was learned. */
export function factLine(memory: MemoryRecord): string { return `- (learned ${formatMemoryDate(memory.createdAt)}) ${memory.content}`; }

/** Read a recall either as the two tiers or as one flat list, each fact kept in the tier its kind names. */
function toRecall(value: MemoryRecall | readonly MemoryRecord[]): MemoryRecall {
  if (!Array.isArray(value)) return value as MemoryRecall;
  const profile: MemoryRecord[] = [];
  const recent: MemoryRecord[] = [];
  for (const record of value) (record.kind === "profile" ? profile : recent).push(record);
  return { profile, recent };
}

/** Append whole prompt lines until the budget would run out; the first line is always kept. Answers how many were shown. */
function appendBudgetedLines(target: string[], renderedLines: readonly string[], charBudget: number): number {
  let remaining = charBudget;
  let shown = 0;
  for (const line of renderedLines) {
    if (shown > 0 && line.length > remaining) break;
    target.push(line);
    remaining -= line.length;
    shown += 1;
  }
  return shown;
}

const MEMORY_PROMPT_INTRODUCTION = [
  "Memory: durable facts you have learned about the user and their world.",
  "These persist across every conversation with this agent, even after the chat is cleared. Rely on them so you stay consistent and avoid re-asking what you already know.",
];
const ABOUT_THE_USER_HEADING = "About the user:";
const RECENTLY_HEADING = "Recently:";
const NO_FACTS_RECORDED = "No facts recorded yet.";

/** Where the agent's own memory lives, and how to change it, when the caller knows the folder. */
function memoryFolderParagraph(location: string): string[] {
  return [
    `Your memory lives in a folder at ${location}: profile.md holds who the user is (kept in mind every turn) and log/ holds dated history.`,
    'Read or grep those files with Read and Shell on your own computer when you need older facts that are not listed here. To CHANGE memory, prefer the update_state tool (target "memory"): action "write" with a fact and a tier (profile | log | note), or action "forget" with the exact text of a recorded fact.',
  ];
}

/** The memory prompt for an agent's own tiers; an empty memory with no folder renders nothing at all. */
export function renderMemorySystemPrompt(value: MemoryRecall | readonly MemoryRecord[], location?: string): string {
  const recall = toRecall(value);
  const profileFacts = recall.profile;
  const recentFacts = recall.recent;
  if (!profileFacts.length && !recentFacts.length && location == null) return "";
  const lines = [...MEMORY_PROMPT_INTRODUCTION];
  if (location != null) lines.push(...memoryFolderParagraph(location));
  if (profileFacts.length > 0) lines.push(ABOUT_THE_USER_HEADING, ...profileFacts.map(factLine));
  if (recentFacts.length > 0) {
    lines.push(RECENTLY_HEADING);
    const shown = appendBudgetedLines(lines, recentFacts.map(factLine), MEMORY_RECENT_PROMPT_CHAR_BUDGET);
    const omitted = recentFacts.length - shown;
    if (omitted > 0) lines.push(location == null ? `(${omitted} more log facts not shown.)` : `(${omitted} more log facts on disk \u2014 grep the log/ folder for them.)`);
  }
  if (!profileFacts.length && !recentFacts.length) lines.push(NO_FACTS_RECORDED);
  return lines.join("\n");
}

export function buildExtractionSystemPrompt(): string {
  return [
    MEMORY_EXTRACTION_PROMPT_MARKER,
    "You maintain the long-term memory of a personal assistant. Read the latest exchange and decide what \u2014 if anything \u2014 is worth remembering for future, unrelated conversations.",
    "",
    "Tag each fact you keep with a category:",
    '- "profile": enduring facts about who the user is and how to work with them \u2014 their name and how to address them, role, location, languages, lasting preferences and constraints, and important people or relationships. These are remembered indefinitely.',
    '- "log": substantive history worth keeping \u2014 ongoing projects and tasks, decisions, commitments, and time-bound details.',
    '- "note": minor, low-stakes details that might help someday but are not worth keeping in mind every turn (small one-off preferences, incidental context). Notes fade from the always-visible list fastest but stay on disk.',
    "",
    "Do NOT record one-off request mechanics, what the assistant did this turn, general knowledge, or anything already present in the existing memory list.",
    "",
    'If the new exchange updates or contradicts a fact in the existing memory list (e.g. the user moved, changed jobs, or renamed something), drop anything clearly superseded: output a line "remove: <the exact existing fact text>" and then add the corrected fact. Only remove facts that appear verbatim in the existing list \u2014 never invent removals.',
    "",
    `Write each fact as a self-contained statement, one per line: "profile: <fact>", "log: <fact>", or "note: <fact>" to add (e.g. "profile: The user's name is Ian", "log: Planning a trip to Tokyo in October 2025"), or "remove: <existing fact>" to drop a superseded one.`,
    `Output exactly ${MEMORY_EXTRACTION_NONE_SENTINEL} (and nothing else) when there is nothing to add or remove.`,
  ].join("\n");
}

export function buildExtractionUserPrompt(userMessage: string, agentMessage = "", existingMemories: readonly string[] = []): string {
  return ["Existing memory:", existingMemories.length > 0 ? existingMemories.map((memory) => `- ${memory}`).join("\n") : "(empty)", "", "Latest exchange:", `User: ${userMessage.trim() || "(no message)"}`, `Assistant: ${agentMessage.trim() || "(no message)"}`].join("\n");
}

const CATEGORY_LINE = /^(profile|log|note|remove)\s*:\s*(.+)$/i;

/** One line of a model's extraction answer, read as a category tag and the fact body under it. */
function parseExtractionLine(rawLine: string): { tag: string | undefined; body: string } {
  const stripped = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
  const category = CATEGORY_LINE.exec(stripped);
  return { tag: category?.[1]?.toLowerCase(), body: normalizeMemoryContent(category?.[2] ?? stripped) };
}

/** Read a model's extraction answer into the facts it asks to add and the facts it asks to drop. */
export function parseExtractedMemories(raw: string, existingMemories: readonly string[] = []): MemoryExtraction {
  const text = raw.trim();
  if (text.length === 0 || text.toUpperCase() === MEMORY_EXTRACTION_NONE_SENTINEL) return { additions: [], removals: [] };
  const seenKeys = new Set(existingMemories.map(memoryDedupeKey));
  const additions: Array<{ content: string; kind: "profile" | "log" }> = [];
  const removals: string[] = [];
  for (const rawLine of text.split("\n")) {
    const { tag, body } = parseExtractionLine(rawLine);
    if (body.length === 0 || body.toUpperCase() === MEMORY_EXTRACTION_NONE_SENTINEL) continue;
    if (tag === "remove") { removals.push(body); continue; }
    const content = tag === "note" ? normalizeMemoryContent(`${MEMORY_NOTE_PREFIX}${body}`) : body;
    const key = memoryDedupeKey(content);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    additions.push({ content, kind: tag === "profile" ? "profile" : "log" });
  }
  return { additions, removals };
}

const RELEVANCE_TOKEN = /[\p{L}\p{N}]{4,}/gu;
const RELEVANCE_STOPWORDS = new Set(["that", "this", "with", "from", "they", "them", "then", "than", "what", "when", "where", "which", "will", "would", "could", "should", "have", "been", "being", "about", "just", "like", "your", "does", "were", "also", "into", "over", "only", "some", "more", "most", "very", "much", "here", "there", "their", "these", "those", "because", "while", "after", "before", "user"]);
/** The words worth matching on: four letters or more, lowercased, with the stopwords dropped. */
function relevanceTokens(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.toLowerCase().matchAll(RELEVANCE_TOKEN)) if (!RELEVANCE_STOPWORDS.has(match[0])) result.add(match[0]);
  return result;
}

/** The query and the memories, from the two argument orders the callers use. */
function readingOrder(first: string | readonly MemoryRecord[], second: string | readonly MemoryRecord[]): { query: string; memories: readonly MemoryRecord[] } {
  return typeof first === "string" ? { query: first, memories: second as readonly MemoryRecord[] } : { query: second as string, memories: first };
}

export function selectRelevantMemories(query: string, memories: readonly MemoryRecord[], max: number): MemoryRecord[];
export function selectRelevantMemories(memories: readonly MemoryRecord[], query: string, max: number): MemoryRecord[];
/** The memories that share words with the query, most shared first, newest first among equals, cut to the limit. */
export function selectRelevantMemories(first: string | readonly MemoryRecord[], second: string | readonly MemoryRecord[], max: number): MemoryRecord[] {
  const { query, memories } = readingOrder(first, second);
  if (max <= 0 || memories.length === 0) return [];
  const wanted = relevanceTokens(query);
  if (wanted.size === 0) return [];
  return memories
    .map(memory => ({ memory, matched: [...relevanceTokens(memory.content)].filter(token => wanted.has(token)).length }))
    .filter(candidate => candidate.matched > 0)
    .sort((left, right) => right.matched - left.matched || right.memory.createdAt - left.memory.createdAt)
    .slice(0, max)
    .map(candidate => candidate.memory);
}

const EXTRACTION_ARCHIVE_MATCH_LIMIT = 10;

/** What the extraction prompt is shown: the current recall first, then the most relevant archived facts. */
export function gatherExtractionMemories(recall: MemoryRecall, archive: readonly MemoryRecord[], exchangeText: string): string[] {
  const shown = [...recall.profile, ...recall.recent];
  const shownKeys = new Set(shown.map(memory => memoryDedupeKey(memory.content)));
  const candidates = archive.filter(memory => !shownKeys.has(memoryDedupeKey(memory.content)));
  return [...shown, ...selectRelevantMemories(exchangeText, candidates, EXTRACTION_ARCHIVE_MATCH_LIMIT)].map(memory => memory.content);
}

/** The executor an extraction or an episode runs its prompt through. */
export interface TextExecutor {
  appendMessages(messages: readonly { readonly role: "system" | "user"; readonly content: string }[]): void;
  clearMessages(): void;
  getMessages(): readonly unknown[];
  getState(): unknown;
  stream(ctx: unknown, first?: unknown, second?: unknown, options?: object): { readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string; readonly error?: unknown }> };
}

const TEXT_DELTA_PART = "text-delta";
const ERROR_PART = "error";

/** The text an executor produced, or the failure it hit: a failed exchange is raised, never read as empty. */
export async function collectExecutorText(executor: TextExecutor, ctx: unknown): Promise<string> {
  let collected = "";
  for await (const part of executor.stream(ctx, undefined, undefined, {}).fullStream) {
    if (part.type === TEXT_DELTA_PART) { collected += part.textDelta ?? ""; continue; }
    if (part.type === ERROR_PART) throw part.error instanceof Error ? part.error : new Error(String(part.error));
  }
  return collected;
}

/** One request for memory extraction: the exchange, what is already known, and the executor to ask. */
interface ExtractionRequest {
  executor: TextExecutor;
  ctx: unknown;
  userMessage: string;
  agentMessage: string;
  existingMemories: readonly string[];
}

/** Run the extraction prompt through an executor and read the answer it wrote. */
async function extractWithExecutor(request: ExtractionRequest): Promise<MemoryExtraction> {
  const { executor, ctx, userMessage, agentMessage, existingMemories } = request;
  executor.appendMessages([
    { role: "system", content: buildExtractionSystemPrompt() },
    { role: "user", content: buildExtractionUserPrompt(userMessage, agentMessage, existingMemories) },
  ]);
  return parseExtractedMemories(await collectExecutorText(executor, ctx), existingMemories);
}

export async function extractMemories(args: ExtractionRequest): Promise<MemoryExtraction>;
export async function extractMemories(text: string, execute: (system: string, user: string) => Promise<string>): Promise<MemoryExtraction>;
export async function extractMemories(first: string | ExtractionRequest, execute?: (system: string, user: string) => Promise<string>): Promise<MemoryExtraction> {
  if (typeof first !== "string") return extractWithExecutor(first);
  return parseExtractedMemories(await execute?.(buildExtractionSystemPrompt(), buildExtractionUserPrompt(first)) ?? "NONE");
}

/** The store an applied extraction writes through, when the caller keeps memories in files rather than a list. */
export interface MemoryStore {
  addMemory(content: string, now: number, kind: "profile" | "log"): MemoryRecord | null;
  removeMemoryByContent(content: string): boolean;
}

/** Apply an extraction to a list: superseded facts go, new facts join, and a fact already present is not repeated. */
function applyToRecords(records: readonly MemoryRecord[], extraction: MemoryExtraction, now: number): MemoryRecord[] {
  const removalKeys = new Set(extraction.removals.map(memoryDedupeKey));
  const next = records.filter(record => !removalKeys.has(memoryDedupeKey(record.content)));
  const presentKeys = new Set(next.map(record => memoryDedupeKey(record.content)));
  for (const addition of extraction.additions) {
    const key = memoryDedupeKey(addition.content);
    if (presentKeys.has(key)) continue;
    presentKeys.add(key);
    next.push({ id: `memory-${now}-${next.length}`, content: addition.content, createdAt: now, kind: addition.kind });
  }
  return next;
}

/** Apply an extraction through a store, answering what it actually removed and added. */
function applyToStore(store: MemoryStore, extraction: MemoryExtraction, now: number, knownMemories: readonly string[]): { added: MemoryRecord[]; removed: string[] } {
  const knownKeys = new Set(knownMemories.map(memoryDedupeKey));
  const removed: string[] = [];
  const added: MemoryRecord[] = [];
  for (const removal of extraction.removals) if (knownKeys.has(memoryDedupeKey(removal)) && store.removeMemoryByContent(removal)) removed.push(removal);
  for (const addition of extraction.additions) {
    const record = store.addMemory(addition.content, now, addition.kind);
    if (record != null) added.push(record);
  }
  return { added, removed };
}

export function applyExtractedMemories(store: MemoryStore, extraction: MemoryExtraction, now: number, knownMemories: readonly string[]): { added: MemoryRecord[]; removed: string[] };
export function applyExtractedMemories(existing: readonly MemoryRecord[], extraction: MemoryExtraction, now?: number): MemoryRecord[];
export function applyExtractedMemories(first: MemoryStore | readonly MemoryRecord[], extraction: MemoryExtraction, now = Date.now(), knownMemories: readonly string[] = []): MemoryRecord[] | { added: MemoryRecord[]; removed: string[] } {
  return Array.isArray(first) ? applyToRecords(first, extraction, now) : applyToStore(first as MemoryStore, extraction, now, knownMemories);
}

/** One turn an episode is written from. */
export interface EpisodeTurn { readonly agent: string; readonly ts: number; readonly user: string }
export function buildEpisodeSystemPrompt(): string { return [
  MEMORY_EPISODE_PROMPT_MARKER,
  "You maintain the long-term memory of a personal desktop assistant named Slate.",
  "You are given the most recent turns of a conversation between the user and Slate, in order, each tagged with its date.",
  "Write ONE short journal-style sentence (two at most) capturing what the user and Slate were actually working on across these turns \u2014 the throughline, key decisions, and outcomes \u2014 so it stays useful months from now.",
  'Anchor any time references with the absolute dates shown, never relative words like "yesterday". Drop greetings, acknowledgements, and anything ephemeral. Never invent details.',
  `Output just the sentence(s), no preamble or bullets. Output exactly ${MEMORY_EXTRACTION_NONE_SENTINEL} if nothing in this stretch is worth remembering.`,
].join("\n"); }
/** One turn as the lines an episode prompt reads it as. */
function episodeTurnLines(turn: EpisodeTurn): string[] {
  const lines = [`(${formatMemoryDate(turn.ts)})`];
  if (turn.user.trim()) lines.push(`User: ${turn.user.trim()}`);
  if (turn.agent.trim()) lines.push(`Slate: ${turn.agent.trim()}`);
  return lines;
}

/** The turns of an episode, oldest first, each tagged with its day. */
export function buildEpisodeUserPrompt(turns: readonly EpisodeTurn[]): string {
  const renderedTurns = turns.map(turn => episodeTurnLines(turn).join("\n")).join("\n\n");
  return ["Recent turns, oldest first:", "", renderedTurns].join("\n");
}

/** One journal sentence for a stretch of turns, or null when there is nothing worth remembering in it. */
export async function summarizeEpisode(args: { executor: TextExecutor; ctx: unknown; turns: readonly EpisodeTurn[] }): Promise<string | null> {
  const { executor, ctx, turns } = args;
  if (turns.length === 0) return null;
  executor.appendMessages([{ role: "system", content: buildEpisodeSystemPrompt() }, { role: "user", content: buildEpisodeUserPrompt(turns) }]);
  const narrative = normalizeMemoryContent(await collectExecutorText(executor, ctx));
  return narrative.length === 0 || narrative.toUpperCase() === MEMORY_EXTRACTION_NONE_SENTINEL ? null : narrative;
}

export interface ProvenancedMemory extends MemoryRecord { readonly via: string }
/** The newest record for each dedupe key, ordered and cut to the limit. */
function mergeRecords(records: ProvenancedMemory[], limit: number, rank: boolean): ProvenancedMemory[] {
  const newestByKey = new Map<string, ProvenancedMemory>();
  for (const record of records) {
    const key = memoryDedupeKey(record.content);
    const current = newestByKey.get(key);
    if (current == null || record.createdAt > current.createdAt) newestByKey.set(key, record);
  }
  const ordered = [...newestByKey.values()].sort((left, right) => rank
    ? memoryRecallRank(right) - memoryRecallRank(left) || right.createdAt - left.createdAt
    : right.createdAt - left.createdAt || left.content.localeCompare(right.content));
  return ordered.slice(0, Math.max(0, Math.floor(limit)));
}

/** The user's shared memory as one recall: every assistant's shards, newest fact per text, ranked and bounded. */
export function mergeUserMemoryShards(shards: readonly { readonly via: string; readonly recall: MemoryRecall }[], limits: { readonly profileLimit: number; readonly recentLimit: number }): { profile: ProvenancedMemory[]; recent: ProvenancedMemory[] } {
  const profile: ProvenancedMemory[] = [];
  const recent: ProvenancedMemory[] = [];
  for (const shard of shards) {
    for (const record of shard.recall.profile) profile.push({ ...record, via: shard.via });
    for (const record of shard.recall.recent) recent.push({ ...record, via: shard.via });
  }
  return {
    profile: mergeRecords(profile, limits.profileLimit, false),
    recent: mergeRecords(recent, limits.recentLimit, true),
  };
}

/** One shared fact as a prompt line, saying which assistant learned it. */
function provenanceLine(record: ProvenancedMemory): string { return `- (learned ${formatMemoryDate(record.createdAt)})${record.via.trim() ? ` [via ${record.via.trim()}]` : ""} ${record.content}`; }

const USER_PROFILE_BUDGET = 4_000;
const USER_RECENT_BUDGET = 2_000;
const PROJECT_PROFILE_BUDGET = 2_500;
const PROJECT_RECENT_BUDGET = 1_500;

/** Add a tier's facts under its budget, and say how many facts were left out when some were. */
function appendBudgetedProvenancedFacts(lines: string[], records: readonly ProvenancedMemory[], charBudget: number, moreLabel: string, grepHint: string): void {
  const shown = appendBudgetedLines(lines, records.map(provenanceLine), charBudget);
  const omitted = records.length - shown;
  if (omitted > 0) {
    lines.push(`(${omitted} more shared ${moreLabel} on disk \u2014 grep ${grepHint} for them.)`);
  }
}

export function renderUserMemorySystemPrompt(recall: { readonly profile: readonly ProvenancedMemory[]; readonly recent: readonly ProvenancedMemory[] }, ctx: { readonly userMemoryDir?: string; readonly ownShardDir?: string }): string {
  if (ctx.userMemoryDir == null) return "";
  const sharedFactsExist = recall.profile.length > 0 || recall.recent.length > 0;
  const lines = [
    "User memory: durable facts shared across every assistant this user runs \u2014 their name, timezone, lasting preferences, and anything all of the user's assistants should know. This is separate from your own memory (shown below) and is visible to all of them.",
    "Precedence: when a shared user fact conflicts with your OWN memory, prefer your own \u2014 it is curated for your role and may deliberately override a shared default.",
  ];
  if (ctx.ownShardDir != null) {
    lines.push(
      `User memory lives under ${ctx.userMemoryDir}, split into one shard folder per assistant so every file has a single writer. Your own shard is at ${ctx.ownShardDir} (a profile.md and log/YYYY-MM.md you can read and grep with Read and Shell on your own computer). To CHANGE shared user memory, prefer the update_state tool (target "memory", scope "user", action "write" or "forget"). Never edit another assistant's shard.`,
      'To fix or replace a shared fact another assistant recorded, write the corrected fact into YOUR shard via update_state \u2014 the newest wins on conflict. Record a fact here only when it is clearly about the user and useful to every assistant; keep role-specific facts in your own memory (scope "agent").',
    );
  }
  if (sharedFactsExist) {
    lines.push("Shared facts are tagged [via <assistant>] so you can tell which assistant learned each one.");
  }
  if (recall.profile.length > 0) {
    lines.push("About the user (shared):");
    appendBudgetedProvenancedFacts(lines, recall.profile, USER_PROFILE_BUDGET, "profile facts", "the user-memory/ folder");
  }
  if (recall.recent.length > 0) {
    lines.push("Recently (shared):");
    appendBudgetedProvenancedFacts(lines, recall.recent, USER_RECENT_BUDGET, "log facts", "the user-memory/ folder");
  }
  if (recall.profile.length === 0 && recall.recent.length === 0) lines.push("No shared facts recorded yet.");
  return lines.join("\n");
}

/** One project's memory as the prompt sees it: what it is, where this assistant's shard is, and its facts. */
export interface ProjectMemoryBlock {
  readonly name: string;
  readonly slug: string;
  readonly ownShardDir?: string;
  readonly recall: { readonly profile: readonly ProvenancedMemory[]; readonly recent: readonly ProvenancedMemory[] };
}

/** Whether a project block carries any fact of its own. */
function hasProjectFacts(block: ProjectMemoryBlock): boolean {
  return block.recall.profile.length > 0 || block.recall.recent.length > 0;
}

/** The newest fact a project block carries, or zero when it has none. */
function projectFreshness(block: ProjectMemoryBlock): number {
  return Math.max(0, ...block.recall.profile.map(record => record.createdAt), ...block.recall.recent.map(record => record.createdAt));
}

/** Projects with facts first, then the freshest, then by slug. */
function compareProjects(left: ProjectMemoryBlock, right: ProjectMemoryBlock): number {
  return Number(hasProjectFacts(right)) - Number(hasProjectFacts(left)) || projectFreshness(right) - projectFreshness(left) || left.slug.localeCompare(right.slug);
}

/** The projects whose memory a prompt carries, and the ones the agent is only a member of. */
export function selectProjectMemoryBlocks(blocks: readonly ProjectMemoryBlock[], injectedCap = 3): { injected: ProjectMemoryBlock[]; alsoMemberOf: Array<{ slug: string; name: string }> } {
  const ordered = [...blocks].sort(compareProjects);
  const cap = Number.isFinite(injectedCap) && injectedCap > 0 ? Math.floor(injectedCap) : 0;
  return {
    injected: ordered.slice(0, cap),
    alsoMemberOf: ordered.slice(cap).map(block => ({ slug: block.slug, name: block.name })),
  };
}

/** Whether any project the prompt carries has facts. */
export function projectMemoryHasFacts(recall: { readonly injected: readonly ProjectMemoryBlock[] }): boolean {
  return recall.injected.some(hasProjectFacts);
}
export function renderProjectMemorySystemPrompt(recall: { readonly injected: readonly ProjectMemoryBlock[]; readonly alsoMemberOf: readonly { slug: string; name: string }[] }, ctx: { readonly projectsRootDir?: string }): string {
  if (ctx.projectsRootDir == null) return "";
  const lines = [
    "Project memory: durable facts shared by every assistant that has joined a project \u2014 the project's decisions, conventions, and state. Projects are optional and opt-in; joining one lets its memory into your prompt below.",
    "Precedence across memory tiers: on conflict prefer your OWN memory first, then project memory, then user memory \u2014 the most specific wins.",
    `Projects live under ${ctx.projectsRootDir}: each is a folder <slug>/ holding a project.md (frontmatter name/description) and memory/by-agent/<assistantId>/ shards (one per contributing assistant, a standard profile.md + log/). Read and grep those folders with Read and Shell on your own computer; prefer the update_state tool for every CHANGE:`,
    '  - Define a project: update_state target "project", action "create", project=<slug>, name=... (optional description). If the slug already exists this is create-is-join.',
    `  - Join or leave: update_state target "project", action "join" or "leave", project=<slug>. Only projects you have joined load below; to see who else is a member, grep the assistants' projects.json files.`,
    `  - Write project facts with update_state target "memory", scope "project", project=<slug>, action "write" or "forget" (never another assistant's shard); newest wins on conflict. Record a fact here only when it is about the project and useful to every member.`,
  ];
  for (const block of recall.injected) {
    lines.push(`Project "${block.name}" (${block.slug})${block.ownShardDir == null ? ":" : ` \u2014 your shard: ${block.ownShardDir}:`}`);
    const grepHint = "this project's memory/ folder";
    if (block.recall.profile.length > 0) {
      lines.push("About this project (shared):");
      appendBudgetedProvenancedFacts(lines, block.recall.profile, PROJECT_PROFILE_BUDGET, "profile facts", grepHint);
    }
    if (block.recall.recent.length > 0) {
      lines.push("Recently (shared):");
      appendBudgetedProvenancedFacts(lines, block.recall.recent, PROJECT_RECENT_BUDGET, "log facts", grepHint);
    }
    if (!hasProjectFacts(block)) lines.push("No shared facts recorded yet for this project.");
  }
  if (recall.alsoMemberOf.length > 0) lines.push(`Also a member of: ${recall.alsoMemberOf.map((p) => `${p.name} (${p.slug})`).join(", ")} \u2014 grep those project folders for their memory.`);
  return lines.join("\n");
}

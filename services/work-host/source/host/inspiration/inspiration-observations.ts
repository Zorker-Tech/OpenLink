import type { InspirationRecord, InspirationLens } from './inspiration-contracts.ts';

const DAY = 24 * 60 * 60_000;
export const MAX_OBSERVATIONS = 32;
export const OBSERVATION_MAX_AGE_MS = DAY;
export const OBSERVATION_CATEGORIES = ['source', 'test', 'docs', 'config', 'data', 'asset', 'network', 'other'] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];
type FileCategory = Exclude<ObservationCategory, 'network'>;

export interface InspirationObservation {
  sequence: number;
  observedAt: number;
  files: Array<{ path: string; category: FileCategory }>;
  traffic?: { receivedBytes: number; sentBytes: number; direction: 'ingress' | 'egress' | 'bidirectional' };
}

export interface InspirationPreferences {
  weights: Partial<Record<ObservationCategory, number>>;
  samples: number;
}

export interface ObservationBatch {
  cursor: string;
  observations: InspirationObservation[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function counter(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : 0;
}

export function classifyWorkspaceFile(path: string): FileCategory {
  const filename = path.toLowerCase().split('/').at(-1) ?? '';
  if (/(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/i.test(path) || /(?:^test_|[._-](?:test|spec)\.)/.test(filename)) return 'test';
  if (/^(readme|changelog|contributing|license)(?:\.|$)|\.(?:md|mdx|rst|txt)$/.test(filename)) return 'docs';
  if (/^(dockerfile|makefile|package\.json|go\.mod|cargo\.toml|composer\.json)|(?:config\b)|\.(?:toml|ya?ml|ini|lock|cfg)$/.test(filename)) return 'config';
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cpp|cs|h|sh|sql|css|html|vue|svelte|php)$/.test(filename)) return 'source';
  if (/\.(?:json|jsonl|csv|tsv|parquet|xlsx|xml)$/.test(filename)) return 'data';
  if (/\.(?:svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|mp[34]|mov|pdf)$/.test(filename)) return 'asset';
  return 'other';
}

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300 && !/[\\\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(part => part && !part.startsWith('.'))
    && !/\.(?:pem|key|p12|log)(?:\.\d+)?$/i.test(value);
}

export function parseObservation(value: unknown): InspirationObservation | null {
  const entry = recordOf(value);
  const sequence = counter(entry?.sequence);
  const observedAt = counter(entry?.observedAt);
  if (!sequence || !observedAt) return null;
  const names = Array.isArray(entry?.files) ? entry.files.slice(0, 24).map((file) => recordOf(file)?.path ?? file).filter(safePath) : [];
  const files = [...new Set(names)].map((path) => ({ path, category: classifyWorkspaceFile(path) }));
  const traffic = recordOf(entry?.traffic);
  const receivedBytes = counter(traffic?.receivedBytes, 1_000_000_000);
  const sentBytes = counter(traffic?.sentBytes, 1_000_000_000);
  if (!files.length && !receivedBytes && !sentBytes) return null;
  return {
    sequence, observedAt, files,
    ...(receivedBytes || sentBytes ? { traffic: {
      receivedBytes, sentBytes, direction: receivedBytes > 8 * sentBytes ? 'ingress' : sentBytes > 8 * receivedBytes ? 'egress' : 'bidirectional',
    } } : {}),
  };
}

export function observationCursor(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9-]{36}:\d{1,16}$/i.test(value) ? value : null;
}

export function parseObservationBatch(value: unknown): ObservationBatch | null {
  const batch = recordOf(value);
  const cursor = observationCursor(batch?.cursor);
  if (!cursor || !Array.isArray(batch?.observations)) return null;
  const sequence = Number(cursor.split(':')[1]);
  const observations = batch.observations.slice(-64).map(parseObservation)
    .filter((entry): entry is InspirationObservation => entry !== null && entry.sequence <= sequence);
  return { cursor, observations: [...new Map(observations.map((entry) => [entry.sequence, entry])).values()] };
}

const INTERESTS: Record<ObservationCategory, RegExp> = {
  source: /代码|源码|重构|实现|\b(?:code|source|refactor|implementation)\b/i,
  test: /测试|回归|验证|\b(?:test\w*|coverage|regression)\b/i,
  docs: /文档|说明|指南|\b(?:docs?|documentation|readme|guide)\b/i,
  config: /配置|部署|构建|\b(?:config\w*|deploy\w*|build|ci)\b/i,
  data: /数据|迁移|报表|\b(?:data|schema|dataset|migration|csv)\b/i,
  asset: /界面|视觉|图片|图标|\b(?:ui|ux|image|asset|design)\b/i,
  network: /网络|流量|延迟|\b(?:network|traffic|ingress|egress|latency)\b/i,
  other: /工作区|文件|\b(?:workspace|file)\b/i,
};

export const CATEGORY_CODES: Record<ObservationCategory, string> = {
  source: 'A', test: 'B', docs: 'C', config: 'D', data: 'E', asset: 'F', network: 'G', other: 'H',
};

export function classifyDialogueMessage(content: string): ReadonlyMap<ObservationCategory, -1 | 1> {
  const matched = new Map<ObservationCategory, -1 | 1>();
  for (const sentence of content.slice(0, 1200).split(/[。！？!?\n]/u)) {
    const negative = /不要|别再|不用关注|忽略|不需要|\b(?:ignore|don't|do not|no need)\b/i.test(sentence);
    for (const category of OBSERVATION_CATEGORIES) if (INTERESTS[category].test(sentence)) matched.set(category, negative ? -1 : 1);
    for (const path of sentence.match(/(?:[\w-]+\/)*[\w.-]+\.[a-z][a-z0-9]{0,6}\b/gi) ?? []) {
      const category = classifyWorkspaceFile(path);
      if (category !== 'other') matched.set(category, negative ? -1 : 1);
    }
  }
  return matched;
}

const LENS_CATEGORY: Partial<Record<InspirationLens, ObservationCategory>> = {
  conversation: 'other', workspace: 'source', tests: 'test', docs: 'docs', reliability: 'config', performance: 'network', ux: 'asset',
};

/** Learn work preferences from user-authored messages and explicit feedback. */
export function deriveInspirationPreferences(
  entries: readonly { kind: string; role?: unknown; content?: unknown; timestampMs?: number }[],
  ledger: readonly InspirationRecord[],
  now: number,
): InspirationPreferences {
  const scores: Partial<Record<ObservationCategory, number>> = {};
  let samples = 0;
  for (const entry of entries.slice(-120)) {
    if (entry.kind !== 'message' || entry.role !== 'user' || typeof entry.content !== 'string' || entry.content.startsWith('[SLATE_HIDDEN_PROMPT]')) continue;
    const age = Math.max(0, now - (entry.timestampMs ?? now));
    if (age > 45 * DAY) continue;
    const strength = Math.pow(0.5, age / (14 * DAY));
    const matched = classifyDialogueMessage(entry.content);
    if (matched.size) samples++;
    for (const [category, delta] of matched) scores[category] = (scores[category] ?? 0) + delta * strength;
  }
  for (const record of ledger.slice(-30)) {
    if (!record.feedback || now - record.createdAt > 45 * DAY) continue;
    const category = LENS_CATEGORY[record.candidate?.lens ?? record.lens];
    if (!category) continue;
    const strength = Math.pow(0.5, Math.max(0, now - record.createdAt) / (14 * DAY));
    scores[category] = (scores[category] ?? 0) + (record.feedback === 'useful' ? 2 : -2) * strength;
  }
  return {
    samples,
    weights: Object.fromEntries(Object.entries(scores).map(([category, score]) => [category, Math.round((1 + 0.65 * Math.tanh(score / 3)) * 100) / 100])),
  };
}

export function normalizePreferences(value: unknown): InspirationPreferences {
  const record = recordOf(value);
  const weights = recordOf(record?.weights);
  return {
    samples: counter(record?.samples, 120),
    weights: Object.fromEntries(OBSERVATION_CATEGORIES.flatMap((category) => {
      const weight = weights?.[category];
      return typeof weight === 'number' && Number.isFinite(weight) ? [[category, Math.min(2, Math.max(0.25, weight))]] : [];
    })),
  };
}

const BASE_PRIORITY: Record<ObservationCategory, number> = { test: 0.82, source: 0.75, config: 0.72, docs: 0.58, data: 0.55, asset: 0.45, network: 0.40, other: 0.32 };

export function observationPriority(observations: readonly InspirationObservation[], preferences: InspirationPreferences): number {
  let score = 0;
  for (const observation of observations) {
    for (const { category } of observation.files) score = Math.max(score, BASE_PRIORITY[category] * (preferences.weights[category] ?? 1));
    if (observation.traffic) {
      const bytes = observation.traffic.receivedBytes + observation.traffic.sentBytes;
      const strength = 0.65 + 0.35 * Math.min(1, Math.log2(1 + bytes / 65_536) / 5);
      score = Math.max(score, BASE_PRIORITY.network * strength * (preferences.weights.network ?? 1));
    }
  }
  return Math.min(1, score);
}

export function lensPreference(lens: InspirationLens, preferences: InspirationPreferences): number {
  const category = LENS_CATEGORY[lens];
  return category ? preferences.weights[category] ?? 1 : 1;
}

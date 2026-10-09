/**
 * The inference a coordinator runs without the platform's own backend.
 *
 * When the account chose another provider, a turn is not sent to the backend at all: it is written into a store this
 * coordinator keeps beside its settings, answered by that provider, and the answer is written back — so the transcript
 * a surface shows is the same shape either way. Turns for one agent are run one at a time, the transcript a caller
 * asks for is the backend's tail with this store's own entries appended, and a reaction is kept where the entry is.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.ts";
import type { SlateInferenceProvider } from "../shared/inference-router.ts";
import { SlateSettingsStore } from "../shared/node/settings/slate-settings-store.ts";
import { createRoutedMcpBridge } from "./routed-mcp-bridge.ts";

/** The providers whose turns are run here, rather than by the platform's own backend. */
export type RoutedProvider = Exclude<SlateInferenceProvider, "slate">;

/** The message shape the provider runner takes. */
type ProviderMessages = Parameters<typeof runRoutedProviderText>[1];

const ROUTED_PROVIDERS: readonly string[] = ["codex", "claude-code", "openrouter"];
const TRANSCRIPT_READ_METHODS = ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"];
const MAX_ENTRIES_PER_AGENT = 200;
const DEFAULT_TRANSCRIPT_LIMIT = 500;
const ACTIVITY_PULSE_MS = 250;
/** How long the composing state stays authoritative before token streaming begins. */
const COMPOSING_HOLD_MS = 1_200;

export interface StoredEntry {
  readonly provider: RoutedProvider;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly richText?: string;
  readonly id: string;
  readonly clientNonce?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[];
  readonly timestampMs: number;
}

export interface StoredTranscript {
  readonly schemaVersion: 2;
  readonly agents: Readonly<Record<string, readonly StoredEntry[]>>;
}

const EMPTY_STORE: StoredTranscript = { schemaVersion: 2, agents: {} };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** An entry is kept only when it says what it is: anything malformed is left out rather than guessed at. */
function isStoredEntry(row: Record<string, unknown>): boolean {
  if (!ROUTED_PROVIDERS.includes(String(row.provider))) return false;
  if (row.role !== "user" && row.role !== "assistant") return false;
  if (typeof row.content !== "string" || typeof row.id !== "string" || typeof row.timestampMs !== "number") return false;
  if (row.clientNonce !== undefined && typeof row.clientNonce !== "string") return false;
  if (row.richText !== undefined && typeof row.richText !== "string") return false;
  if (row.reactions === undefined) return true;
  if (!Array.isArray(row.reactions)) return false;
  return row.reactions.every((reaction) => {
    const record = asRecord(reaction);
    return record != null && typeof record.emoji === "string" && typeof record.by === "string";
  });
}

export function parseInferenceRouterTranscriptStore(value: unknown): StoredTranscript {
  const root = asRecord(value);
  if (root?.schemaVersion !== 2 || asRecord(root.agents) == null) return EMPTY_STORE;
  const agents: Record<string, StoredEntry[]> = {};
  for (const [agentId, rawEntries] of Object.entries(root.agents as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) continue;
    const entries: StoredEntry[] = [];
    for (const raw of rawEntries) {
      const row = asRecord(raw);
      if (row == null || !isStoredEntry(row)) continue;
      entries.push(row as unknown as StoredEntry);
    }
    // A store that somehow holds more than this keeps the most recent of them.
    agents[agentId] = entries.slice(-MAX_ENTRIES_PER_AGENT);
  }
  return { schemaVersion: 2, agents };
}

/** One stored entry as a surface reads it: what the user sent, and what was sent back. */
export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  if (entry.role === "user") {
    return {
      kind: "message",
      id: entry.id,
      role: "user",
      content: entry.content,
      ...(entry.richText === undefined ? {} : { richText: entry.richText }),
      isStreaming: false,
      timestampMs: entry.timestampMs,
      ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }),
      ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
    };
  }
  return {
    kind: "send-message",
    id: entry.id,
    message: { type: "text", content: entry.content },
    timestampMs: entry.timestampMs,
    ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
  };
}

/** The turn number an entry id carries (`t3u`, `t3s0`), when it carries one. */
function turnNumber(id: unknown): number | null {
  const match = typeof id === "string" ? /^t(\d+)(?:u|s\d+)$/.exec(id) : null;
  return match == null ? null : Number(match[1]);
}

export interface CoordinatorInferenceRouterOptions {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
  /** The provider runner; a caller may hand one in instead of the real one. */
  readonly runText?: typeof runRoutedProviderText;
}

export function createCoordinatorInferenceRouter(options: CoordinatorInferenceRouterOptions) {
  const settings = new SlateSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const now = options.now ?? Date.now;
  const runText = options.runText ?? runRoutedProviderText;
  /** One queue per agent: a second turn waits for the first to finish rather than interleaving. */
  const queues = new Map<string, Promise<unknown>>();

  const load = async (): Promise<StoredTranscript> => {
    try {
      return parseInferenceRouterTranscriptStore(JSON.parse(await readFile(storePath, "utf8")));
    } catch {
      return EMPTY_STORE;
    }
  };

  const persist = async (store: StoredTranscript): Promise<void> => {
    await mkdir(dirname(storePath), { recursive: true });
    // Write beside the store and move it into place, so a crash never leaves half a store behind.
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
  };

  const append = async (agentId: string, entries: readonly StoredEntry[]): Promise<StoredTranscript> => {
    const current = await load();
    const next: StoredTranscript = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-MAX_ENTRIES_PER_AGENT) } };
    await persist(next);
    return next;
  };

  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>): void => {
    options.postEvent("transcript", { type, entry, agentId });
  };

  /**
   * Says the agent is working, and keeps saying it until the turn settles: a roster refresh that read the remote
   * (idle) state while a local turn runs would otherwise erase the activity a surface is showing.
   */
  const beginActivity = async (agentId: string): Promise<() => void> => {
    try {
      const remote = await options.dispatchRemote("listAgents", {});
      if (!Array.isArray(remote)) return () => {};
      const project = (isRunning: boolean) =>
        remote.map((raw) => {
          const row = asRecord(raw);
          if (row?.id !== agentId) return raw;
          return { ...row, isRunning, isRunningTurn: isRunning, isComposingMessage: isRunning, isRetrying: false, ...(isRunning ? { currentActivity: { kind: "thinking" } } : { currentActivity: undefined }) };
        });
      const publishRunning = () => options.postEvent("agents", { activeAgentId: agentId, agents: project(true) });
      publishRunning();
      const pulse = setInterval(publishRunning, ACTIVITY_PULSE_MS);
      pulse.unref();
      return () => {
        clearInterval(pulse);
        options.postEvent("agents", { activeAgentId: agentId, agents: project(false) });
      };
    } catch {
      return () => {};
    }
  };

  const toggleLocalReaction = async (agentId: string, entryId: string, emoji: string): Promise<Record<string, unknown> | null> => {
    const trimmed = emoji.trim();
    if (agentId.length === 0 || entryId.length === 0 || trimmed.length === 0) return null;
    const current = await load();
    const entries = current.agents[agentId];
    if (entries == null) return null;
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return null;
    const before = entries[index]!;
    const reactions = before.reactions ?? [];
    const reacted = reactions.some((reaction) => reaction.emoji === trimmed && reaction.by === "me");
    const nextReactions = reacted ? reactions.filter((reaction) => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
    const { reactions: _old, ...withoutReactions } = before;
    // An entry with no reactions left is stored as one that never had any.
    const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
    const nextEntries = [...entries];
    nextEntries[index] = updated;
    await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } });
    return projectInferenceRouterTranscriptEntry(updated);
  };

  const runPromptTurn = async (provider: RoutedProvider, args: Record<string, unknown>): Promise<void> => {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const richText = typeof args.richText === "string" ? args.richText : undefined;
    const clientNonce = typeof args.clientNonce === "string" ? args.clientNonce : randomUUID();
    if (agentId.length === 0 || prompt.length === 0) throw new Error("Local inference routing requires an agentId and prompt");
    const timestampMs = now();
    const [remote, beforeUser] = await Promise.all([options.dispatchRemote("getAgentTranscriptTail", { id: agentId }), load()]);
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? (asRecord(remote)!.entries as unknown[]) : [];
    // The turn after the highest one either side knows about, so a local turn and the backend's numbering never collide.
    const remoteTurn = remoteEntries.reduce<number>((highest, raw) => Math.max(highest, turnNumber(asRecord(raw)?.id) ?? highest), -1);
    const localTurn = (beforeUser.agents[agentId] ?? []).reduce((highest, entry) => Math.max(highest, turnNumber(entry.id) ?? highest), -1);
    const turn = Math.max(remoteTurn, localTurn) + 1;
    const userEntry = { kind: "message", id: `t${turn}u`, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), isStreaming: false, timestampMs, clientNonce };
    const withUser = await append(agentId, [{ provider, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), id: userEntry.id, clientNonce, timestampMs }]);
    emitTranscript(agentId, "appended", userEntry);

    const endActivity = await beginActivity(agentId);
    // The composing state is held long enough to be seen before token streaming takes over the row.
    await new Promise<void>((resolve) => setTimeout(resolve, COMPOSING_HOLD_MS));

    const messages: ProviderMessages = (withUser.agents[agentId] ?? []).map((entry) => ({ role: entry.role, content: entry.content }));
    const assistantTimestampMs = now();
    const assistantId = `t${turn}s0`;
    let assistantStreamStarted = false;
    const emitAssistant = (nextContent: string, streaming: boolean): void => {
      const entry = { kind: "send-message", id: assistantId, message: { type: "text", content: nextContent }, streaming, timestampMs: assistantTimestampMs };
      emitTranscript(agentId, assistantStreamStarted ? "updated" : "appended", entry);
      assistantStreamStarted = true;
    };

    // A provider that can reach this platform's tools goes through the routed bridge; the others are handed the tools.
    const bridge = provider === "claude-code" ? await createRoutedMcpBridge({ listTools: () => options.dispatchRemote("listRoutedMcpTools", {}), callTool: (tool) => options.dispatchRemote("executeRoutedMcpTool", { ...tool, agentId }) }) : null;
    const directTools = bridge == null ? await options.dispatchRemote("listRoutedMcpTools", {}) : undefined;
    const tools = Array.isArray(directTools) ? (directTools as Record<string, any>[]) : undefined;
    const onTextDelta = (_delta: string, accumulated: string): void => emitAssistant(accumulated, true);

    let content: string;
    try {
      content = await runText(
        provider,
        messages,
        bridge == null
          ? {
              ...(tools === undefined ? {} : { tools }),
              executeTool: async (definition, toolArgs, toolCallId) =>
                await options.dispatchRemote("executeRoutedMcpTool", { providerIdentifier: definition.providerIdentifier, name: definition.name, toolName: definition.toolName, args: toolArgs, toolCallId, agentId }),
              onTextDelta,
            }
          : { mcpServerUrl: bridge.url, onTextDelta },
      );
    } finally {
      endActivity();
      await bridge?.close();
    }
    await append(agentId, [{ provider, role: "assistant", content, id: assistantId, timestampMs: assistantTimestampMs }]);
    emitAssistant(content, false);
  };

  return {
    provider(): SlateInferenceProvider {
      return settings.getInferenceProvider();
    },

    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const provider = settings.getInferenceProvider();

      if (method === "reactToMessage") {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryId = typeof record.entryId === "string" ? record.entryId : "";
        const emoji = typeof record.emoji === "string" ? record.emoji : "";
        const updated = await toggleLocalReaction(agentId, entryId, emoji);
        if (updated != null) {
          emitTranscript(agentId, "updated", updated);
          return { handled: true, value: undefined };
        }
      }

      // A transcript a surface asks for is the backend's, with this store's own turns appended after it.
      if (provider !== "slate" && TRANSCRIPT_READ_METHODS.includes(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        const [remote, local] = await Promise.all([options.dispatchRemote(method, args), load()]);
        const result = asRecord(remote);
        if (result == null || !Array.isArray(result.entries) || agentId.length === 0) return { handled: true, value: remote };
        const entries = [...result.entries, ...(local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry)];
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : DEFAULT_TRANSCRIPT_LIMIT;
        return { handled: true, value: { ...result, entries: entries.slice(-limit) } };
      }

      if (method !== "sendPrompt" || provider === "slate") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => runPromptTurn(provider, record))
        .catch(async (error) => {
          // A turn that failed is still a turn the user asked for: it is written down as the answer.
          const timestampMs = now();
          const content = `Router error: ${error instanceof Error ? error.message : String(error)}`;
          if (agentId.length > 0) {
            const id = `t${Date.now()}s0`;
            await append(agentId, [{ provider, role: "assistant", content, id, timestampMs }]);
            emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, timestampMs });
          }
        });
      const queued = next.finally(() => {
        // Only the queue that is still the current one takes itself out of the map.
        if (queues.get(agentId) === queued) queues.delete(agentId);
      });
      queues.set(agentId, queued);
      void queued;
      return { handled: true, value: { accepted: true, clientNonce: record.clientNonce, provider } };
    },
  };
}

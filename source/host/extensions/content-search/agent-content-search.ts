/**
 * Searching the text of an agent's transcript.
 *
 * The newest matches come first, per-agent and overall counts are bounded, and a match carries a snippet with a little
 * of what surrounds it. Entries that only passed between agents are not searchable, and each kind of entry contributes
 * the text it has — a message its content, a sent message its text, a notice its text.
 */

/** How many matches one agent may answer with, and how many the whole search may answer with. */
export const AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT = 5;
export const AGENT_CONTENT_SEARCH_MAX_RESULTS = 50;

/** How much of the text around a match a snippet shows, and the mark that says it was cut. */
const SNIPPET_LEAD = 30;
const SNIPPET_TRAIL = 60;
const ELLIPSIS = "…";

/** A transcript entry as far as the search is concerned. */
export type SearchableTranscriptEntry =
  | { readonly id: string; readonly kind: "message"; readonly content: string; readonly role: "user" | "assistant"; readonly timestampMs?: number; readonly hiddenOutboundAgentPeerMessage?: boolean }
  | { readonly id: string; readonly kind: "send-message"; readonly message: { readonly type: string; readonly content?: string }; readonly timestampMs?: number; readonly hiddenOutboundAgentPeerMessage?: boolean }
  | { readonly id: string; readonly kind: "notice"; readonly text: string; readonly timestampMs?: number; readonly hiddenOutboundAgentPeerMessage?: boolean }
  | { readonly id: string; readonly kind: string; readonly timestampMs?: number; readonly hiddenOutboundAgentPeerMessage?: boolean };

/** One match: the entry it is in, who said it, when, and the text around it. */
export interface AgentContentMatch {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly timestampMs: number;
  readonly snippet: string;
}

/** How each kind of entry gives up its text; a kind with no reader contributes nothing. */
const TEXT_READERS: ReadonlyMap<string, (row: SearchableTranscriptEntry) => string> = new Map([
  ["message", (row) => ("content" in row ? row.content : "")],
  ["send-message", (row) => ("message" in row && row.message.type === "text" ? row.message.content ?? "" : "")],
  ["notice", (row) => ("text" in row ? row.text : "")],
]);

/** The text an entry contributes to the search, by what kind of entry it is. */
export function entrySearchText(row: SearchableTranscriptEntry): string {
  const reader = TEXT_READERS.get(row.kind);
  return reader === undefined ? "" : reader(row);
}

/** The text as the search sees it: one line, with its whitespace collapsed and its ends trimmed. */
function searchableText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** The span a snippet shows around a match: the lead before it and the trail after it, within the text. */
function snippetSpan(textLength: number, foundAt: number, queryLength: number): { leadStart: number; trailEnd: number } {
  return { leadStart: Math.max(0, foundAt - SNIPPET_LEAD), trailEnd: Math.min(textLength, foundAt + queryLength + SNIPPET_TRAIL) };
}

/** A text with an ellipsis at each end that the span cut off. */
function withCutMarks(cut: string, leadStart: number, trailEnd: number, textLength: number): string {
  return `${leadStart > 0 ? ELLIPSIS : ""}${cut}${trailEnd < textLength ? ELLIPSIS : ""}`;
}

/** The snippet around a match, cut to the lead and trail with a mark where either end was cut; null when there is no match. */
export function buildContentSnippet(content: string, query: string): string | null {
  if (query.length === 0) return null;
  const flat = searchableText(content);
  const foundAt = flat.toLowerCase().indexOf(query);
  if (foundAt < 0) return null;
  const { leadStart, trailEnd } = snippetSpan(flat.length, foundAt, query.length);
  return withCutMarks(flat.slice(leadStart, trailEnd), leadStart, trailEnd, flat.length);
}

/** Who a matching entry is from: its own role when it has one, otherwise the agent's side. */
function matchRole(row: SearchableTranscriptEntry): "user" | "assistant" {
  return row.kind === "message" && "role" in row ? row.role : "assistant";
}

/** Whether an entry is one the search must not see: a message that only passed between agents. */
function isHiddenFromSearch(row: SearchableTranscriptEntry): boolean {
  return row.hiddenOutboundAgentPeerMessage === true;
}

/** The match one entry makes for this query, or null when it has no text that matches. */
function matchForEntry(row: SearchableTranscriptEntry, query: string): AgentContentMatch | null {
  const excerpt = buildContentSnippet(entrySearchText(row), query);
  if (excerpt == null) return null;
  return { entryId: row.id, role: matchRole(row), timestampMs: row.timestampMs ?? 0, snippet: excerpt };
}

/** The newest matches in an agent's transcript, at most the per-agent limit of them. */
export function findAgentContentMatches(
  transcript: readonly SearchableTranscriptEntry[],
  query: string,
  maxMatches = AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT,
): AgentContentMatch[] {
  if (query.length === 0) return [];
  const found: AgentContentMatch[] = [];
  for (let cursor = transcript.length - 1; cursor >= 0 && found.length < maxMatches; cursor -= 1) {
    const row = transcript[cursor];
    if (row == null || isHiddenFromSearch(row)) continue;
    const match = matchForEntry(row, query);
    if (match != null) found.push(match);
  }
  return found;
}
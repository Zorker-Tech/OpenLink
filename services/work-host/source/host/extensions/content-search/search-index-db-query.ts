import { FTS_QUERY_MAX_TERMS } from "./search-index-db-contracts.ts";

function queryTerms(value: string): string[] {
  return value.normalize("NFKC").trim().split(/\s+/).filter(Boolean).slice(0, FTS_QUERY_MAX_TERMS);
}

function prefixTerm(value: string): string {
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"*`;
}

export function buildFtsMatchQuery(query: string): string | null {
  const terms = queryTerms(query);
  return terms.length === 0 ? null : terms.map(prefixTerm).join(" ");
}

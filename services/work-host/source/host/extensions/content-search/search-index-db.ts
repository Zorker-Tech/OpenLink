export {
  FTS_QUERY_MAX_TERMS,
  META_RECONCILE_DONE,
  SEARCH_INDEX_FILENAME,
  SEARCH_INDEX_SCHEMA_VERSION,
  SNIPPET_CONTEXT_TOKENS,
  type AttachmentKind,
  type MediaSearchResult,
  type MessageSearchResult,
} from "./search-index-db-contracts.ts";
export {
  SCHEMA,
  ensureSearchIndexSchema,
  openSearchIndexDb,
  readReconcileDone,
  readSearchIndexSchemaVersion,
  stampSearchIndexSchemaVersion,
  writeReconcileDone,
} from "./search-index-db-schema.ts";
export { buildFtsMatchQuery } from "./search-index-db-query.ts";
export { searchMedia, searchMessages } from "./search-index-db-search.ts";

/**
 * Searching the web and fetching a page, through the platform's own backend.
 *
 * A search answers with what the model said and the documents it read; a fetch answers with a page's content, or with
 * why it could not be had — a timeout being the one refusal a caller can tell apart.
 */

import { AiService } from "../../../packages/proto/generated/aiserver/v1/aiserver_connect.ts";
import { RunWebFetchRequest, RunWebSearchRequest, type RunWebFetchResponse, type RunWebSearchResponse } from "../../../packages/proto/generated/aiserver/v1/aiserver_pb.ts";
import { createSlateCursorBackendClient, type SlateInferenceOptions } from "../../../shared/node/cursor-backend/cursor-inference.ts";

type CursorBackendOptions = Omit<SlateInferenceOptions, "backendUrl">;

/** The two backend calls these services make; a caller may hand them in instead of building them. */
export interface WebSearchClient {
  runWebSearch(request: RunWebSearchRequest): Promise<RunWebSearchResponse>;
}

export interface WebFetchClient {
  runWebFetch(request: RunWebFetchRequest): Promise<RunWebFetchResponse>;
}

export interface WebSearchDocument {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

export interface WebSearchAnswer {
  readonly answer: string;
  readonly documents: WebSearchDocument[];
}

export function createCursorWebSearchService(options: CursorBackendOptions & { modelId: string; client?: WebSearchClient }) {
  const client = options.client ?? (createSlateCursorBackendClient(AiService, options) as unknown as WebSearchClient);
  return async (_ctx: unknown, args: { searchTerm: string; explanation?: string }): Promise<WebSearchAnswer> => {
    const response = await client.runWebSearch(new RunWebSearchRequest({
      searchTerm: args.searchTerm,
      ...(args.explanation === undefined ? {} : { explanation: args.explanation }),
      modelId: options.modelId,
    }));
    return {
      // The wire says nothing with an absent field rather than with an empty one; a caller wants a string.
      answer: response.answer ?? "",
      documents: response.documents.map((document) => ({ url: document.url, title: document.title, text: document.text })),
    };
  };
}

export function createCursorWebFetchService(options: CursorBackendOptions & { client?: WebFetchClient }) {
  const client = options.client ?? (createSlateCursorBackendClient(AiService, options) as unknown as WebFetchClient);
  return async (_ctx: unknown, url: string): Promise<{ content: string } | { error: string; isTimeout?: boolean }> => {
    const response = await client.runWebFetch(new RunWebFetchRequest({ url }));
    switch (response.result.case) {
      case "success":
        return { content: response.result.value.content };
      case "error":
        return { error: response.result.value.error, isTimeout: response.result.value.isTimeout };
      case undefined:
        return { error: "Web fetch returned no result." };
    }
  };
}

/** Adapts generated backend web-search and page-fetch requests to Slate result values. */

import { AiService } from "../proto/generated/aiserver/v1/aiserver_connect.ts"
import {
  RunWebFetchRequest,
  RunWebSearchRequest,
  type RunWebFetchResponse,
  type RunWebSearchResponse,
} from "../proto/generated/aiserver/v1/aiserver_pb.ts"
import { createSlateCursorBackendClient, type SlateInferenceOptions } from "../cursor-backend/cursor-inference.ts"
import type { SlateWebFetchResult, SlateWebSearchAnswer } from "../../../host/extensions/inference/web-tool-contracts.ts"

type BackendOptions = Omit<SlateInferenceOptions, "backendUrl">

export interface WebSearchRpcClient {
  runWebSearch(request: RunWebSearchRequest): Promise<RunWebSearchResponse>
}

export interface WebFetchRpcClient {
  runWebFetch(request: RunWebFetchRequest): Promise<RunWebFetchResponse>
}

export function createSlateWebSearchService(
  options: BackendOptions & { readonly modelId: string; readonly client?: WebSearchRpcClient | undefined },
) {
  const client = options.client ??
    (createSlateCursorBackendClient(AiService, options) as unknown as WebSearchRpcClient)

  return async (_context: unknown, args: { searchTerm: string; explanation?: string }): Promise<SlateWebSearchAnswer> => {
    const response = await client.runWebSearch(new RunWebSearchRequest({
      searchTerm: args.searchTerm,
      ...(args.explanation === undefined ? {} : { explanation: args.explanation }),
      modelId: options.modelId,
    }))

    return {
      answer: response.answer ?? "",
      documents: response.documents.map(document => ({
        url: document.url,
        title: document.title,
        text: document.text,
      })),
    }
  }
}

export function createSlateWebFetchService(
  options: BackendOptions & { readonly client?: WebFetchRpcClient | undefined },
) {
  const client = options.client ??
    (createSlateCursorBackendClient(AiService, options) as unknown as WebFetchRpcClient)

  return async (_context: unknown, url: string): Promise<SlateWebFetchResult> => {
    const response = await client.runWebFetch(new RunWebFetchRequest({ url }))
    switch (response.result.case) {
      case "success":
        return { content: response.result.value.content }
      case "error":
        return { error: response.result.value.error, isTimeout: response.result.value.isTimeout }
      case undefined:
        return { error: "Web fetch returned no result." }
    }
  }
}

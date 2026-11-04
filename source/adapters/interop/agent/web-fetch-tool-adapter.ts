/** Binds Slate's page-fetch policy to the remote Agent tool call and result envelopes. */
import { z } from "zod"

import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  WebFetchArgs,
  WebFetchError,
  WebFetchRejected,
  WebFetchResult,
  WebFetchSuccess,
  WebFetchToolCall,
} from "../proto/generated/agent/v1/web_fetch_tool_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import { createSpan } from "../../../packages/context/telemetry.ts"
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.ts"
import {
  ToolCallError,
  createZodAgentTool,
  withSafeParsedArgs,
} from "../../../packages/agent/tools/tool-support.ts"
import { ToolCallRejectedError } from "../../../packages/agent/tools/tool-errors.ts"
import { queryWebFetch, type InteractionQueryListener } from "../../../packages/agent-core/interaction-queries.ts"
import { describeOutputLocation } from "./agent-tools-file-adapter.ts"
import {
  fetchWebPage,
  prepareWebFetchUrl,
  webFetchDescription,
  type WebFetchBehaviorDependencies,
} from "../../../packages/agent/tools/core/web-fetch.ts"

export interface WebFetchToolDependencies extends WebFetchBehaviorDependencies {
  readonly promptVersion?: string | undefined
  readonly useMinimalHarness?: boolean | undefined
}

interface WebFetchInteraction {
  readonly listener: InteractionQueryListener<Context>
  executeToolCall(
    context: Context,
    toolCall: ToolCall,
    id: string,
    run: (context: Context) => Promise<WebFetchResult>,
    merge: (result: WebFetchResult) => ToolCall,
  ): Promise<WebFetchResult>
}

function buildFetchToolCall(value: WebFetchToolCall): ToolCall {
  return new ToolCall({ tool: { case: "webFetchToolCall", value } })
}

function fetchToolName(version: string): string {
  if (version === "dsv3-1018" || version === "dsv3-1205") return "mcp_web_fetch"
  if (["cursor-0226", "latest", "gpt5-codex", "codex-cloud", "haiku"].includes(version)) return "WebFetch"
  throw new Error(`Unhandled version: ${version}`)
}

export function createWebFetchTool(toolDependencies: WebFetchToolDependencies) {
  const version = toolDependencies.promptVersion ?? "latest"
  const parameters = z.object({ url: z.string().describe("The URL to fetch. The content will be converted to a readable markdown format.") })
  const runFetch = async (
    context: Context,
    toolInteraction: WebFetchInteraction,
    parsedArgs: z.infer<typeof parameters>,
    callMeta: { readonly toolCallId: string },
  ): Promise<WebFetchResult> => {
    const url = prepareWebFetchUrl(parsedArgs.url, toolDependencies.stripCredentialedUrls === true)
    const fetchArgs = new WebFetchArgs({ url, toolCallId: callMeta.toolCallId })
    const callSkeleton = new WebFetchToolCall({ args: fetchArgs })
    const fetchSpan = createSpan(context.withName("webFetchExecute"))
    return toolInteraction.executeToolCall(
      fetchSpan.ctx,
      buildFetchToolCall(callSkeleton),
      callMeta.toolCallId,
      async fetchContext => {
        const consent = await queryWebFetch(toolInteraction.listener, fetchContext, {
          url: fetchArgs.url,
          toolCallId: fetchArgs.toolCallId,
        })
        if (consent.result.case === "rejected") {
          throw new ToolCallRejectedError(consent.result.value.reason || "User rejected the web fetch")
        }
        const outcome = await fetchWebPage(fetchContext, url, callMeta.toolCallId, toolDependencies)
        return outcome.kind === "error"
          ? new WebFetchResult({ result: { case: "error", value: new WebFetchError({ url: outcome.url, error: outcome.error }) } })
          : new WebFetchResult({ result: { case: "success", value: new WebFetchSuccess({ url: outcome.url, markdown: outcome.markdown, ...(outcome.outputLocation === undefined ? {} : { outputLocation: outcome.outputLocation as never }) }) } })
      },
      fetchResult => buildFetchToolCall(new WebFetchToolCall({ ...callSkeleton, result: fetchResult })),
    )
  }

  return createZodAgentTool("WEB_FETCH", {
    name: fetchToolName(version),
    descriptionGenerator: () => webFetchDescription(toolDependencies.useMinimalHarness === true),
    parameters,
    execute: withSafeParsedArgs(parameters, runFetch as never, buildFetchToolCall(new WebFetchToolCall())),
    render: async (_context: Context, fetchResult: WebFetchResult) => {
      switch (fetchResult.result.case) {
        case "success":
          return createStringResult(`# Content from ${fetchResult.result.value.url}\n\n${fetchResult.result.value.outputLocation === undefined ? fetchResult.result.value.markdown : describeOutputLocation(fetchResult.result.value.outputLocation)}`)
        case "error":
          return createStringResult(fetchResult.result.value.url.length > 0 ? `Error fetching URL ${fetchResult.result.value.url}: ${fetchResult.result.value.error}` : `Error: ${fetchResult.result.value.error}`)
        case "rejected":
          return createStringResult(fetchResult.result.value.reason.length > 0 ? `Web fetch rejected: ${fetchResult.result.value.reason}` : "The web fetch was rejected by the user.")
        case undefined:
          return createStringResult("Unknown error")
      }
    },
    serializeError: (error: unknown) => buildFetchToolCall(new WebFetchToolCall({ result: new WebFetchResult({ result: error instanceof ToolCallRejectedError
      ? { case: "rejected", value: new WebFetchRejected({ reason: error.message }) }
      : { case: "error", value: new WebFetchError({ error: error instanceof ToolCallError ? error.clientVisibleErrorMessage : "An error occurred while fetching the URL" }) } }) })),
  })
}

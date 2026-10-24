/**
 * The tool that reads a page for the model.
 *
 * Two things about a fetch are decided before it is made. The URL has to be one this tool can reach: a
 * loopback or private address is refused with the reason, because the fetch runs from an isolated server and
 * an address that only exists on this machine would either fail confusingly or reach something the model
 * should not be reaching. And the URL's own credentials are stripped when the session asks for that, since a
 * URL pasted from somewhere may carry a token that would then travel to a third party.
 *
 * The fetch itself is asked of the user first, through the same query the other tools use, so a session that
 * wants to approve outbound requests can. A failure comes back in the shape it was: a timeout is a timeout
 * the orchestrator may retry, and anything else is an error the model reads with the URL it was about.
 *
 * Content that is too large for a message is written to the project's tools folder and the fetchResult points at
 * it, and pageContent that is merely long is cut with a count of the lines left out — either way the model is
 * told what it did not get rather than being handed a silent truncation.
 */

import { z } from "zod"

import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.ts"
import {
  WebFetchArgs,
  WebFetchError,
  WebFetchRejected,
  WebFetchResult,
  WebFetchSuccess,
  WebFetchToolCall,
} from "../../../proto/generated/agent/v1/web_fetch_tool_pb.ts"
import type { Context } from "../../../context/context.ts"
import { createSpan } from "../../../context/telemetry.ts"
import { createStringResult } from "../../../chat-inference/prompt-executor.ts"
import { writeToAgentToolsFile, describeOutputLocation, AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES } from "../../../agent-exec/agent-tools-file.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import { writeExecutorResource } from "../../../agent-exec/write-operation.ts"
import { queryWebFetch, type InteractionQueryListener } from "../../../agent-core/interaction-queries.ts"
import { isLoopbackIpHost, isPrivateIpHost } from "../../utils/ip-addresses.ts"
import { ToolCallArgParseError, ToolCallError, ToolTimeoutError, createZodAgentTool, withSafeParsedArgs } from "../tool-support.ts"
import { ToolCallRejectedError } from "../tool-errors.ts"

const MAX_CONTENT_SIZE = 100_000;

export interface WebFetchServiceResult {
  readonly content?: string;
  readonly error?: string;
  readonly isTimeout?: boolean;
}

export interface WebFetchToolDependencies {
  readonly webFetchService: (context: Context, url: string) => Promise<WebFetchServiceResult>;
  readonly promptVersion?: string;
  readonly useMinimalHarness?: boolean;
  readonly projectFolder?: string;
  readonly osPlatform?: string;
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager>;
  readonly stripCredentialedUrls?: boolean;
}

function buildFetchToolCall(value: WebFetchToolCall): ToolCall {
  return new ToolCall({ tool: { case: "webFetchToolCall", value } });
}

function fetchToolName(version: string): string {
  if (version === "dsv3-1018" || version === "dsv3-1205") return "mcp_web_fetch";
  if (["cursor-0226", "latest", "gpt5-codex", "codex-cloud", "haiku"].includes(version)) return "WebFetch";
  throw new Error(`Unhandled version: ${version}`);
}

function clipLongContent(pageContent: string): string {
  if (pageContent.length <= MAX_CONTENT_SIZE) return pageContent;
  const omitted = pageContent.slice(MAX_CONTENT_SIZE);
  const lines = (omitted.match(/\n/g) ?? []).length + 1;
  return `${pageContent.slice(0, MAX_CONTENT_SIZE)}\n\n...[${lines} line${lines === 1 ? "" : "s"} truncated]`;
}

function localAddressRejection(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  const display = url.port.length > 0 ? `${host}:${url.port}` : host;
  if (host === "localhost" || host.endsWith(".localhost") || isLoopbackIpHost(host)) return `Cannot fetch from localhost (${display}) because this tool runs from an isolated server.`;
  if (isPrivateIpHost(host)) return `Cannot fetch from private IP (${display}) because this tool runs from an isolated server.`;
  return undefined;
}

function description(version: string, minimalHarness: boolean): string {
  if (minimalHarness) return "Fetch content from a URL and return it as readable markdown. Prefer this over shell for web content because shell egress is more restricted.";
  return `Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze webpage content.

- The URL must be a fully-formed, valid URL.
- This tool is read-only and will not work for requests intended to have side effects.
- This fetch tries to return live results but may return previously cached content.
- Authentication is not supported, and an error will be returned if the URL requires authentication.
- If the URL is returning a non-200 status code, the tool will not return the content and will instead return an error message.
- This fetch runs from an isolated server. Hosts like localhost or private IPs will not work.
- This tool does not support fetching binary content, e.g. media or PDFs.
`;
}

function removeUrlCredentials(url: string, enabled: boolean): string {
  if (!enabled) return url;
  try {
    const targetUrlObject = new URL(url);
    if (targetUrlObject.username.length === 0 && targetUrlObject.password.length === 0) return url;
    targetUrlObject.username = "";
    targetUrlObject.password = "";
    return targetUrlObject.toString();
  } catch {
    return url;
  }
}

export function createWebFetchTool(toolDeps: WebFetchToolDependencies) {
  const version = toolDeps.promptVersion ?? "latest";
  const parameters = z.object({ url: z.string().describe("The URL to fetch. The content will be converted to a readable markdown format.") });
  const runFetch = async (context: Context, toolInteraction: { readonly listener: InteractionQueryListener<Context>; executeToolCall: (context: Context, toolCall: ToolCall, id: string, run: (context: Context) => Promise<WebFetchResult>, merge: (fetchResult: WebFetchResult) => ToolCall) => Promise<WebFetchResult> }, parsedArgs: z.infer<typeof parameters>, callMeta: { readonly toolCallId: string }): Promise<WebFetchResult> => {
    const url = removeUrlCredentials(parsedArgs.url, toolDeps.stripCredentialedUrls === true);
    let targetUrlObject: URL;
    try { targetUrlObject = new URL(url); } catch { throw new ToolCallArgParseError("Invalid URL: must include http:// or https://"); }
    if (targetUrlObject.protocol !== "http:" && targetUrlObject.protocol !== "https:") throw new ToolCallArgParseError(`Invalid URL protocol: ${targetUrlObject.protocol} (must be http or https)`);
    const localRejection = localAddressRejection(targetUrlObject);
    if (localRejection !== undefined) throw new ToolCallArgParseError(localRejection);
    const fetchArgs = new WebFetchArgs({ url, toolCallId: callMeta.toolCallId });
    const callSkeleton = new WebFetchToolCall({ args: fetchArgs });
    const fetchSpan = createSpan(context.withName("webFetchExecute"));
    return toolInteraction.executeToolCall(fetchSpan.ctx, buildFetchToolCall(callSkeleton), callMeta.toolCallId, async fetchContext => {
      const consent = await queryWebFetch(toolInteraction.listener, fetchContext, fetchArgs);
      if (consent.result.case === "rejected") throw new ToolCallRejectedError(consent.result.value.reason || "User rejected the web fetch");
      const serviceResult = await toolDeps.webFetchService(fetchContext, url);
      if (serviceResult.error !== undefined) {
        if (serviceResult.isTimeout === true) throw new ToolTimeoutError({ clientVisibleErrorMessage: serviceResult.error, modelVisibleErrorMessage: serviceResult.error, error: serviceResult.error });
        return new WebFetchResult({ result: { case: "error", value: new WebFetchError({ url, error: serviceResult.error }) } });
      }
      const pageContent = serviceResult.content ?? "";
      if (toolDeps.projectFolder !== undefined && toolDeps.resourceAccessor !== undefined && Buffer.byteLength(pageContent, "utf8") > AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES) {
        const storedLocation = await writeToAgentToolsFile(fetchContext, toolDeps.resourceAccessor.get(writeExecutorResource), { content: pageContent, projectDir: toolDeps.projectFolder, osPlatform: toolDeps.osPlatform, toolCallId: callMeta.toolCallId });
        if (storedLocation !== undefined) return new WebFetchResult({ result: { case: "success", value: new WebFetchSuccess({ url, markdown: pageContent, outputLocation: storedLocation }) } });
      }
      return new WebFetchResult({ result: { case: "success", value: new WebFetchSuccess({ url, markdown: clipLongContent(pageContent) }) } });
    }, fetchResult => buildFetchToolCall(new WebFetchToolCall({ ...callSkeleton, result: fetchResult })));
  };
  return createZodAgentTool("WEB_FETCH", {
    name: fetchToolName(version),
    descriptionGenerator: () => description(version, toolDeps.useMinimalHarness === true),
    parameters,
    execute: withSafeParsedArgs(parameters, runFetch as never, buildFetchToolCall(new WebFetchToolCall())),
    render: async (_context: Context, fetchResult: WebFetchResult) => {
      switch (fetchResult.result.case) {
        case "success": return createStringResult(`# Content from ${fetchResult.result.value.url}\n\n${fetchResult.result.value.outputLocation === undefined ? clipLongContent(fetchResult.result.value.markdown) : describeOutputLocation(fetchResult.result.value.outputLocation)}`);
        case "error": return createStringResult(fetchResult.result.value.url.length > 0 ? `Error fetching URL ${fetchResult.result.value.url}: ${fetchResult.result.value.error}` : `Error: ${fetchResult.result.value.error}`);
        case "rejected": return createStringResult(fetchResult.result.value.reason.length > 0 ? `Web fetch rejected: ${fetchResult.result.value.reason}` : "The web fetch was rejected by the user.");
        case undefined: return createStringResult("Unknown error");
      }
    },
    serializeError: (error: unknown) => buildFetchToolCall(new WebFetchToolCall({ result: new WebFetchResult({ result: error instanceof ToolCallRejectedError
      ? { case: "rejected", value: new WebFetchRejected({ reason: error.message }) }
      : { case: "error", value: new WebFetchError({ error: error instanceof ToolCallError ? error.clientVisibleErrorMessage : "An error occurred while fetching the URL" }) } }) })),
  });
}

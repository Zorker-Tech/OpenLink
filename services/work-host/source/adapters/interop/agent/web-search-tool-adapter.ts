/**
 * The tool that searches the web.
 *
 * A search is asked of the user first, like the other outbound tools, and what comes back is not one page
 * but several: an answer, if the provider produced one, and a list of documents. How much of each document
 * the model is given depends on where the search runs. In a session with a project to write into, a document
 * that is longer than a message should carry is written to a file and the reference says where it went, with
 * a note that the page can be read from there rather than fetched again; a session with nowhere to write
 * falls back to the first thirty thousand characters, and then only when the provider gave no answer of its
 * own — because with an answer in hand, the documents are the detail rather than the content.
 *
 * A provider failure is classified when it says enough to classify: a rate limit or a server error is worth
 * trying again and is reported as a provider error with the status that was seen, read from the message or
 * from the cause it was wrapped in, since a provider's own client tends to nest the useful part. Anything
 * else is passed on as it came.
 *
 * The description depends on the version, and the newest one carries the current year, because a model asked
 * about "the latest" without a date will search for the year it was trained on. That is why a session using
 * it has to say when the conversation started: without a date the guidance cannot be written, and the tool
 * refuses rather than guessing.
 */

import { z } from "zod"

import { ToolCall } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  WebSearchArgs,
  WebSearchError,
  WebSearchRejected,
  WebSearchResult,
  WebSearchSuccess,
  WebSearchToolCall,
} from "../proto/generated/agent/v1/web_search_tool_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import { createSpan } from "../../../packages/context/telemetry.ts"
import { createStringResult } from "../../../packages/chat-inference/prompt-executor.ts"
import { queryWebSearch, type InteractionQueryListener } from "../../../packages/agent-core/interaction-queries.ts"
import { buildWebSearchYearGuidance } from "../../../packages/utils/search-year-guidance.ts"
import { withRemoteHooks } from "../../../packages/agent/tools/remote-hooks.ts"
import { ToolCallError, ToolCallRejectedError } from "../../../packages/agent/tools/tool-errors.ts"
import { createZodAgentTool, withSafeParsedArgs } from "../../../packages/agent/tools/tool-support.ts"
import {
  classifyWebSearchProviderError,
  performWebSearch,
  renderWebSearchReferences,
  type WebSearchService,
  type WebSearchServiceRequest,
  type WebSearchToolDependencies,
  type WebSearchToolOptions,
} from "../../../packages/agent/tools/core/web-search.ts"

function onlySetFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function createWebSearchToolCall(value: WebSearchToolCall): ToolCall {
  return new ToolCall({ tool: { case: "webSearchToolCall", value } });
}

function normalizeArgs(args: { readonly search_term: string; readonly explanation?: string }): WebSearchServiceRequest {
  return onlySetFields({ searchTerm: args.search_term, explanation: args.explanation }) as WebSearchServiceRequest;
}

/** The arguments the tool offers: a search term, and why the search is being made. */
const webSearchArgumentSchemas = {
  search_term: z.string().describe("The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant."),
  explanation: z.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
}

const exaParametersSchema = z.preprocess(
  raw => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const input = raw as Record<string, unknown>;
    if (input.search_term === undefined) {
      const alias = aliasedSearchTerm(input);
      if (alias !== undefined) {
        const { query: _query, searchTerm: _searchTerm, ...rest } = input;
        return { ...rest, search_term: alias };
      }
    }
    return input;
  },
  z.object(webSearchArgumentSchemas).transform(data => ({ variant: "exa" as const, search_term: data.search_term, explanation: data.explanation })),
);

function getParametersSchema(_variant: "exa") {
  return exaParametersSchema
}

function createHookInput(args: { readonly search_term: string; readonly explanation?: string }): { search_term: string; explanation?: string } {
  return onlySetFields({ search_term: args.search_term, explanation: args.explanation }) as { search_term: string; explanation?: string };
}

function applyUpdatedHookInput(args: { search_term: string; explanation?: string }, input: Record<string, unknown>): void {
  if (typeof input.search_term === "string") args.search_term = input.search_term;
  if (typeof input.explanation === "string") args.explanation = input.explanation;
}

function resultToString(result: WebSearchResult): string {
  switch (result.result.case) {
    case "success": return renderWebSearchReferences(result.result.value.references)
    case "error": return `Error: ${result.result.value.error}`
    case "rejected": return result.result.value.reason ? `Web search rejected: ${result.result.value.reason}` : "The web search was rejected by the user."
    default: return "Unknown error"
  }
}

const webSearchToolNames: Readonly<Record<string, string>> = {
  "dsv3-1018": "web_search",
  "cursor-0226": "WebSearch",
  "dsv3-1205": "WebSearch",
  latest: "WebSearch",
  "gpt5-codex": "WebSearch",
  "codex-cloud": "WebSearch",
  haiku: "WebSearch",
}

/** The name the tool is offered under for this prompt version. */
function toolNameFor(promptVersion: string): string {
  const name = webSearchToolNames[promptVersion]
  if (name === undefined) throw new Error(`Unhandled version: ${promptVersion}`)
  return name
}

function getRequiredConversationStartedDate(conversationStartedDate: string | undefined): string {
  if (conversationStartedDate === undefined) throw new Error("conversationStartedDate is required for WebSearch prompts with year guidance");
  return conversationStartedDate;
}

const webSearchDescriptions: Readonly<Record<string, string>> = {
  "gpt5-codex": "Search web for real-time info on any topic; use for up-to-date facts not in training data, like current events or tech updates. Results include snippets and URLs.",
  "codex-cloud": "Search web for real-time info on any topic; use for up-to-date facts not in training data, like current events or tech updates. Results include snippets and URLs.",
  "cursor-0226": "Search web for real-time info on any topic; use for up-to-date facts not in training data, like current events or tech updates. Results include snippets and URLs.",
  "dsv3-1205": "Search the web for real-time information about any topic. Use this tool when you need up-to-date information that might not be available in your training data, or when you need to verify facts. The search results will include relevant snippets and URLs from web pages. This is particularly useful for questions about current events, technology updates, or any topic that requires recent information.",
  "dsv3-1018": "Search the web for real-time information about any topic. Use this tool when you need up-to-date information that might not be available in your training data, or when you need to verify facts. The search results will include relevant snippets and URLs from web pages. This is particularly useful for questions about current events, technology updates, or any topic that requires recent information.",
}

/** The newest description: the general one, plus the year the model should search in. */
function newestWebSearchDescription(conversationStartedDate: string | undefined): string {
  const yearGuidance = buildWebSearchYearGuidance(getRequiredConversationStartedDate(conversationStartedDate));
  return `Search the web for real-time information about any topic. Returns summarized information from search results and relevant URLs.\n\nUse this tool when you need up-to-date information that might not be available or correct in your training data, or when you need to verify facts.\nThis includes queries about:\n- Libraries, frameworks, and tools whose APIs, best practices, or usage instructions are frequently updated. ("How do I run Postgres in a container?")\n- Current events or technology news. ("Which AI model is best for coding?")\n- Informational queries similar to what you might Google ("kubernetes operator for mysql")\n\n${yearGuidance}`;
}

/** The description the tool gives for this version: the newest one also says which year it is. */
function getBaseDescription(promptVersion: string, useMinimalHarness: boolean, conversationStartedDate: string | undefined): string {
  if (useMinimalHarness) return "Search the web for up-to-date information and return snippets and URLs. Prefer this over shell for web searches because shell egress is more restricted.";
  const description = webSearchDescriptions[promptVersion]
  if (description !== undefined) return description
  if (promptVersion !== "latest" && promptVersion !== "haiku") throw new Error(`Unhandled version: ${promptVersion}`)
  return newestWebSearchDescription(conversationStartedDate);
}

/** The options a dependency object carries, dropping the ones it does not set. */
function toolOptionsFrom(dependencies: WebSearchToolDependencies): WebSearchToolOptions {
  return onlySetFields({
    useMinimalHarness: dependencies.useMinimalHarness,
    conversationStartedDate: dependencies.conversationStartedDate,
    projectFolder: dependencies.projectFolder,
    osPlatform: dependencies.osPlatform,
    resourceAccessor: dependencies.resourceAccessor,
    enableExecuteHookExec: dependencies.enableExecuteHookExec,
    configuredSteps: dependencies.configuredSteps,
    model: dependencies.model,
  });
}

/** The hook configuration a web search runs with: how its input is read and how its result is reported. */
/** The result a rejected search reports. */
function createRejectedSearchResult(_args: unknown, reason: string): WebSearchResult {
  return new WebSearchResult({ result: { case: "rejected", value: new WebSearchRejected({ reason }) } })
}

/** The output a successful search hands the hooks. */
function createSuccessSearchOutput(_args: unknown, result: WebSearchResult) {
  const references = result.result.case === "success" ? result.result.value.references.map(reference => ({ title: reference.title, url: reference.url, chunk: reference.chunk })) : [];
  return { status: "success", references_count: references.length, content: references };
}

/** What a failed search reports to the hooks. */
function searchFailureInfo(result: WebSearchResult) {
  switch (result.result.case) {
    case "error": return { errorMessage: result.result.value.error, failureType: "error" };
    case "rejected": return { errorMessage: result.result.value.reason ?? "Web search rejected", failureType: "permission_denied" };
    case "success":
    case undefined: return undefined;
    default: return undefined;
  }
}

function webSearchHookConfig() {
  return {
    toolName: "WebSearch",
    createToolInput: createHookInput,
    applyUpdatedInput: applyUpdatedHookInput,
    createRejectedResult: createRejectedSearchResult,
    createSuccessOutput: createSuccessSearchOutput,
    getFailureInfo: searchFailureInfo,
  }
}

/** What a search call carries besides its arguments: its id, and where its hook context is collected. */
interface WebSearchCallMeta {
  readonly toolCallId: string
  readonly hookContextCollector?: readonly unknown[]
}

/** The interaction handler a search call is run through: the user's answer, and the tool call's own run. */
interface WebSearchInteractionHandler {
  readonly listener: InteractionQueryListener<Context>
  executeToolCall: (context: Context, toolCall: ToolCall, id: string, run: (context: Context) => Promise<WebSearchResult>, merge: (result: WebSearchResult) => ToolCall, hookContextCollector?: readonly unknown[]) => Promise<WebSearchResult>
}

/** Converts the domain outcome to the generated envelope recorded in the interaction stream. */
async function runWebSearchServiceCall(
  context: Context,
  request: WebSearchServiceRequest,
  service: WebSearchService,
  toolCallId: string,
  options: WebSearchToolOptions | undefined,
): Promise<WebSearchResult> {
  const outcome = await performWebSearch(context, request, toolCallId, service, options ?? {})
  return new WebSearchResult({ result: { case: "success", value: new WebSearchSuccess({ references: [...outcome.references] }) } })
}

/** One search tool call: ask for it, then run it through the interaction handler. */
async function executeWebSearchCall(context: Context, interactionHandler: WebSearchInteractionHandler, args: { readonly search_term: string; readonly explanation?: string }, meta: WebSearchCallMeta, webSearchService: WebSearchService, options: WebSearchToolOptions | undefined, legacyObjectForm: boolean): Promise<WebSearchResult> {
  const normalized = normalizeArgs(args)
  const searchArgs = new WebSearchArgs({ searchTerm: normalized.searchTerm, toolCallId: meta.toolCallId })
  const response = await queryWebSearch(interactionHandler.listener, context, {
    searchTerm: searchArgs.searchTerm,
    toolCallId: searchArgs.toolCallId,
  }).catch(error => legacyObjectForm ? Promise.reject(classifyWebSearchProviderError(error) ?? error) : Promise.reject(error))
  if (response.result.case === "rejected") throw new ToolCallRejectedError(response.result.value.reason || "User rejected the web search")
  const baseToolCall = new WebSearchToolCall({ args: searchArgs })
  return interactionHandler.executeToolCall(context, createWebSearchToolCall(baseToolCall), meta.toolCallId, innerContext => runWebSearchServiceCall(innerContext, normalized, webSearchService, meta.toolCallId, options), result => createWebSearchToolCall(new WebSearchToolCall({ ...baseToolCall, result })), meta.hookContextCollector)
}

/** How a failed search is reported: a rejection keeps its reason, anything else its client message. */
function serializeWebSearchError(error: unknown): ToolCall {
  if (error instanceof ToolCallRejectedError) return createWebSearchToolCall(new WebSearchToolCall({ result: new WebSearchResult({ result: { case: "rejected", value: new WebSearchRejected({ reason: error.message }) } }) }))
  return createWebSearchToolCall(new WebSearchToolCall({ result: new WebSearchResult({ result: { case: "error", value: new WebSearchError({ error: error instanceof ToolCallError ? error.clientVisibleErrorMessage : "An error occurred while searching the web" }) } }) }))
}

/** The name a caller may use instead of search_term in a search request. */
function aliasedSearchTerm(input: Record<string, unknown>): string | undefined {
  if (typeof input.query === "string") return input.query
  return typeof input.searchTerm === "string" ? input.searchTerm : undefined
}

/** One search result as the string the model reads. */
function renderWebSearchResult(_context: Context, result: WebSearchResult) {
  return createStringResult(resultToString(result))
}

/** Runs one search through the remote hooks, when the session has a resource to run them with. */
async function runWithRemoteHooks(spanCtx: Context, rawArgs: { readonly search_term: string; readonly explanation?: string }, executeCore: (context: Context, args: { readonly search_term: string; readonly explanation?: string }) => Promise<WebSearchResult>, meta: WebSearchCallMeta, options: WebSearchToolOptions): Promise<WebSearchResult> {
  const wrappedExecute = withRemoteHooks({
    executeFn: executeCore,
    config: webSearchHookConfig(),
    requestContext: { toolCallId: meta.toolCallId },
    options: { resourceAccessor: options.resourceAccessor!, enableExecuteHookExec: options.enableExecuteHookExec, configuredSteps: options.configuredSteps, model: options.model, hookContextCollector: meta.hookContextCollector },
  })
  return await wrappedExecute(spanCtx, rawArgs) as WebSearchResult
}

/** The signature one search call is run with. */
type WebSearchExecute = (parentContext: Context, interactionHandler: WebSearchInteractionHandler, rawArgs: { readonly search_term: string; readonly explanation?: string }, meta: WebSearchCallMeta) => Promise<WebSearchResult>

/** The description the tool gives for this version of the prompt. */
function webSearchDescription(version: string, options: WebSearchToolOptions | undefined): string {
  return getBaseDescription(version, options?.useMinimalHarness ?? false, options?.conversationStartedDate)
}

/** The tool as it is offered: its name, its description, its arguments and its hooks. */
function webSearchToolDefinition(name: string, parameters: ReturnType<typeof getParametersSchema>, execute: WebSearchExecute, version: string, options: WebSearchToolOptions | undefined) {
  return {
    name,
    descriptionGenerator: () => webSearchDescription(version, options),
    parameters,
    execute: withSafeParsedArgs(parameters, execute as never, createWebSearchToolCall(new WebSearchToolCall())),
    render: renderWebSearchResult,
    serializeError: serializeWebSearchError,
  }
}

/** Runs one search on the span named after it, through the hooks when the session enabled them. */
async function executeOnSpan(parentContext: Context, interactionHandler: WebSearchInteractionHandler, rawArgs: { readonly search_term: string; readonly explanation?: string }, meta: WebSearchCallMeta, webSearchService: WebSearchService, legacyObjectForm: boolean, options: WebSearchToolOptions | undefined): Promise<WebSearchResult> {
  using span = createSpan(parentContext.withName("webSearchExecute"))
  const executeCore = async (context: Context, args: { readonly search_term: string; readonly explanation?: string }): Promise<WebSearchResult> =>
    executeWebSearchCall(context, interactionHandler, args, meta, webSearchService, options, legacyObjectForm)
  if (options?.resourceAccessor !== undefined && Boolean(options.enableExecuteHookExec)) return runWithRemoteHooks(span.ctx, rawArgs, executeCore, meta, options)
  return executeCore(span.ctx, rawArgs)
}

/** The tool's input after the two calling forms are reconciled: the service, the version and its parameters. */
function resolveWebSearchToolInput(webSearchServiceOrDependencies: (WebSearchService) | WebSearchToolDependencies, promptVersion: string | undefined, options: WebSearchToolOptions | undefined) {
  let legacyObjectForm = false
  if (typeof webSearchServiceOrDependencies !== "function") {
    legacyObjectForm = true
    const dependencies = webSearchServiceOrDependencies
    webSearchServiceOrDependencies = dependencies.webSearchService
    promptVersion = dependencies.promptVersion
    options = toolOptionsFrom(dependencies)
  }
  const version = promptVersion ?? "latest"
  return { webSearchService: webSearchServiceOrDependencies, version, parameters: getParametersSchema("exa"), options, legacyObjectForm }
}

type WebSearchFactory = ReturnType<typeof createZodAgentTool>;

export function createWebSearchTool(
  webSearchService: WebSearchService,
  promptVersion?: string,
  options?: WebSearchToolOptions,
): WebSearchFactory;
export function createWebSearchTool(dependencies: WebSearchToolDependencies): WebSearchFactory;
export function createWebSearchTool(
  webSearchServiceOrDependencies: (WebSearchService) | WebSearchToolDependencies,
  promptVersion?: string,
  options?: WebSearchToolOptions,
): WebSearchFactory {
  const resolved = resolveWebSearchToolInput(webSearchServiceOrDependencies, promptVersion, options)
  const webSearchService = resolved.webSearchService
  const version = resolved.version
  const parameters = resolved.parameters
  const legacyObjectForm = resolved.legacyObjectForm
  const execute = async (
    parentContext: Context,
    interactionHandler: WebSearchInteractionHandler,
    rawArgs: { readonly search_term: string; readonly explanation?: string },
    meta: WebSearchCallMeta,
  ): Promise<WebSearchResult> => {
    return executeOnSpan(parentContext, interactionHandler, rawArgs, meta, webSearchService, legacyObjectForm, resolved.options);
  };
  const name = toolNameFor(version);
  return createZodAgentTool("WEB_SEARCH", webSearchToolDefinition(name, parameters, execute, version, resolved.options));
}

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

import { ToolCall } from "../../../proto/generated/agent/v1/agent_pb.ts"
import {
  WebSearchArgs,
  WebSearchError,
  WebSearchRejected,
  WebSearchResult,
  WebSearchSuccess,
  WebSearchToolCall,
} from "../../../proto/generated/agent/v1/web_search_tool_pb.ts"
import type { Context } from "../../../context/context.ts"
import { createSpan } from "../../../context/telemetry.ts"
import { createStringResult } from "../../../chat-inference/prompt-executor.ts"
import { writeToAgentToolsFile, describeOutputLocation, AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES } from "../../../agent-exec/agent-tools-file.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import { writeExecutorResource } from "../../../agent-exec/write-operation.ts"
import { queryWebSearch, type InteractionQueryListener } from "../../../agent-core/interaction-queries.ts"
import { buildWebSearchYearGuidance } from "../../../utils/search-year-guidance.ts"
import { withRemoteHooks } from "../remote-hooks.ts"
import { CustomToolCallError, ToolCallError, ToolCallRejectedError, ToolErrorClassification } from "../tool-errors.ts"
import { createZodAgentTool, withSafeParsedArgs } from "../tool-support.ts"

const NO_DISK_INLINE_CAP_CHARS = 30_000;
const WEB_SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024;

export interface WebSearchServiceResult {
  readonly answer?: string;
  readonly documents: readonly { readonly title: string; readonly url: string; readonly text: string }[];
}

export interface WebSearchServiceRequest {
  readonly searchTerm: string;
  readonly explanation?: string;
}

export interface WebSearchToolOptions {
  readonly variant?: "exa";
  readonly useMinimalHarness?: boolean;
  readonly conversationStartedDate?: string;
  readonly projectFolder?: string;
  readonly osPlatform?: string;
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager>;
  readonly enableExecuteHookExec?: boolean;
  readonly configuredSteps?: readonly string[];
  readonly model?: unknown;
}

export interface WebSearchToolDependencies {
  readonly webSearchService: WebSearchService;
  readonly promptVersion?: string;
  readonly useMinimalHarness?: boolean;
  readonly conversationStartedDate?: string;
  readonly projectFolder?: string;
  readonly osPlatform?: string;
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager>;
  readonly enableExecuteHookExec?: boolean;
  readonly configuredSteps?: readonly string[];
  readonly model?: unknown;
}

interface DiskWriteContext {
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>;
  readonly projectFolder: string;
  readonly osPlatform?: string;
}

function createWebSearchToolCall(value: WebSearchToolCall): ToolCall {
  return new ToolCall({ tool: { case: "webSearchToolCall", value } });
}

function normalizeArgs(args: { readonly search_term: string; readonly explanation?: string }): WebSearchServiceRequest {
  return onlySetFields({ searchTerm: args.search_term, explanation: args.explanation }) as WebSearchServiceRequest;
}

const API_REQUEST_FAILED_STATUS_REGEX = /\bAPI request failed:\s*(\d{3})\b/i;

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

function parseProviderStatusFromMessage(message: string): number | undefined {
  const match = API_REQUEST_FAILED_STATUS_REGEX.exec(message);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The messages a provider failure says, from the error itself and from the cause it wrapped. */
function providerFailureMessages(error: unknown): string[] {
  const direct = getErrorMessage(error)
  const cause = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined
  const fromCause = getErrorMessage(cause)
  return [direct, fromCause].filter((message): message is string => message !== undefined)
}

/** Whether a provider status is worth trying again: a rate limit or a server error. */
function isRetryableProviderStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** A provider failure as the tool reports it, with the status that was seen. */
function providerErrorFor(message: string, status: number): CustomToolCallError {
  const text = "The web search provider returned an error; this may be temporary. Please try again."
  return new CustomToolCallError(ToolErrorClassification.PROVIDER_ERROR, {
    clientVisibleErrorMessage: text,
    modelVisibleErrorMessage: text,
    error: `${message}. provider_status=${status}`,
  })
}

/** The provider status a failure names, with the message that named it, when it is worth retrying. */
function retryableProviderStatus(error: unknown): { readonly message: string; readonly status: number } | undefined {
  for (const message of providerFailureMessages(error)) {
    const status = parseProviderStatusFromMessage(message)
    if (status !== undefined && isRetryableProviderStatus(status)) return { message, status }
  }
  return undefined
}

function classifyWebSearchProviderError(error: unknown): CustomToolCallError | undefined {
  const found = retryableProviderStatus(error)
  return found === undefined ? undefined : providerErrorFor(found.message, found.status)
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

/** One reference as the text the model reads. */
function referenceToText(reference: { readonly title: string; readonly url?: string; readonly chunk: string }): string {
  const urlLine = reference.url !== undefined && reference.url !== "" ? `URL: ${reference.url}` : ""
  return `Title: ${reference.title}${urlLine === "" ? "" : "\n" + urlLine}\nContent: ${reference.chunk}\n---\n`
}

function resultToString(result: WebSearchResult): string {
  switch (result.result.case) {
    case "success": return result.result.value.references.map(referenceToText).join("\n")
    case "error": return `Error: ${result.result.value.error}`
    case "rejected": return result.result.value.reason ? `Web search rejected: ${result.result.value.reason}` : "The web search was rejected by the user."
    default: return "Unknown error"
  }
}

/** The provider's own answer as a reference, when it gave one. */
function answerReference(answer: string | undefined): WebSearchReference | undefined {
  return answer === undefined || answer === "" ? undefined : { title: "Web search results", url: "", chunk: answer };
}

/** One document as a reference: written to a file when the session has somewhere to write, else inline. */
async function documentReference(context: Context, document: { readonly title: string; readonly url: string; readonly text: string }, hasAnswer: boolean, diskWriteContext: DiskWriteContext | undefined, toolCallId: string): Promise<WebSearchReference | undefined> {
  if (diskWriteContext !== undefined && Buffer.byteLength(document.text, "utf8") > AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES) {
    const outputLocation = await writeToAgentToolsFile(context, diskWriteContext.resourceAccessor.get(writeExecutorResource), {
      content: document.text,
      projectDir: diskWriteContext.projectFolder,
      osPlatform: diskWriteContext.osPlatform,
      toolCallId,
      maxSize: WEB_SEARCH_MAX_FILE_SIZE,
    });
    if (outputLocation !== undefined) return { title: document.title, url: document.url, chunk: `${describeOutputLocation(outputLocation, { leadText: "Full page text" })}\nUse shell / grep / read_file on this path to inspect the page; no follow-up fetch is needed.` };
  }
  if (hasAnswer) return undefined;
  return { title: document.title, url: document.url, chunk: document.text.slice(0, NO_DISK_INLINE_CAP_CHARS) };
}

async function buildReferencesFromServiceResult(context: Context, serviceResult: WebSearchServiceResult, toolCallId: string, diskWriteContext: DiskWriteContext | undefined): Promise<Array<WebSearchReference>> {
  const references: Array<WebSearchReference> = [];
  const answer = answerReference(serviceResult.answer);
  if (answer !== undefined) references.push(answer);
  for (const document of serviceResult.documents) {
    const reference = await documentReference(context, document, answer !== undefined, diskWriteContext, toolCallId);
    if (reference !== undefined) references.push(reference);
  }
  return references;
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

/** Where a long document is written, when the session has a project folder and a resource to write it with. */
function diskWriteContextFor(options: WebSearchToolOptions | undefined): DiskWriteContext | undefined {
  if (options?.projectFolder === undefined || options.resourceAccessor === undefined) return undefined;
  return {
    projectFolder: options.projectFolder,
    resourceAccessor: options.resourceAccessor,
    ...(options.osPlatform === undefined ? {} : { osPlatform: options.osPlatform }),
  };
}

/** Only the fields that are set, so an options object carries exactly what it names. */
function onlySetFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
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

/** The service behind a search: the provider's answer for one request. */
type WebSearchService = (context: Context, args: WebSearchServiceRequest) => Promise<WebSearchServiceResult>

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

/** The service call behind one search: a provider failure is classified before it is thrown. */
async function runWebSearchServiceCall(innerContext: Context, normalized: WebSearchServiceRequest, webSearchService: WebSearchService, toolCallId: string, diskWriteContext: DiskWriteContext | undefined): Promise<WebSearchResult> {
  let serviceResult: WebSearchServiceResult
  try {
    serviceResult = await webSearchService(innerContext, normalized)
  } catch (error) {
    throw classifyWebSearchProviderError(error) ?? error
  }
  const references = await buildReferencesFromServiceResult(innerContext, serviceResult, toolCallId, diskWriteContext)
  return new WebSearchResult({ result: { case: "success", value: new WebSearchSuccess({ references }) } })
}

/** One search tool call: ask for it, then run it through the interaction handler. */
async function executeWebSearchCall(context: Context, interactionHandler: WebSearchInteractionHandler, args: { readonly search_term: string; readonly explanation?: string }, meta: WebSearchCallMeta, webSearchService: WebSearchService, diskWriteContext: DiskWriteContext | undefined, legacyObjectForm: boolean): Promise<WebSearchResult> {
  const normalized = normalizeArgs(args)
  const searchArgs = new WebSearchArgs({ searchTerm: normalized.searchTerm, toolCallId: meta.toolCallId })
  const response = await queryWebSearch(interactionHandler.listener, context, searchArgs).catch(error => legacyObjectForm ? Promise.reject(classifyWebSearchProviderError(error) ?? error) : Promise.reject(error))
  if (response.result.case === "rejected") throw new ToolCallRejectedError(response.result.value.reason || "User rejected the web search")
  const baseToolCall = new WebSearchToolCall({ args: searchArgs })
  return interactionHandler.executeToolCall(context, createWebSearchToolCall(baseToolCall), meta.toolCallId, innerContext => runWebSearchServiceCall(innerContext, normalized, webSearchService, meta.toolCallId, diskWriteContext), result => createWebSearchToolCall(new WebSearchToolCall({ ...baseToolCall, result })), meta.hookContextCollector)
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
async function executeOnSpan(parentContext: Context, interactionHandler: WebSearchInteractionHandler, rawArgs: { readonly search_term: string; readonly explanation?: string }, meta: WebSearchCallMeta, webSearchService: WebSearchService, diskWriteContext: DiskWriteContext | undefined, legacyObjectForm: boolean, options: WebSearchToolOptions | undefined): Promise<WebSearchResult> {
  using span = createSpan(parentContext.withName("webSearchExecute"))
  const executeCore = async (context: Context, args: { readonly search_term: string; readonly explanation?: string }): Promise<WebSearchResult> =>
    executeWebSearchCall(context, interactionHandler, args, meta, webSearchService, diskWriteContext, legacyObjectForm)
  if (options?.resourceAccessor !== undefined && Boolean(options.enableExecuteHookExec)) return runWithRemoteHooks(span.ctx, rawArgs, executeCore, meta, options)
  return executeCore(span.ctx, rawArgs)
}

/** One piece of a search result: where it came from and the text the model reads. */
interface WebSearchReference {
  readonly title: string
  readonly url: string
  readonly chunk: string
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
  const variant = options?.variant ?? "exa"
  return { webSearchService: webSearchServiceOrDependencies, version, variant, parameters: getParametersSchema(variant), options, legacyObjectForm }
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
  const variant = resolved.variant
  const parameters = resolved.parameters
  const diskWriteContext = diskWriteContextFor(resolved.options)
  const legacyObjectForm = resolved.legacyObjectForm
  const execute = async (
    parentContext: Context,
    interactionHandler: WebSearchInteractionHandler,
    rawArgs: { readonly search_term: string; readonly explanation?: string },
    meta: WebSearchCallMeta,
  ): Promise<WebSearchResult> => {
    return executeOnSpan(parentContext, interactionHandler, rawArgs, meta, webSearchService, diskWriteContext, legacyObjectForm, resolved.options);
  };
  const name = toolNameFor(version);
  return createZodAgentTool("WEB_SEARCH", webSearchToolDefinition(name, parameters, execute, version, resolved.options));
}

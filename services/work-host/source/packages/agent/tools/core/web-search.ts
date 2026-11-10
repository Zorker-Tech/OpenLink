/** Slate's search policy: call the configured service, preserve useful references, and bound their size. */

import type { Context } from "../../../context/context.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import { writeExecutorResource } from "../../../agent-exec/write-operation.ts"
import { CustomToolCallError, ToolErrorClassification } from "../tool-errors.ts"
import {
  AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES,
  describeOutputLocation,
  writeToAgentToolsFile,
} from "../../../../adapters/interop/agent/agent-tools-file-adapter.ts"

const NO_DISK_INLINE_CAP_CHARS = 30_000
const WEB_SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024
const API_REQUEST_FAILED_STATUS_REGEX = /\bAPI request failed:\s*(\d{3})\b/i

export interface WebSearchServiceResult {
  readonly answer?: string
  readonly documents: readonly { readonly title: string; readonly url: string; readonly text: string }[]
}

export interface WebSearchServiceRequest {
  readonly searchTerm: string
  readonly explanation?: string
}

export type WebSearchService = (context: Context, args: WebSearchServiceRequest) => Promise<WebSearchServiceResult>

export interface WebSearchToolOptions {
  readonly useMinimalHarness?: boolean
  readonly conversationStartedDate?: string
  readonly projectFolder?: string
  readonly osPlatform?: string
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager>
  readonly enableExecuteHookExec?: boolean
  readonly configuredSteps?: readonly string[]
  readonly model?: unknown
}

export interface WebSearchToolDependencies extends WebSearchToolOptions {
  readonly webSearchService: WebSearchService
  readonly promptVersion?: string
}

export interface WebSearchReference {
  readonly title: string
  readonly url: string
  readonly chunk: string
}

export interface WebSearchOutcome {
  readonly references: readonly WebSearchReference[]
}

interface DiskWriteContext {
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>
  readonly projectFolder: string
  readonly osPlatform?: string
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined
  return typeof error.message === "string" ? error.message : undefined
}

function providerFailureMessages(error: unknown): string[] {
  const direct = getErrorMessage(error)
  const cause = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined
  const fromCause = getErrorMessage(cause)
  return [direct, fromCause].filter((message): message is string => message !== undefined)
}

function retryableProviderStatus(error: unknown): { readonly message: string; readonly status: number } | undefined {
  for (const message of providerFailureMessages(error)) {
    const match = API_REQUEST_FAILED_STATUS_REGEX.exec(message)
    if (match === null) continue
    const status = Number(match[1])
    if (Number.isFinite(status) && (status === 429 || status >= 500)) return { message, status }
  }
  return undefined
}

export function classifyWebSearchProviderError(error: unknown): CustomToolCallError | undefined {
  const found = retryableProviderStatus(error)
  if (found === undefined) return undefined
  const message = "The web search provider returned an error; this may be temporary. Please try again."
  return new CustomToolCallError(ToolErrorClassification.PROVIDER_ERROR, {
    clientVisibleErrorMessage: message,
    modelVisibleErrorMessage: message,
    error: `${found.message}. provider_status=${found.status}`,
  })
}

function onlySetFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>
}

function diskWriteContextFor(options: WebSearchToolOptions): DiskWriteContext | undefined {
  if (options.projectFolder === undefined || options.resourceAccessor === undefined) return undefined
  return {
    projectFolder: options.projectFolder,
    resourceAccessor: options.resourceAccessor,
    ...(options.osPlatform === undefined ? {} : { osPlatform: options.osPlatform }),
  }
}

function answerReference(answer: string | undefined): WebSearchReference | undefined {
  if (answer === undefined || answer === "") return undefined
  return { title: "Web search results", url: "", chunk: answer }
}

async function documentReference(
  context: Context,
  document: { readonly title: string; readonly url: string; readonly text: string },
  hasAnswer: boolean,
  diskWriteContext: DiskWriteContext | undefined,
  toolCallId: string,
): Promise<WebSearchReference | undefined> {
  if (diskWriteContext !== undefined && Buffer.byteLength(document.text, "utf8") > AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES) {
    const outputLocation = await writeToAgentToolsFile(context, diskWriteContext.resourceAccessor.get(writeExecutorResource), {
      content: document.text,
      projectDir: diskWriteContext.projectFolder,
      osPlatform: diskWriteContext.osPlatform,
      toolCallId,
      maxSize: WEB_SEARCH_MAX_FILE_SIZE,
    })
    if (outputLocation !== undefined) {
      return {
        title: document.title,
        url: document.url,
        chunk: `${describeOutputLocation(outputLocation, { leadText: "Full page text" })}\nUse shell / grep / read_file on this path to inspect the page; no follow-up fetch is needed.`,
      }
    }
  }
  if (hasAnswer) return undefined
  return { title: document.title, url: document.url, chunk: document.text.slice(0, NO_DISK_INLINE_CAP_CHARS) }
}

async function serviceReferences(
  context: Context,
  result: WebSearchServiceResult,
  toolCallId: string,
  diskWriteContext: DiskWriteContext | undefined,
): Promise<Array<WebSearchReference>> {
  const references: Array<WebSearchReference> = []
  const answer = answerReference(result.answer)
  if (answer !== undefined) references.push(answer)
  for (const document of result.documents) {
    const reference = await documentReference(context, document, answer !== undefined, diskWriteContext, toolCallId)
    if (reference !== undefined) references.push(reference)
  }
  return references
}

/** Runs one approved search and turns the provider response into Slate-owned references. */
export async function performWebSearch(
  context: Context,
  request: WebSearchServiceRequest,
  toolCallId: string,
  service: WebSearchService,
  options: WebSearchToolOptions,
): Promise<WebSearchOutcome> {
  let response: WebSearchServiceResult
  try {
    response = await service(context, onlySetFields(request) as WebSearchServiceRequest)
  } catch (error) {
    throw classifyWebSearchProviderError(error) ?? error
  }
  return { references: await serviceReferences(context, response, toolCallId, diskWriteContextFor(options)) }
}

/** Text supplied to the agent for one source it can cite or inspect. */
export function renderWebSearchReferences(references: readonly WebSearchReference[]): string {
  return references.map(reference => {
    const urlLine = reference.url.length > 0 ? `URL: ${reference.url}` : ""
    return `Title: ${reference.title}${urlLine.length === 0 ? "" : "\n" + urlLine}\nContent: ${reference.chunk}\n---\n`
  }).join("\n")
}

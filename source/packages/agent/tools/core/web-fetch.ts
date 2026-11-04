/** Slate's page-fetch policy: validate the destination, honor consent upstream, and return an honest content outcome. */

import type { Context } from "../../../context/context.ts"
import type { ResourceAccessor } from "../../../agent-exec/resource-provider.ts"
import type { RemoteExecManager } from "../../../agent-exec/executor-resources.ts"
import { writeExecutorResource } from "../../../agent-exec/write-operation.ts"
import { ToolCallArgParseError, ToolTimeoutError } from "../tool-support.ts"
import { isLoopbackIpHost, isPrivateIpHost } from "../../utils/ip-addresses.ts"
import { writeToAgentToolsFile, AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES } from "../../../../adapters/interop/agent/agent-tools-file-adapter.ts"

const MAX_CONTENT_SIZE = 100_000

export interface WebFetchServiceResult {
  readonly content?: string | undefined
  readonly error?: string | undefined
  readonly isTimeout?: boolean | undefined
}

export interface WebFetchBehaviorDependencies {
  readonly webFetchService: (context: Context, url: string) => Promise<WebFetchServiceResult>
  readonly projectFolder?: string | undefined
  readonly osPlatform?: string | undefined
  readonly resourceAccessor?: ResourceAccessor<RemoteExecManager> | undefined
  readonly stripCredentialedUrls?: boolean | undefined
}

export type WebFetchPageOutcome =
  | { readonly kind: "success"; readonly url: string; readonly markdown: string; readonly outputLocation?: unknown | undefined }
  | { readonly kind: "error"; readonly url: string; readonly error: string }

function localAddressRejection(url: URL): string | undefined {
  const host = url.hostname.toLowerCase()
  const display = url.port.length > 0 ? `${host}:${url.port}` : host
  if (host === "localhost" || host.endsWith(".localhost") || isLoopbackIpHost(host)) return `Cannot fetch from localhost (${display}) because this tool runs from an isolated server.`
  if (isPrivateIpHost(host)) return `Cannot fetch from private IP (${display}) because this tool runs from an isolated server.`
  return undefined
}

function removeUrlCredentials(url: string, enabled: boolean): string {
  if (!enabled) return url
  try {
    const targetUrlObject = new URL(url)
    if (targetUrlObject.username.length === 0 && targetUrlObject.password.length === 0) return url
    targetUrlObject.username = ""
    targetUrlObject.password = ""
    return targetUrlObject.toString()
  } catch {
    return url
  }
}

export function prepareWebFetchUrl(rawUrl: string, stripCredentials: boolean): string {
  const url = removeUrlCredentials(rawUrl, stripCredentials)
  let targetUrlObject: URL
  try { targetUrlObject = new URL(url) } catch { throw new ToolCallArgParseError("Invalid URL: must include http:// or https://") }
  if (targetUrlObject.protocol !== "http:" && targetUrlObject.protocol !== "https:") {
    throw new ToolCallArgParseError(`Invalid URL protocol: ${targetUrlObject.protocol} (must be http or https)`)
  }
  const localRejection = localAddressRejection(targetUrlObject)
  if (localRejection !== undefined) throw new ToolCallArgParseError(localRejection)
  return url
}

function clipLongContent(pageContent: string): string {
  if (pageContent.length <= MAX_CONTENT_SIZE) return pageContent
  const omitted = pageContent.slice(MAX_CONTENT_SIZE)
  const lines = (omitted.match(/\n/g) ?? []).length + 1
  return `${pageContent.slice(0, MAX_CONTENT_SIZE)}\n\n...[${lines} line${lines === 1 ? "" : "s"} truncated]`
}

export async function fetchWebPage(
  context: Context,
  url: string,
  toolCallId: string,
  dependencies: WebFetchBehaviorDependencies,
): Promise<WebFetchPageOutcome> {
  const serviceResult = await dependencies.webFetchService(context, url)
  if (serviceResult.error !== undefined) {
    if (serviceResult.isTimeout === true) {
      throw new ToolTimeoutError({
        clientVisibleErrorMessage: serviceResult.error,
        modelVisibleErrorMessage: serviceResult.error,
        error: serviceResult.error,
      })
    }
    return { kind: "error", url, error: serviceResult.error }
  }
  const pageContent = serviceResult.content ?? ""
  if (
    dependencies.projectFolder !== undefined &&
    dependencies.resourceAccessor !== undefined &&
    Buffer.byteLength(pageContent, "utf8") > AGENT_TOOLS_FILE_WRITE_THRESHOLD_BYTES
  ) {
    const outputLocation = await writeToAgentToolsFile(
      context,
      dependencies.resourceAccessor.get(writeExecutorResource),
      {
        content: pageContent,
        projectDir: dependencies.projectFolder,
        osPlatform: dependencies.osPlatform,
        toolCallId,
      },
    )
    if (outputLocation !== undefined) return { kind: "success", url, markdown: pageContent, outputLocation }
  }
  return { kind: "success", url, markdown: clipLongContent(pageContent) }
}

export function webFetchDescription(useMinimalHarness: boolean): string {
  if (useMinimalHarness) return "Fetch content from a URL and return it as readable markdown. Prefer this over shell for web content because shell egress is more restricted."
  return `Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze webpage content.

- The URL must be a fully-formed, valid URL.
- This tool is read-only and will not work for requests intended to have side effects.
- This fetch tries to return live results but may return previously cached content.
- Authentication is not supported, and an error will be returned if the URL requires authentication.
- If the URL is returning a non-200 status code, the tool will not return the content and will instead return an error message.
- This fetch runs from an isolated server. Hosts like localhost or private IPs will not work.
- This tool does not support fetching binary content, e.g. media or PDFs.
`
}

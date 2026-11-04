import path from "node:path"

import { asyncMapValues } from "../../utils/promise-tools.ts"
import { sanitizeFilename } from "../../utils/managed-paths.ts"

const FETCH_CONCURRENCY = 4
const INLINE_CONTENT_LIMIT = 20_000
const FILE_CONTENT_LIMIT = 500_000

export interface ExternalLinkPage {
  readonly pageUrl: string
  readonly pageTitle: string
  readonly partialParsedPageContents: string
  readonly imageData?: Uint8Array
  readonly imageMimeType?: string
}

export interface ExternalLinkEnrichmentResult {
  readonly links: readonly { readonly url: string; readonly title: string; readonly content: string }[]
  readonly documents: readonly { readonly path: string }[]
  readonly images: readonly { readonly imageBytes: Uint8Array; readonly mimeType: string }[]
}

export interface ExternalLinkEnrichmentInput {
  readonly urls: readonly string[]
  readonly fetchPage: (url: string) => Promise<ExternalLinkPage | null>
  readonly workspaceRoot?: string
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<unknown>
  readonly onWriteFailure?: (url: string, error: unknown) => void
}

type EnrichedLink =
  | { readonly kind: "inline"; readonly value: { readonly url: string; readonly title: string; readonly content: string } }
  | { readonly kind: "document"; readonly value: { readonly path: string } }
  | { readonly kind: "image"; readonly value: { readonly imageBytes: Uint8Array; readonly mimeType: string } }
  | { readonly kind: "empty" }

function readableName(pageUrl: string, index: number): string {
  let basename: string
  try {
    const parsed = new URL(pageUrl)
    basename = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname)
  } catch {
    basename = "link"
  }
  const sourceName = /\.(md|txt|html|htm|json|xml|csv|tsv|yaml|yml|rst|tex|log)$/i.test(basename)
    ? basename
    : `${basename}.md`
  const safe = sanitizeFilename(sourceName) || "link.md"
  const suffixIndex = safe.lastIndexOf(".")
  return `${safe.slice(0, suffixIndex)}-${index}${safe.slice(suffixIndex)}`
}

function withSizeNote(content: string, limit: number): string {
  if (content.length <= limit) return content
  const remainder = (content.length - limit).toLocaleString()
  return `${content.slice(0, limit)}\n\n[${remainder} characters truncated due to size]`
}

async function enrichOne(input: ExternalLinkEnrichmentInput, url: string, index: number): Promise<EnrichedLink> {
  const page = await input.fetchPage(url)
  if (page === null) return { kind: "empty" }
  if (page.imageData && page.imageData.length > 0 && page.imageMimeType) {
    return { kind: "image", value: { imageBytes: page.imageData, mimeType: page.imageMimeType } }
  }
  if (page.partialParsedPageContents.length <= INLINE_CONTENT_LIMIT) {
    return { kind: "inline", value: { url: page.pageUrl, title: page.pageTitle, content: page.partialParsedPageContents } }
  }

  if (input.writeFile !== undefined && input.workspaceRoot !== undefined) {
    const filePath = path.join(input.workspaceRoot, "uploads", readableName(page.pageUrl, index))
    const content = withSizeNote(page.partialParsedPageContents, FILE_CONTENT_LIMIT)
    const bytes = new TextEncoder().encode(`Source URL: ${page.pageUrl}\nTitle: ${page.pageTitle}\n\n${content}`)
    try {
      await input.writeFile(filePath, bytes)
      return { kind: "document", value: { path: filePath } }
    } catch (error) {
      input.onWriteFailure?.(page.pageUrl, error)
    }
  }

  return {
    kind: "inline",
    value: { url: page.pageUrl, title: page.pageTitle, content: withSizeNote(page.partialParsedPageContents, INLINE_CONTENT_LIMIT) },
  }
}

/** Fetches links with a bounded fan-out and separates their prompt, file and image results. */
export async function enrichExternalLinks(input: ExternalLinkEnrichmentInput): Promise<ExternalLinkEnrichmentResult> {
  if (input.urls.length === 0) return { links: [], documents: [], images: [] }
  const indexed = input.urls.map((url, index) => ({ url, index }))
  const enriched = await asyncMapValues(indexed, ({ url, index }) => enrichOne(input, url, index), { max: FETCH_CONCURRENCY })
  const links: { url: string; title: string; content: string }[] = []
  const documents: { path: string }[] = []
  const images: { imageBytes: Uint8Array; mimeType: string }[] = []
  for (const item of enriched) {
    if (item.kind === "inline") links.push(item.value)
    else if (item.kind === "document") documents.push(item.value)
    else if (item.kind === "image") images.push(item.value)
  }
  return { links, documents, images }
}

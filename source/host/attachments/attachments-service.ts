/**
 * What an agent can attach, and what the host can read back.
 *
 * Four things live here. A link preview: a page is fetched once, scraped for what it says about itself, and kept for a
 * day — never for a page that turns out to be a sign-in wall, and never for something that is not a page. An
 * attachment: bytes that are written once under their own hash, so the same file attached twice is one file, and a
 * file the user already put in place is left exactly where it is. Reads: images, videos, text previews and byte
 * ranges, each answering nothing rather than something the caller may not see. And the service the rest of the host
 * talks to, which knows whose attachment it is from the path itself.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACHMENTS_DIRNAME, ASSETS_DIRNAME, getAgentAssetsDir, getAgentAttachmentsDir } from "./attachment-paths.ts";
import { resolveChannelAttachment } from "../connectors/channel-attachment.ts";
import { uploadBoxFiles } from "../boxes/box-transfer.ts";
import { getSlateRootDir, reanchorSlatePath } from "../host-paths.ts";
import { resolveSlateAgentDir } from "../storage/agent-paths.ts";
import { isSafeFolderId } from "../storage/folder-id.ts";
import { AttachmentTooLargeError, attachmentByteLimitForName, VIDEO_BYTE_LIMIT } from "../../shared/media/attachment-limits.ts";
import { audioMimeFromPath, extensionFromImageMime, imageMimeFromPath, servableImageMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.ts";
import { Mp4Dimensions } from "../../shared/media/video-dimensions.ts";
import { isPathWithin } from "../../shared/node/paths.ts";
import { createAgentImageResourcePort } from "./generate-image-resource-accessor.ts";
import { createSlateGenerateImageService, type GenerateImageAuth } from "./generate-image-service.ts";
import { stageAttachmentsForAgent, type BoxAttachmentStagingPorts } from "./box-staging.ts";
import { readEncodedImageSize, type ImageSize } from "./link-preview-image-bounds.ts";
import { fetchSafeLinkPreviewResource, parseSafeLinkPreviewUrl, SlateLinkPreviewError } from "./safe-link-preview-fetch.ts";
import { withVideoPlaybackSource } from "./video-playback-rendition.ts";

export const LINK_CACHE_DIRNAME = "link-cache";
/** Bumped whenever what a cached preview holds changes, so an older entry is re-fetched rather than misread. */
export const LINK_CACHE_VERSION = 3;
export const LINK_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const LINK_HTML_BYTE_LIMIT = 512 * 1024;
export const LINK_IMAGE_BYTE_LIMIT = 2 * 1024 * 1024;
export const LINK_TITLE_CHAR_LIMIT = 512;
export const LINK_DESCRIPTION_CHAR_LIMIT = 2_048;
export const LINK_SITE_NAME_CHAR_LIMIT = 256;
export const LINK_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/x-icon", "image/vnd.microsoft.icon"]);
export const LINK_IMAGE_ACCEPT = [...LINK_IMAGE_MIME_TYPES].join(",");
export const ATTACHMENT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_TEXT_PREVIEW_BYTE_CAP = 64 * 1024;
export const VIDEO_DIMENSIONS_HEAD_BYTES = 1024 * 1024;
export const VIDEO_DIMENSIONS_TAIL_BYTES = 8 * 1024 * 1024;

export class SlateAttachmentError extends Error {}

export interface IngestedAttachment {
  readonly absolutePath: string;
  readonly hash: string;
  readonly bytes: number;
}

export interface LinkMetadata extends Record<string, unknown> {
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly description: string;
  readonly siteName: string;
  readonly hostname: string;
  readonly imageDataUrl: string | null;
  readonly faviconDataUrl: string | null;
  readonly fetchedAt: number;
}

const AUTH_HOSTNAMES = new Set(["accounts.google.com"]);
const AUTH_HOST_LABELS = new Set(["auth", "authenticate", "authentication", "authenticator", "idp", "identity", "login", "oauth", "signin", "sso"]);
const AUTH_PATH_SEGMENTS = new Set(["auth", "authenticate", "authorize", "login", "saml", "sign-in", "sign_in", "signin", "sso"]);
const NESTED_AUTH_PATHS = new Set(["sign-in/identifier", "sign_in/identifier", "signin/identifier"]);

/** Everything a text preview may be read from, by the name it has. */
const TEXT_EXTENSIONS = new Set(["txt", "text", "log", "md", "markdown", "mdx", "rst", "adoc", "tex", "json", "jsonc", "json5", "ndjson", "csv", "tsv", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "plist", "gradle", "html", "htm", "css", "scss", "sass", "less", "svg", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "swift", "scala", "dart", "lua", "pl", "pm", "r", "sql", "graphql", "gql", "proto", "vue", "svelte", "astro", "sh", "bash", "zsh", "fish", "bat", "ps1", "tf", "tfvars", "dockerfile", "diff", "patch"]);

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

async function makeDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

/** A file that is already there is the same file: nothing is written over a hash that exists. */
async function writeHashedFile(directory: string, destination: string, content: Buffer): Promise<void> {
  await makeDir(directory);
  try {
    await fs.access(destination);
  } catch {
    await fs.writeFile(destination, content);
  }
}

function cachePathFor(agentDirectory: string, url: string): string {
  return join(agentDirectory, LINK_CACHE_DIRNAME, `${sha256(url)}.json`);
}

async function readCachedMetadata(agentDirectory: string, url: string): Promise<LinkMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePathFor(agentDirectory, url), "utf8")) as LinkMetadata & { cacheVersion?: number };
    if (parsed.cacheVersion !== LINK_CACHE_VERSION) return null;
    if (Date.now() - parsed.fetchedAt > LINK_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedMetadata(agentDirectory: string, url: string, metadata: LinkMetadata): Promise<void> {
  const entry = { ...metadata, cacheVersion: LINK_CACHE_VERSION };
  const cachePath = cachePathFor(agentDirectory, url);
  await makeDir(dirname(cachePath));
  await fs.writeFile(cachePath, JSON.stringify(entry, null, 2));
}

/** What the preview previewFetcher answers with, and what a caller may hand in instead of the real one. */
export type LinkPreviewFetcher = typeof fetchSafeLinkPreviewResource;

async function fetchPreviewHtml(url: string, byteCap: number, previewFetcher: LinkPreviewFetcher): Promise<{ body: string; finalUrl: URL; redirectUrls: URL[]; contentType: string }> {
  const response = await previewFetcher(url, {
    maxBytes: byteCap,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
    truncateAtByteLimit: true,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) throw new SlateLinkPreviewError(`HTTP ${response.statusCode} while fetching link preview.`);
  return {
    body: response.body.toString("utf8"),
    finalUrl: parseSafeLinkPreviewUrl(response.finalUrl),
    redirectUrls: response.redirectUrls.map((redirect) => parseSafeLinkPreviewUrl(redirect)),
    contentType: (response.headers["content-type"] ?? "") as string,
  };
}

/** An image the page points at, as a data url — or nothing, which is a preview without one. */
async function fetchImageDataUrl(url: string, previewFetcher: LinkPreviewFetcher): Promise<string | null> {
  let response;
  try {
    response = await previewFetcher(url, { maxBytes: LINK_IMAGE_BYTE_LIMIT, accept: LINK_IMAGE_ACCEPT });
  } catch {
    return null;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const mime = ((response.headers["content-type"] ?? "") as string).split(";")[0]?.trim().toLowerCase() ?? "";
  if (!LINK_IMAGE_MIME_TYPES.has(mime)) return null;
  if (response.body.byteLength === 0 || response.body.byteLength > LINK_IMAGE_BYTE_LIMIT) return null;
  return `data:${mime};base64,${response.body.toString("base64")}`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|#38);/gi, "&")
    .replace(/&(lt|#60);/gi, "<")
    .replace(/&(gt|#62);/gi, ">")
    .replace(/&(quot|#34);/gi, '"')
    .replace(/&(apos|#39);/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** What a page said about itself, as text the surfaces can show: no control characters, one space, bounded. */
function cleanMetadataText(text: string, charLimit: number): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, charLimit);
}

function attributeValue(tag: string, attr: string): string | undefined {
  const match = new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (match == null) return undefined;
  return match[2] ?? match[3] ?? match[4];
}

function metaContent(html: string, attr: string, value: string): string | undefined {
  const tagPattern = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(html)) != null) {
    const candidate = attributeValue(tag[0], attr);
    if (candidate == null || candidate.toLowerCase() !== value.toLowerCase()) continue;
    const content = attributeValue(tag[0], "content");
    if (content != null) return decodeEntities(content).trim();
  }
  return undefined;
}

function firstLinkHref(html: string, relValues: readonly string[]): string | undefined {
  const tagPattern = /<link\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(html)) != null) {
    const rel = attributeValue(tag[0], "rel");
    if (rel == null) continue;
    const tokens = rel.toLowerCase().split(/\s+/);
    if (!relValues.some((value) => tokens.includes(value))) continue;
    const href = attributeValue(tag[0], "href");
    if (href != null) return decodeEntities(href).trim();
  }
  return undefined;
}

function pageTitle(html: string): string | undefined {
  const match = /<title>([^<]*)<\/title>/i.exec(html);
  return match == null ? undefined : decodeEntities(match[1] ?? "").trim();
}

function absoluteUrl(href: string, base: string): string | null {
  try {
    return parseSafeLinkPreviewUrl(new URL(href, base).toString()).toString();
  } catch {
    return null;
  }
}

/** What a page says about itself: its own words first, then the social ones, then its title. */
function scrapeMetadata(html: string, finalUrl: string) {
  const title = metaContent(html, "property", "og:title") ?? metaContent(html, "name", "twitter:title") ?? pageTitle(html) ?? "";
  const description = metaContent(html, "property", "og:description") ?? metaContent(html, "name", "description") ?? metaContent(html, "name", "twitter:description") ?? "";
  const siteName = metaContent(html, "property", "og:site_name") ?? metaContent(html, "name", "application-name") ?? "";
  const canonical = firstLinkHref(html, ["canonical"]) ?? metaContent(html, "property", "og:url") ?? finalUrl;
  const image = metaContent(html, "property", "og:image") ?? metaContent(html, "property", "og:image:url") ?? metaContent(html, "name", "twitter:image") ?? metaContent(html, "name", "twitter:image:src") ?? null;
  const favicon = firstLinkHref(html, ["icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon"]) ?? null;
  return {
    title: cleanMetadataText(title, LINK_TITLE_CHAR_LIMIT),
    description: cleanMetadataText(description, LINK_DESCRIPTION_CHAR_LIMIT),
    siteName: cleanMetadataText(siteName, LINK_SITE_NAME_CHAR_LIMIT),
    canonicalUrl: absoluteUrl(canonical, finalUrl) ?? finalUrl,
    imageUrl: image == null ? null : absoluteUrl(image, finalUrl),
    faviconUrl: favicon == null ? null : absoluteUrl(favicon, finalUrl),
  };
}

/** Where a page without a favicon of its own gets one. */
function faviconServiceUrl(hostname: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
}

function normalizePreviewUrl(raw: string): URL | null {
  try {
    return parseSafeLinkPreviewUrl(raw.trim());
  } catch {
    return null;
  }
}

function authPathSegment(url: URL): boolean {
  try {
    const pathParts = url.pathname.split("/").filter((segment) => segment.length > 0).map((segment) => decodeURIComponent(segment).toLowerCase());
    const finalSegment = pathParts.at(-1);
    if (finalSegment != null && AUTH_PATH_SEGMENTS.has(finalSegment)) return true;
    return pathParts.some((segment, index) => NESTED_AUTH_PATHS.has(`${segment}/${pathParts[index + 1] ?? ""}`));
  } catch {
    return false;
  }
}

/** Whether a page is a sign-in wall: a preview of one is a preview of nothing a user meant to share. */
function authDestination(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  if (AUTH_HOSTNAMES.has(hostname) || hostname.split(".").some((label) => AUTH_HOST_LABELS.has(label))) return true;
  return authPathSegment(url);
}

export async function fetchLinkMetadata(agentDirectory: string, rawUrl: string, previewFetcher: LinkPreviewFetcher = fetchSafeLinkPreviewResource): Promise<LinkMetadata | null> {
  const url = normalizePreviewUrl(rawUrl);
  if (url == null) return null;
  const cached = await readCachedMetadata(agentDirectory, url.toString());
  if (cached != null) return cached;
  let fetched: Awaited<ReturnType<typeof fetchPreviewHtml>>;
  try {
    fetched = await fetchPreviewHtml(url.toString(), LINK_HTML_BYTE_LIMIT, previewFetcher);
  } catch {
    return null;
  }
  // A redirect through a sign-in page is a sign-in page, whatever the address asked for.
  if (fetched.redirectUrls.some(authDestination)) return null;
  const lowerType = fetched.contentType.toLowerCase();
  if (fetched.contentType.length > 0 && !lowerType.includes("html") && !lowerType.includes("xml")) return null;
  const scraped = scrapeMetadata(fetched.body, fetched.finalUrl.toString());
  const hostname = fetched.finalUrl.hostname;
  const [imageDataUrl, faviconDataUrl] = await Promise.all([
    scraped.imageUrl == null ? null : fetchImageDataUrl(scraped.imageUrl, previewFetcher),
    (async () => {
      const direct = scraped.faviconUrl == null ? null : await fetchImageDataUrl(scraped.faviconUrl, previewFetcher);
      if (direct != null) return direct;
      return await fetchImageDataUrl(faviconServiceUrl(hostname), previewFetcher);
    })(),
  ]);
  const metadata: LinkMetadata = { url: url.toString(), canonicalUrl: scraped.canonicalUrl, title: scraped.title, description: scraped.description, siteName: scraped.siteName, hostname, imageDataUrl, faviconDataUrl, fetchedAt: Date.now() };
  try {
    await writeCachedMetadata(agentDirectory, url.toString(), metadata);
  } catch {}
  return metadata;
}

/** A file the user put in the attachments folder themselves is already where it belongs. */
export async function ingestAttachment(agentDirectory: string, sourceFile: string): Promise<IngestedAttachment> {
  if (typeof sourceFile !== "string" || sourceFile.trim().length === 0) throw new SlateAttachmentError("Attachment file path is empty.");
  if (!isAbsolute(sourceFile)) throw new SlateAttachmentError(`Attachment path must be absolute: ${sourceFile}`);
  const attachmentsDir = getAgentAttachmentsDir(agentDirectory);
  if (isPathWithin(attachmentsDir, sourceFile, { isInclusive: true })) {
    const stats = await fs.stat(sourceFile);
    return { absolutePath: sourceFile, hash: "preserved", bytes: stats.size };
  }
  const stats = await fs.stat(sourceFile);
  if (!stats.isFile()) throw new SlateAttachmentError(`Attachment source is not a file: ${sourceFile}`);
  const byteCap = attachmentByteLimitForName(sourceFile);
  if (stats.size > byteCap) throw new AttachmentTooLargeError(byteCap);
  return await ingestAttachmentBytes(agentDirectory, sourceFile, await fs.readFile(sourceFile));
}

/** The bytes of an attachment, kept under their own hash: attaching the same file twice is one file. */
export async function ingestAttachmentBytes(agentDirectory: string, filename: string, data: Uint8Array): Promise<IngestedAttachment> {
  if (typeof filename !== "string" || filename.trim().length === 0) throw new SlateAttachmentError("Attachment filename is empty.");
  if (data.byteLength === 0) throw new SlateAttachmentError("Attachment is empty.");
  const byteCap = attachmentByteLimitForName(filename);
  if (data.byteLength > byteCap) throw new AttachmentTooLargeError(byteCap);
  const content = Buffer.from(data);
  const hash = sha256(content);
  const extension = extname(filename).toLowerCase();
  const destination = join(getAgentAttachmentsDir(agentDirectory), `${hash}${extension.length > 0 ? extension : ".bin"}`);
  await writeHashedFile(getAgentAttachmentsDir(agentDirectory), destination, content);
  return { absolutePath: destination, hash, bytes: content.byteLength };
}

function imageDimensionsOf(content: Buffer, mime: string): ImageSize | null {
  return readEncodedImageSize(`data:${mime};base64,${content.toString("base64")}`);
}

export async function readHostAttachmentImage(attachmentFile: string) {
  const absolute = reanchorSlatePath(attachmentFile);
  // A read the platform may not make answers nothing rather than reading it anyway.
  if (!attachmentFile || !isPathWithin(getSlateRootDir(), absolute)) return null;
  const mime = servableImageMimeFromPath(absolute);
  if (mime == null) return null;
  try {
    const data = await fs.readFile(absolute);
    const size = imageDimensionsOf(data, mime);
    return { dataUrl: `data:${mime};base64,${data.toString("base64")}`, width: size?.width ?? null, height: size?.height ?? null };
  } catch {
    return null;
  }
}

export async function readHostAttachmentVideoBytes(attachmentFile: string): Promise<Uint8Array | null> {
  const absolute = reanchorSlatePath(attachmentFile);
  if (!attachmentFile || !isPathWithin(getSlateRootDir(), absolute) || videoMimeFromPath(absolute) === undefined) return null;
  try {
    const stats = await fs.stat(absolute);
    // A video the platform will not carry whole is not one it hands over at all.
    return !stats.isFile() || stats.size > VIDEO_BYTE_LIMIT ? null : new Uint8Array(await fs.readFile(absolute));
  } catch {
    return null;
  }
}

export async function readHostAttachmentChunk(agentDirectory: string, attachmentFile: string, offset: number, length: number, playback = false) {
  if (!attachmentFile) return null;
  const source = reanchorSlatePath(attachmentFile);
  if (!isPathWithin(getAgentAttachmentsDir(agentDirectory), source) && !isPathWithin(getAgentAssetsDir(agentDirectory), source)) return null;
  if (playback && videoMimeFromPath(source) == null) return null;
  const read = async (absolute: string) => {
    const stats = await fs.stat(absolute);
    if (!stats.isFile()) return null;
    const totalSize = stats.size;
    const mime = imageMimeFromPath(absolute) ?? videoMimeFromPath(absolute) ?? audioMimeFromPath(absolute) ?? null;
    // An offset or a length nobody can use is clamped rather than refused; both are sizes, and neither is negative.
    const start = Math.min(Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0, totalSize);
    const safeLength = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0;
    const wanted = Math.min(safeLength, ATTACHMENT_CHUNK_MAX_BYTES, totalSize - start);
    if (wanted <= 0) return { bytesBase64: "", totalSize, mime };
    const handle = await fs.open(absolute, "r");
    try {
      const content = Buffer.alloc(wanted);
      const { bytesRead } = await handle.read(content, 0, wanted, start);
      return { bytesBase64: content.subarray(0, bytesRead).toString("base64"), totalSize, mime };
    } finally {
      await handle.close();
    }
  };
  try {
    return playback ? await withVideoPlaybackSource(source, read) : await read(source);
  } catch {
    return null;
  }
}

/** Whose attachment a path is, read off the path itself rather than guessed from what is signed in. */
export function resolveAttachmentOwnerDir(attachmentFile: string): string | null {
  if (!attachmentFile) return null;
  const absolute = reanchorSlatePath(attachmentFile);
  const agentsRoot = join(getSlateRootDir(), "agents");
  if (!isPathWithin(agentsRoot, absolute)) return null;
  const pathParts = relative(agentsRoot, absolute).split(sep);
  const agentId = pathParts[0];
  const folderName = pathParts[1];
  return pathParts.length >= 3 && isSafeFolderId(agentId) && (folderName === ATTACHMENTS_DIRNAME || folderName === ASSETS_DIRNAME) ? join(agentsRoot, agentId) : null;
}

function textPreviewable(path: string): boolean {
  const extension = extname(path).slice(1).toLowerCase();
  return extension.length > 0 && TEXT_EXTENSIONS.has(extension);
}

/** A file with a control character or a NUL this early in it is not one to render as text. */
function binarySample(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8 * 1024);
  if (sample.byteLength === 0) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 32 && !(byte >= 9 && byte <= 13)) controls += 1;
  }
  return controls / sample.byteLength > 0.3;
}

export async function readAttachmentText(agentDirectory: string, attachmentFile: string) {
  const absolute = reanchorSlatePath(attachmentFile);
  if (!attachmentFile || !isPathWithin(getAgentAttachmentsDir(agentDirectory), absolute)) return null;
  try {
    const stats = await fs.stat(absolute);
    if (!stats.isFile()) return null;
    // A file this platform would not preview as text is reported as what it is, with its size.
    if (!textPreviewable(absolute)) return { kind: "binary" as const, bytes: stats.size };
    const handle = await fs.open(absolute, "r");
    let headBytes: Buffer;
    try {
      headBytes = Buffer.alloc(ATTACHMENT_TEXT_PREVIEW_BYTE_CAP);
      const ingested = await handle.read(headBytes, 0, headBytes.length, 0);
      headBytes = headBytes.subarray(0, ingested.bytesRead);
    } finally {
      await handle.close();
    }
    return binarySample(headBytes) ? { kind: "binary" as const, bytes: stats.size } : { kind: "text" as const, text: headBytes.toString("utf8"), truncated: stats.size > ATTACHMENT_TEXT_PREVIEW_BYTE_CAP, bytes: stats.size };
  } catch {
    return null;
  }
}

export async function readImageDimensions(attachmentFile: string): Promise<ImageSize | null> {
  const absolute = reanchorSlatePath(attachmentFile);
  const mime = servableImageMimeFromPath(absolute);
  if (mime == null) return null;
  try {
    return imageDimensionsOf(await fs.readFile(absolute), mime);
  } catch {
    return null;
  }
}

export { Mp4Dimensions };

/** A video's dimensions, read from its headBytes and — when the header is not there — from its tailBytes. */
export async function readVideoDimensions(attachmentFile: string): Promise<ImageSize | null> {
  const absolute = reanchorSlatePath(attachmentFile);
  if (!isPathWithin(getSlateRootDir(), absolute) || videoMimeFromPath(absolute) === undefined) return null;
  try {
    const handle = await fs.open(absolute, "r");
    try {
      const { size } = await handle.stat();
      const headLength = Math.min(size, VIDEO_DIMENSIONS_HEAD_BYTES);
      const headBytes = Buffer.alloc(headLength);
      await handle.read(headBytes, 0, headLength, 0);
      const fromHead = Mp4Dimensions.read(headBytes);
      if (fromHead != null || size <= headLength) return fromHead;
      const tailLength = Math.min(size, VIDEO_DIMENSIONS_TAIL_BYTES);
      const tailBytes = Buffer.alloc(tailLength);
      await handle.read(tailBytes, 0, tailLength, size - tailLength);
      return Mp4Dimensions.read(tailBytes);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function readMediaDimensions(attachmentFile: string): Promise<ImageSize | null> {
  const absolute = reanchorSlatePath(attachmentFile);
  if (!isPathWithin(getSlateRootDir(), absolute)) return null;
  if (servableImageMimeFromPath(absolute) != null) return readImageDimensions(absolute);
  if (videoMimeFromPath(absolute) !== undefined) return readVideoDimensions(absolute);
  return null;
}

/** A generated picture, kept under its own hash like any other attachment. */
export async function persistImageBytes(destinationDirectory: string, data: Uint8Array, contentMime: string) {
  const content = Buffer.from(data);
  const hash = sha256(content);
  const destination = join(destinationDirectory, `${hash}${extensionFromImageMime(contentMime) ?? ".png"}`);
  await writeHashedFile(destinationDirectory, destination, content);
  const size = imageDimensionsOf(content, contentMime);
  return { absolutePath: destination, fileUrl: pathToFileURL(destination).href, bytes: content.byteLength, width: size?.width ?? null, height: size?.height ?? null };
}

export interface AttachmentsServiceDependencies<Context> {
  readonly auth: GenerateImageAuth;
  readonly ctx: Context;
  readonly box: BoxAttachmentStagingPorts<Context>["box"];
  readonly report?: (diagnostic: Record<string, unknown>) => void;
}

export function createAttachmentsService<Context>(deps: AttachmentsServiceDependencies<Context>) {
  let fallbackAgentId: string | null = null;
  /** Which agent an attachment without an owner of its own belongs to: the one that is active, or none. */
  const resolveDir = (agentId?: string | null): string => {
    const id = agentId ?? fallbackAgentId;
    if (!id) throw new SlateAttachmentError("No active agent to attach to.");
    return resolveSlateAgentDir(id);
  };
  const readDir = (path: string, agentId?: string | null): string | null => resolveAttachmentOwnerDir(path) ?? (() => {
    try {
      return resolveDir(agentId);
    } catch {
      return null;
    }
  })();
  return {
    setFallbackAgentId(agentId: string | null): void {
      fallbackAgentId = agentId;
    },
    async upload(args: { filename: string; bytesBase64?: string; agentId?: string | null }) {
      const ingested = await ingestAttachmentBytes(resolveDir(args.agentId), args.filename, Buffer.from(typeof args.bytesBase64 === "string" ? args.bytesBase64 : "", "base64"));
      return { path: ingested.absolutePath };
    },
    readImage: (args: { path: string }) => readHostAttachmentImage(args.path),
    async readText(args: { path: string; agentId?: string | null }) {
      const directory = readDir(args.path, args.agentId);
      if (directory == null) {
        // A read that could not find an owner is reported: it is the difference between "nothing" and "not yours".
        deps.report?.({ extension: "attachments", kind: "read_text_miss", hasActive: args.agentId != null });
        return null;
      }
      return await readAttachmentText(directory, args.path);
    },
    async readChunk(args: { path: string; agentId?: string | null; offset: number; length: number; playback?: boolean }) {
      const directory = readDir(args.path, args.agentId);
      if (directory == null) {
        deps.report?.({ extension: "attachments", kind: "read_chunk_miss", hasActive: args.agentId != null });
        return null;
      }
      return await readHostAttachmentChunk(directory, args.path, args.offset, args.length, args.playback);
    },
    ingest: ingestAttachment,
    ingestBytes: ingestAttachmentBytes,
    persistImageBytes,
    readImageDimensions,
    readMediaDimensions,
    readVideoBytes: readHostAttachmentVideoBytes,
    resolveChannelAttachment,
    resolveOwnerDir: resolveAttachmentOwnerDir,
    createAgentImageResourcePort,
    stageIntoBox: (agentId: string, paths: readonly string[]) => stageAttachmentsForAgent({
      ctx: deps.ctx,
      box: deps.box,
      resolveOwnerDir: resolveAttachmentOwnerDir,
      upload: async (ctx, box, id, files) => {
        await uploadBoxFiles(ctx, box, id, files);
      },
    }, agentId, paths),
    createGenerateImageService: <C>(options: Parameters<typeof createSlateGenerateImageService<C>>[1]) => createSlateGenerateImageService(deps.auth, options),
  };
}

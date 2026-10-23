/**
 * The attachments service: link previews (what they cache, what they refuse), attachment bytes kept under their own
 * hash, the reads the host may make, and the service facade that works out whose attachment a path is.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ATTACHMENT_BYTE_LIMIT, VIDEO_BYTE_LIMIT } from "../../source/shared/media/attachment-limits.ts";
import {
  ATTACHMENT_CHUNK_MAX_BYTES,
  ATTACHMENT_TEXT_PREVIEW_BYTE_CAP,
  createAttachmentsService,
  fetchLinkMetadata,
  ingestAttachment,
  ingestAttachmentBytes,
  LINK_CACHE_VERSION,
  LINK_DESCRIPTION_CHAR_LIMIT,
  LINK_HTML_BYTE_LIMIT,
  LINK_IMAGE_BYTE_LIMIT,
  LINK_SITE_NAME_CHAR_LIMIT,
  LINK_TITLE_CHAR_LIMIT,
  persistImageBytes,
  readAttachmentText,
  readHostAttachmentChunk,
  readHostAttachmentImage,
  readHostAttachmentVideoBytes,
  readImageDimensions,
  readMediaDimensions,
  resolveAttachmentOwnerDir,
  SlateAttachmentError,
  type LinkPreviewFetcher,
} from "../../source/host/attachments/attachments-service.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-attachments-"));
const platformRoot = join(scratch, "root");
const previousRoot = process.env["SLATE_DATA_ROOT"];
process.env["SLATE_DATA_ROOT"] = platformRoot;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env["SLATE_DATA_ROOT"];
  else process.env["SLATE_DATA_ROOT"] = previousRoot;
});
let worldCount = 0;
/** An agent directory the platform's own paths know: reads are only allowed from inside the platform's root. */
const setUp = (label: string) => {
  const dir = join(platformRoot, "agents", `${label}-${worldCount++}`);
  // Both folders an agent's media lives in, so a test only has to write the file.
  mkdirSync(join(dir, "attachments"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  return dir;
};

/** A 1×1 PNG, so a real image can be read back. */
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

const imageFetch = (bytes: Buffer, type = "image/png") => ({ statusCode: 200, body: bytes, headers: { "content-type": type }, finalUrl: "https://cdn.test/icon.png", redirectUrls: [] });
const htmlFetch = (html: string, overrides: Record<string, unknown> = {}) => ({ statusCode: 200, body: Buffer.from(html, "utf8"), headers: { "content-type": "text/html; charset=utf-8" }, finalUrl: "https://example.test/page", redirectUrls: [], ...overrides });

/** A fetcher that answers from what the test says, and writes down what it was asked for. */
function linkFetcher(options: { html?: string; image?: Buffer | null; faviconFails?: boolean } = {}) {
  const asked: { url: string; accept: string | undefined }[] = [];
  const fetcher = (async (url: string, given: { accept?: string }) => {
    asked.push({ url, accept: given.accept });
    if (url.startsWith("https://www.google.com/s2/favicons")) {
      if (options.faviconFails === true) throw new Error("the favicon service is down");
      return imageFetch(Buffer.from("favicon-bytes"), "image/png");
    }
    if (options.html !== undefined && url.startsWith("https://example.test/page")) return htmlFetch(options.html);
    if (options.image !== undefined) return options.image == null ? imageFetch(Buffer.alloc(0)) : imageFetch(options.image);
    return imageFetch(Buffer.alloc(0));
  }) as unknown as LinkPreviewFetcher;
  return { fetcher, asked };
}

describe("a link preview", () => {
  it("reads what the page says about itself, resolving what it points at", async () => {
    const agentDir = setUp("link");
    const { fetcher, asked } = linkFetcher({
      html: `<html><head>
        <title>The page's own title</title>
        <meta property="og:title" content="Slate &amp; friends">
        <meta name="application-name" content="Slate">
        <meta property="og:description" content="A   page\nabout things">
        <link rel="canonical" href="https://example.test/canonical">
        <meta property="og:image" content="/social.png">
        <link rel="icon" href="/favicon.png">
      </head></html>`,
      image: Buffer.from("an-image"),
    });
    const metadata = await fetchLinkMetadata(agentDir, "https://example.test/page", fetcher);
    assert.deepEqual(
      [metadata?.title, metadata?.siteName, metadata?.description, metadata?.canonicalUrl, metadata?.hostname],
      ["Slate & friends", "Slate", "A page about things", "https://example.test/canonical", "example.test"],
    );
    assert.equal(metadata?.imageDataUrl, `data:image/png;base64,${Buffer.from("an-image").toString("base64")}`);
    assert.equal(metadata?.faviconDataUrl, `data:image/png;base64,${Buffer.from("an-image").toString("base64")}`);
    assert.deepEqual(asked.map((request) => request.url), ["https://example.test/page", "https://example.test/social.png", "https://example.test/favicon.png"]);
    assert.equal(asked[0]!.accept?.includes("text/html"), true);
    assert.equal(asked[1]!.accept?.includes("image/png"), true);
    // What was fetched is kept, and the next ask is answered from the cache without fetching at all.
    const again = linkFetcher();
    const cached = await fetchLinkMetadata(agentDir, "https://example.test/page", again.fetcher);
    assert.deepEqual([cached?.title, again.asked], ["Slate & friends", []]);
    assert.equal(JSON.parse(readFileSync(join(agentDir, "link-cache", `${createHash("sha256").update("https://example.test/page").digest("hex")}.json`), "utf8")).cacheVersion, LINK_CACHE_VERSION);
  });

  it("falls back to its own page title, and to the favicon service, when the page offers nothing", async () => {
    const agentDir = setUp("fallback");
    const { fetcher, asked } = linkFetcher({ html: `<html><head><title>Plain &lt;title&gt;</title></head></html>` });
    const metadata = await fetchLinkMetadata(agentDir, "https://example.test/page", fetcher);
    assert.deepEqual([metadata?.title, metadata?.description, metadata?.siteName], ["Plain <title>", "", ""]);
    assert.equal(metadata?.canonicalUrl, "https://example.test/page");
    assert.deepEqual(asked.map((request) => request.url).slice(1), ["https://www.google.com/s2/favicons?domain=example.test&sz=64"]);
    // An og:image that is not served as an image is a preview without one.
    const notAnImage: LinkPreviewFetcher = (async (url: string) => url.startsWith("https://example.test/page")
      ? htmlFetch(`<html><head><title>T</title><meta property="og:image" content="/paper.pdf"></head></html>`)
      : imageFetch(Buffer.from("not really an image"), "text/plain")) as unknown as LinkPreviewFetcher;
    const withoutImage = await fetchLinkMetadata(setUp("not-an-image"), "https://example.test/page", notAnImage);
    assert.equal(withoutImage?.imageDataUrl, null);
    // A favicon service that is down is a preview without a favicon, not a failed preview.
    const down = setUp("fallback-down");
    const failing = linkFetcher({ html: "<html><head><title>Plain</title></head></html>", faviconFails: true });
    const plain = await fetchLinkMetadata(down, "https://example.test/page", failing.fetcher);
    assert.deepEqual([plain?.faviconDataUrl, plain?.title], [null, "Plain"]);
  });

  it("refuses a sign-in wall, a page that is not a page, and an address that is not one", async () => {
    const signIn = linkFetcher({ html: "<html><head><title>Sign in</title></head></html>" });
    (signIn.fetcher as unknown as { mock?: never });
    const redirected: LinkPreviewFetcher = (async (url: string, given: { accept?: string }) => {
      void url;
      void given;
      return { statusCode: 200, body: Buffer.from("<html><title>Home</title></html>", "utf8"), headers: { "content-type": "text/html" }, finalUrl: "https://example.test/home", redirectUrls: ["https://accounts.google.com/o/oauth2/auth"] };
    }) as unknown as LinkPreviewFetcher;
    assert.equal(await fetchLinkMetadata(setUp("auth-redirect"), "https://example.test/page", redirected), null);
    const authPath: LinkPreviewFetcher = (async () => ({ statusCode: 200, body: Buffer.from("<html><title>Home</title></html>", "utf8"), headers: { "content-type": "text/html" }, finalUrl: "https://example.test/home", redirectUrls: ["https://idp.example.test/realms/acme/sign-in/identifier"] })) as unknown as LinkPreviewFetcher;
    assert.equal(await fetchLinkMetadata(setUp("auth-path"), "https://example.test/page", authPath), null);
    const authHost: LinkPreviewFetcher = (async () => ({ statusCode: 200, body: Buffer.from("<html><title>Home</title></html>", "utf8"), headers: { "content-type": "text/html" }, finalUrl: "https://example.test/home", redirectUrls: ["https://login.example.test/"] })) as unknown as LinkPreviewFetcher;
    assert.equal(await fetchLinkMetadata(setUp("auth-host"), "https://example.test/page", authHost), null);
    // A redirect that is not an authentication one is followed like any other.
    const ordinary: LinkPreviewFetcher = (async () => ({ statusCode: 200, body: Buffer.from("<html><title>Home</title></html>", "utf8"), headers: { "content-type": "text/html" }, finalUrl: "https://example.test/home", redirectUrls: ["https://www.example.test/welcome"] })) as unknown as LinkPreviewFetcher;
    assert.equal((await fetchLinkMetadata(setUp("ordinary-redirect"), "https://example.test/page", ordinary))?.title, "Home");
    const notHtml: LinkPreviewFetcher = (async () => ({ statusCode: 200, body: Buffer.from("PDF", "utf8"), headers: { "content-type": "application/pdf" }, finalUrl: "https://example.test/file", redirectUrls: [] })) as unknown as LinkPreviewFetcher;
    assert.equal(await fetchLinkMetadata(setUp("pdf"), "https://example.test/file", notHtml), null);
    const refused: LinkPreviewFetcher = (async () => ({ statusCode: 404, body: Buffer.alloc(0), headers: {}, finalUrl: "https://example.test/missing", redirectUrls: [] })) as unknown as LinkPreviewFetcher;
    assert.equal(await fetchLinkMetadata(setUp("404"), "https://example.test/missing", refused), null);
    const throws: LinkPreviewFetcher = (async () => { throw new Error("the network is gone"); }) as unknown as LinkPreviewFetcher;
    assert.equal(await fetchLinkMetadata(setUp("throws"), "https://example.test/page", throws), null);
    assert.equal(await fetchLinkMetadata(setUp("bad-url"), "not a url", linkFetcher().fetcher), null);
    assert.deepEqual([LINK_HTML_BYTE_LIMIT, LINK_IMAGE_BYTE_LIMIT, LINK_TITLE_CHAR_LIMIT, LINK_DESCRIPTION_CHAR_LIMIT, LINK_SITE_NAME_CHAR_LIMIT], [524_288, 2_097_152, 512, 2_048, 256]);
  });

  it("re-fetches a preview that was kept under an older version, and one that is too old", async () => {
    const agentDir = setUp("stale");
    const { fetcher } = linkFetcher({ html: "<html><head><title>Fresh</title></head></html>" });
    const first = await fetchLinkMetadata(agentDir, "https://example.test/page", fetcher);
    assert.equal(first?.title, "Fresh");
    const cachePath = readdirSync(join(agentDir, "link-cache")).map((name) => join(agentDir, "link-cache", name))[0]!;
    const stored = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    // An entry from an older version of what a preview holds is not read as if it were this one's.
    writeFileSync(cachePath, JSON.stringify({ ...stored, cacheVersion: LINK_CACHE_VERSION - 1, title: "From an older version" }));
    assert.equal((await fetchLinkMetadata(agentDir, "https://example.test/page", linkFetcher({ html: "<html><head><title>Fresh</title></head></html>" }).fetcher))?.title, "Fresh");
    writeFileSync(cachePath, JSON.stringify({ ...stored, cacheVersion: LINK_CACHE_VERSION, fetchedAt: Date.now() - 25 * 60 * 60 * 1_000, title: "Old" }));
    assert.equal((await fetchLinkMetadata(agentDir, "https://example.test/page", linkFetcher({ html: "<html><head><title>Fresh</title></head></html>" }).fetcher))?.title, "Fresh");
    // A cache file that is not one at all is no cache.
    writeFileSync(cachePath, "{not json");
    assert.equal((await fetchLinkMetadata(agentDir, "https://example.test/page", linkFetcher({ html: "<html><head><title>Fresh</title></head></html>" }).fetcher))?.title, "Fresh");
  });
});

describe("attachments kept under their own hash", () => {
  it("writes the bytes once, under their hash, and answers with where they are", async () => {
    const agentDir = setUp("ingest");
    const first = await ingestAttachmentBytes(agentDir, "Notes.TXT", new TextEncoder().encode("hello"));
    const second = await ingestAttachmentBytes(agentDir, "notes.txt", new TextEncoder().encode("hello"));
    assert.deepEqual([first.hash, first.bytes], [second.hash, 5]);
    assert.equal(first.absolutePath.endsWith(`${first.hash}.txt`), true);
    assert.equal(second.absolutePath, first.absolutePath);
    assert.deepEqual(readdirSync(join(agentDir, "attachments")), [`${first.hash}.txt`]);
    assert.equal(readFileSync(first.absolutePath, "utf8"), "hello");
    // A name with no extension still lands somewhere readable.
    const nameless = await ingestAttachmentBytes(agentDir, "README", new TextEncoder().encode("x"));
    assert.equal(nameless.absolutePath.endsWith(`${nameless.hash}.bin`), true);
  });

  it("refuses what it cannot keep: no name, nothing in it, or more than its name allows", async () => {
    const agentDir = setUp("ingest-refusals");
    const empty = new TextEncoder().encode("");
    for (const [filename, data, message] of [
      ["", empty, "Attachment filename is empty."],
      ["   ", empty, "Attachment filename is empty."],
      ["a.txt", empty, "Attachment is empty."],
    ] as const) {
      await assert.rejects(ingestAttachmentBytes(agentDir, filename, data), (error: Error) => error instanceof SlateAttachmentError && error.message === message);
    }
    // The limit follows the name: a file named as text may not be far larger than one named as video.
    await assert.rejects(ingestAttachmentBytes(agentDir, "notes.txt", new Uint8Array(ATTACHMENT_BYTE_LIMIT + 1)), (error: Error) => error.name === "AttachmentTooLargeError");
    assert.equal((await ingestAttachmentBytes(agentDir, "clip.mp4", new Uint8Array(10))).bytes, 10);
    assert.deepEqual(readdirSync(join(agentDir, "attachments")).length, 1);
  });

  it("takes a file from the disk, and leaves one already in the attachments folder where it is", async () => {
    const agentDir = setUp("ingest-file");
    const outside = join(agentDir, "outside.txt");
    writeFileSync(outside, "some bytes");
    const ingested = await ingestAttachment(agentDir, outside);
    assert.deepEqual([ingested.bytes, readFileSync(ingested.absolutePath, "utf8")], [10, "some bytes"]);
    // A file the user already put there keeps its own name and is not copied.
    const inPlace = join(agentDir, "attachments", "mine.txt");
    writeFileSync(inPlace, "as it was");
    const preserved = await ingestAttachment(agentDir, inPlace);
    assert.deepEqual([preserved.absolutePath, preserved.hash, preserved.bytes], [inPlace, "preserved", 9]);
    // What cannot be attached is refused with what it was.
    await assert.rejects(ingestAttachment(agentDir, ""), /Attachment file path is empty/);
    await assert.rejects(ingestAttachment(agentDir, "relative.txt"), /Attachment path must be absolute/);
    // A directory that is already inside the attachments folder is left where it is; one outside it is not a file.
    const inPlaceDirectory = await ingestAttachment(agentDir, join(agentDir, "attachments"));
    assert.deepEqual([inPlaceDirectory.absolutePath, inPlaceDirectory.hash], [join(agentDir, "attachments"), "preserved"]);
    const outsideDirectory = join(agentDir, "a-folder");
    mkdirSync(outsideDirectory, { recursive: true });
    await assert.rejects(ingestAttachment(agentDir, outsideDirectory), /Attachment source is not a file/);
    // A file too large for its own name is refused before it is read.
    const tooLarge = join(agentDir, "big.txt");
    writeFileSync(tooLarge, "");
    truncateSync(tooLarge, ATTACHMENT_BYTE_LIMIT + 1);
    assert.equal(statSync(tooLarge).size, ATTACHMENT_BYTE_LIMIT + 1);
    await assert.rejects(ingestAttachment(agentDir, tooLarge), (error: Error) => error.name === "AttachmentTooLargeError");
  });
});

describe("what the host may read back", () => {
  it("reads an image whole with its size, and nothing it may not read", async () => {
    const agentDir = setUp("read-image");
    const image = join(agentDir, "attachments", "one.png");
    writeFileSync(join(agentDir, "attachments", "one.png"), "");
    writeFileSync(image, ONE_PIXEL_PNG);
    const read = await readHostAttachmentImage(image);
    assert.equal(read?.dataUrl.startsWith("data:image/png;base64,"), true);
    assert.deepEqual([read?.width, read?.height], [1, 1]);
    assert.deepEqual(await readImageDimensions(image), { width: 1, height: 1 });
    // A file that is not an image, one that is not there, and one outside the platform's own root are all nothing.
    const notes = join(agentDir, "attachments", "notes.txt");
    writeFileSync(notes, "text");
    assert.deepEqual([await readHostAttachmentImage(notes), await readImageDimensions(notes), await readMediaDimensions(notes)], [null, null, null]);
    assert.equal(await readHostAttachmentImage(join(agentDir, "attachments", "gone.png")), null);
    assert.equal(await readHostAttachmentImage("/etc/hosts"), null);
    assert.equal(await readHostAttachmentImage(""), null);
    const outside = join(scratch, "outside.png");
    writeFileSync(outside, ONE_PIXEL_PNG);
    assert.deepEqual([await readHostAttachmentImage(outside), await readImageDimensions(outside) !== null], [null, true]);
  });

  it("reads a video only when it is one the platform carries whole, and its dimensions from head or tail", async () => {
    const agentDir = setUp("read-video");
    const video = join(agentDir, "attachments", "clip.mp4");
    writeFileSync(video, "video-bytes");
    assert.deepEqual([...(await readHostAttachmentVideoBytes(video))!].length, "video-bytes".length);
    const big = join(agentDir, "attachments", "big.mp4");
    writeFileSync(big, "");
    truncateSync(big, VIDEO_BYTE_LIMIT + 1);
    assert.equal(await readHostAttachmentVideoBytes(big), null);
    const notVideo = join(agentDir, "attachments", "notes.txt");
    writeFileSync(notVideo, "text");
    assert.deepEqual([await readHostAttachmentVideoBytes(notVideo), await readMediaDimensions(notVideo)], [null, null]);
    assert.equal(await readHostAttachmentVideoBytes("/etc/hosts"), null);
    // A video with no readable header has no dimensions rather than wrong ones.
    assert.equal(await readMediaDimensions(video), null);
  });

  it("hands over a byte range, clamped to what there is and to what it may carry", async () => {
    const agentDir = setUp("read-chunk");
    const file = join(agentDir, "attachments", "clip.mp4");
    writeFileSync(file, "0123456789");
    const whole = await readHostAttachmentChunk(agentDir, file, 0, 100);
    assert.deepEqual([Buffer.from(whole!.bytesBase64, "base64").toString(), whole!.totalSize, whole!.mime], ["0123456789", 10, "video/mp4"]);
    const middle = await readHostAttachmentChunk(agentDir, file, 2.7, 3.9);
    assert.deepEqual(Buffer.from(middle!.bytesBase64, "base64").toString(), "234");
    const past = await readHostAttachmentChunk(agentDir, file, -5, 4);
    assert.deepEqual(Buffer.from(past!.bytesBase64, "base64").toString(), "0123");
    const beyond = await readHostAttachmentChunk(agentDir, file, 20, 4);
    assert.deepEqual([beyond!.bytesBase64, beyond!.totalSize], ["", 10]);
    assert.equal(ATTACHMENT_CHUNK_MAX_BYTES, 8 * 1024 * 1024);
    // What it may not read answers nothing: outside the agent's own folders, or a range a playback asked for of
    // something that is not a video.
    assert.equal(await readHostAttachmentChunk(agentDir, "/etc/hosts", 0, 1), null);
    const text = join(agentDir, "attachments", "notes.txt");
    writeFileSync(text, "text");
    assert.equal(await readHostAttachmentChunk(agentDir, text, 0, 1, true), null);
    assert.equal((await readHostAttachmentChunk(agentDir, text, 0, 1))!.mime, null);
    // A range wider than the platform carries is capped, whatever the caller asked for.
    const wide = join(agentDir, "attachments", "wide.mp4");
    writeFileSync(wide, "");
    truncateSync(wide, ATTACHMENT_CHUNK_MAX_BYTES + 1_024);
    const capped = await readHostAttachmentChunk(agentDir, wide, 0, ATTACHMENT_CHUNK_MAX_BYTES + 1_024);
    assert.deepEqual([Buffer.from(capped!.bytesBase64, "base64").length, capped!.totalSize], [ATTACHMENT_CHUNK_MAX_BYTES, ATTACHMENT_CHUNK_MAX_BYTES + 1_024]);
  });

  it("previews text, and calls anything else a binary of a known size", async () => {
    const agentDir = setUp("read-text");
    const text = join(agentDir, "attachments", "notes.md");
    writeFileSync(text, "# A note\n\nSome words.\n");
    assert.deepEqual(await readAttachmentText(agentDir, text), { kind: "text", text: "# A note\n\nSome words.\n", truncated: false, bytes: 22 });
    // A long one is truncated to the preview's own cap, and says that it was.
    const long = join(agentDir, "attachments", "long.log");
    writeFileSync(long, "x".repeat(ATTACHMENT_TEXT_PREVIEW_BYTE_CAP + 100));
    const preview = await readAttachmentText(agentDir, long);
    assert.deepEqual([preview?.kind, preview?.truncated, (preview as { text: string }).text.length, preview?.bytes], ["text", true, ATTACHMENT_TEXT_PREVIEW_BYTE_CAP, ATTACHMENT_TEXT_PREVIEW_BYTE_CAP + 100]);
    // A file this platform would not preview as text is a binary, with its size — and so is a text-named file that
    // turns out to hold control characters.
    const archive = join(agentDir, "attachments", "bundle.zip");
    writeFileSync(archive, "not really a zip");
    assert.deepEqual(await readAttachmentText(agentDir, archive), { kind: "binary", bytes: 16 });
    const disguised = join(agentDir, "attachments", "disguised.txt");
    writeFileSync(disguised, Buffer.from([0, 1, 2, 3, 4, 5]));
    assert.deepEqual(await readAttachmentText(agentDir, disguised), { kind: "binary", bytes: 6 });
    // A file that is mostly control characters is a binary even with no NUL in it.
    const controls = join(agentDir, "attachments", "controls.txt");
    writeFileSync(controls, Buffer.from(Array.from({ length: 100 }, (_unused, index) => (index < 60 ? 7 : 65))));
    assert.deepEqual(await readAttachmentText(agentDir, controls), { kind: "binary", bytes: 100 });
    // A file that is text with a few control characters in it is text; one with a NUL is not, wherever the NUL sits.
    const mostlyText = join(agentDir, "attachments", "mostly-text.txt");
    writeFileSync(mostlyText, `words\tand\nlines\r\n${"x".repeat(1_000)}`);
    assert.equal((await readAttachmentText(agentDir, mostlyText))?.kind, "text");
    const nulLate = join(agentDir, "attachments", "nul-late.txt");
    writeFileSync(nulLate, `words and more words${"\u0000"}and then some`);
    assert.deepEqual(await readAttachmentText(agentDir, nulLate), { kind: "binary", bytes: 34 });
    assert.deepEqual([await readAttachmentText(agentDir, "/etc/hosts"), await readAttachmentText(agentDir, ""), await readAttachmentText(agentDir, join(agentDir, "attachments", "gone.txt"))], [null, null, null]);
    assert.equal(await readAttachmentText(agentDir, join(agentDir, "attachments")), null);
  });

  it("keeps a generated picture under its hash, with a file url and its size", async () => {
    const targetDir = setUp("persist");
    const persisted = await persistImageBytes(targetDir, ONE_PIXEL_PNG, "image/png");
    assert.deepEqual([persisted.bytes, persisted.width, persisted.height], [ONE_PIXEL_PNG.byteLength, 1, 1]);
    assert.equal(persisted.fileUrl.startsWith("file://"), true);
    assert.equal(persisted.absolutePath.endsWith(".png"), true);
    assert.equal(readFileSync(persisted.absolutePath).equals(ONE_PIXEL_PNG), true);
    // A type the platform knows keeps its own extension; one it does not falls back to a picture's.
    const known = await persistImageBytes(targetDir, ONE_PIXEL_PNG, "image/avif");
    assert.equal(known.absolutePath.endsWith(".avif"), true);
    const unknown = await persistImageBytes(targetDir, ONE_PIXEL_PNG, "application/octet-stream");
    assert.equal(unknown.absolutePath.endsWith(".png"), true);
    // The same picture under the same type is the same file, however often it is kept.
    assert.equal((await persistImageBytes(targetDir, ONE_PIXEL_PNG, "image/png")).absolutePath, persisted.absolutePath);
    // Two pictures were kept — one with a picture's own extension, one under the fallback's — and the second copy of
    // the first is the same file rather than another.
    assert.deepEqual(readdirSync(targetDir).filter((name) => name.includes(".")).length, 2);
  });
});

describe("whose attachment a path is, and what the service does with it", () => {
  it("reads the owner off the path rather than guessing it", () => {
    const agentDir = setUp("owner");
    mkdirSync(join(agentDir, "attachments"), { recursive: true });
    // A path under an agent's own folders names that agent, whichever of the two folders it is in.
    assert.deepEqual(
      [resolveAttachmentOwnerDir(join(agentDir, "attachments", "x.png")), resolveAttachmentOwnerDir(join(agentDir, "assets", "y.png"))],
      [agentDir, agentDir],
    );
    // Anything else belongs to nobody: no path, a path outside the platform, one outside the agents folder, and one
    // whose second folder is neither of the two.
    assert.deepEqual(
      [resolveAttachmentOwnerDir(""), resolveAttachmentOwnerDir("/etc/hosts"), resolveAttachmentOwnerDir(join(platformRoot, "workflows", "x.md")), resolveAttachmentOwnerDir(join(agentDir, "elsewhere", "z.png")), resolveAttachmentOwnerDir(join(agentDir, "attachments"))],
      [null, null, null, null, null],
    );
  });

  it("hands each read to the agent whose attachment it is, and reports a read that found no owner", async () => {
    const seen: Record<string, unknown>[] = [];
    const service = createAttachmentsService({
      auth: { getAccessToken: async () => "token", getMachineId: async () => "machine" },
      ctx: undefined,
      box: {} as never,
      report: (diagnostic) => void seen.push(diagnostic),
    });
    // Nothing signed in and no owner on the path: the read answers nothing and says what it could not do.
    assert.deepEqual(await service.readText({ path: "/etc/hosts" }), null);
    assert.deepEqual(await service.readChunk({ path: "/etc/hosts", offset: 0, length: 1 }), null);
    assert.deepEqual(seen, [
      { extension: "attachments", kind: "read_text_miss", hasActive: false },
      { extension: "attachments", kind: "read_chunk_miss", hasActive: false },
    ]);
    // An upload with no agent to attach to is refused rather than filed somewhere arbitrary.
    await assert.rejects(service.upload({ filename: "a.txt", bytesBase64: Buffer.from("x").toString("base64") }), /No active agent to attach to/);
    assert.equal(typeof service.setFallbackAgentId, "function");
    assert.deepEqual([typeof service.readImage, typeof service.readVideoBytes, typeof service.resolveOwnerDir, typeof service.stageIntoBox, typeof service.createGenerateImageService], ["function", "function", "function", "function", "function"]);
  });
});
// ---------------------------------------------------------------------------------------------
// the edges a preview keeps
// ---------------------------------------------------------------------------------------------

describe("a link preview's edges", () => {
  it("an image the page points at is only used when it was served as an image successfully", async () => {
    const agentDir = setUp("image-edges")
    const failing: LinkPreviewFetcher = (async (url: string) => {
      if (url === "https://example.test/page") {
        return { statusCode: 200, body: Buffer.from('<html><head><meta property="og:title" content="Page"><meta property="og:image" content="/social.png"></head></html>'), headers: { "content-type": "text/html" }, finalUrl: "https://example.test/page", redirectUrls: [] }
      }
      return { statusCode: 500, body: Buffer.from("not an image"), headers: { "content-type": "image/png" }, finalUrl: "https://example.test/social.png", redirectUrls: [] }
    }) as unknown as LinkPreviewFetcher
    const metadata = await fetchLinkMetadata(agentDir, "https://example.test/page", failing)
    assert.equal(metadata?.imageDataUrl, null)

    const emptyAgentDir = setUp("image-empty")
    const empty: LinkPreviewFetcher = (async (url: string) => {
      if (url === "https://example.test/page") {
        return { statusCode: 200, body: Buffer.from('<html><head><meta property="og:title" content="Page"><meta property="og:image" content="/social.png"></head></html>'), headers: { "content-type": "text/html" }, finalUrl: "https://example.test/page", redirectUrls: [] }
      }
      return imageFetch(Buffer.alloc(0), "image/png")
    }) as unknown as LinkPreviewFetcher
    const emptyMetadata = await fetchLinkMetadata(emptyAgentDir, "https://example.test/page", empty)
    assert.equal(emptyMetadata?.imageDataUrl, null)
  })

  it("control characters in a page's words are cleaned out of the preview", async () => {
    const agentDir = setUp("control")
    const control = String.fromCharCode(1)
    const { fetcher } = linkFetcher({ html: "<html><head><title>a" + control + "b</title></head></html>" })
    const metadata = await fetchLinkMetadata(agentDir, "https://example.test/page", fetcher)
    assert.equal(metadata?.title.includes(control), false)
    assert.equal(metadata?.title, "a b")
  })

  it("a rel with several tokens is matched by any of them", async () => {
    const agentDir = setUp("rel-tokens")
    const { fetcher, asked } = linkFetcher({
      html: '<html><head><title>Page</title><link rel="alternate icon" href="/favicon.png"><meta property="og:title" content="Page"></head></html>',
      image: Buffer.from("icon-bytes"),
    })
    const metadata = await fetchLinkMetadata(agentDir, "https://example.test/page", fetcher)
    // The multi-token rel is where the favicon is, so the service is not asked.
    assert.equal(metadata?.faviconDataUrl, "data:image/png;base64," + Buffer.from("icon-bytes").toString("base64"))
    assert.equal(asked.some((request) => request.url.startsWith("https://www.google.com/s2/favicons")), false)
  })

  it("a redirect through a sign-in page path is not previewed", async () => {
    const agentDir = setUp("auth-path")
    for (const path of ["login", "signin", "sso", "authorize"]) {
      const fetcher = (async () => ({
        statusCode: 200,
        body: Buffer.from("<html><head><title>Sign in</title></head></html>"),
        headers: { "content-type": "text/html" },
        finalUrl: "https://example.test/page",
        redirectUrls: ["https://app.example.test/" + path],
      })) as unknown as LinkPreviewFetcher
      const metadata = await fetchLinkMetadata(agentDir, "https://example.test/page", fetcher)
      assert.equal(metadata, null)
    }
  })
})


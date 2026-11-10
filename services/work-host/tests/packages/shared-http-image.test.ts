import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { imageContentType, readCappedImageBytes, responseToImageDataUrl } from "../../source/shared/node/http-image.ts";

const encoder = new TextEncoder();
const text = (value: string): Uint8Array => encoder.encode(value);
const headers = (values: Record<string, string> = {}): Headers => new Headers(values);

/** What a read of a body did: was the body opened, what came out of it, and was the rest cancelled. */
interface BodyWatch {
  opened: number;
  reads: number;
  cancelled: boolean;
}

const watch = (): BodyWatch => ({ opened: 0, reads: 0, cancelled: false });

/** The reader side of a body, with the three things a caller cannot otherwise see: open, read and cancel. */
function bodyOf(chunks: readonly Uint8Array[], seen: BodyWatch): ReadableStream<Uint8Array> {
  return {
    getReader() {
      seen.opened += 1;
      let index = 0;
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          seen.reads += 1;
          const chunk = chunks[index];
          if (chunk === undefined) return { done: true };
          index += 1;
          return { done: false, value: chunk };
        },
        async cancel(): Promise<void> {
          seen.cancelled = true;
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

/** A body that would never end, so that stopping at the limit is the only way out of it. */
function endlessBody(seen: BodyWatch, chunk: Uint8Array): ReadableStream<Uint8Array> {
  return {
    getReader() {
      seen.opened += 1;
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          seen.reads += 1;
          return { done: false, value: chunk };
        },
        async cancel(): Promise<void> {
          seen.cancelled = true;
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

describe("an image content type", () => {
  it("is the media type only when the response declares it an image, with its parameters dropped", () => {
    assert.equal(imageContentType({ headers: headers({ "content-type": "image/png" }) }), "image/png");
    assert.equal(imageContentType({ headers: headers({ "content-type": "image/png; charset=binary" }) }), "image/png");
    // The padding before the parameters belongs to nobody: the header itself has already lost its edges.
    assert.equal(imageContentType({ headers: headers({ "content-type": "image/png ; charset=binary" }) }), "image/png");
    assert.equal(imageContentType({ headers: headers({ "content-type": " image/jpeg;quality=90 " }) }), "image/jpeg");
    assert.equal(imageContentType({ headers: headers({ "content-type": "image/svg+xml" }) }), "image/svg+xml");
    // The type is compared as written: an upper-case one is not a type this platform hands to a renderer.
    assert.equal(imageContentType({ headers: headers({ "content-type": "IMAGE/PNG" }) }), null);
    // A response that says nothing, or says something else, is not an image.
    assert.equal(imageContentType({ headers: headers() }), null);
    assert.equal(imageContentType({ headers: headers({ "content-type": "" }) }), null);
    assert.equal(imageContentType({ headers: headers({ "content-type": "text/html" }) }), null);
    assert.equal(imageContentType({ headers: headers({ "content-type": "text/plain; image/png" }) }), null);
  });
});

describe("reading capped image bytes", () => {
  it("reads a body up to the limit and joins its chunks", async () => {
    const twoChunks = watch();
    const joined = await readCappedImageBytes({ headers: headers(), body: bodyOf([text("ab"), text("cd")], twoChunks) }, 10);
    assert.equal(joined?.toString(), "abcd");

    // The limit is a limit, not an exclusive bound: a body of exactly the limit is read.
    const atLimit = watch();
    assert.equal((await readCappedImageBytes({ headers: headers(), body: bodyOf([text("abc")], atLimit) }, 3))?.toString(), "abc");

    const binary = watch();
    const raw = await readCappedImageBytes({ headers: headers(), body: bodyOf([new Uint8Array([0, 255, 1, 254])], binary) }, 10);
    assert.deepEqual(raw, Buffer.from([0, 255, 1, 254]), "the bytes are bytes, not text");
  });

  it("refuses a body that declares more than the limit without opening it", async () => {
    const seen = watch();
    const body = bodyOf([text("abc")], seen);
    assert.equal(await readCappedImageBytes({ headers: headers({ "content-length": "100" }), body }, 10), null);
    assert.equal(seen.opened, 0, "a declared length over the limit is answered before the body is opened");
    assert.equal(seen.reads, 0);
  });

  it("refuses a body that sends more than the limit and stops reading it", async () => {
    const oneChunkOver = watch();
    assert.equal(await readCappedImageBytes({ headers: headers(), body: bodyOf([text("abcdefghijk")], oneChunkOver) }, 10), null);
    assert.equal(oneChunkOver.reads, 1, "the chunk that crossed the limit is the last one read");
    assert.equal(oneChunkOver.cancelled, true, "the stream is cancelled rather than drained");

    const aLaterChunkOver = watch();
    assert.equal(await readCappedImageBytes({ headers: headers(), body: bodyOf([text("ab"), text("cd")], aLaterChunkOver) }, 3), null);
    assert.equal(aLaterChunkOver.cancelled, true);

    // A body that would never end is abandoned at the limit rather than drained.
    const endless = watch();
    assert.equal(await readCappedImageBytes({ headers: headers(), body: endlessBody(endless, text("abcd")) }, 10), null);
    assert.equal(endless.cancelled, true);
    assert.equal(endless.reads, 3);
  });

  it("leaves a declared length that is not a usable number to the actual bytes", async () => {
    const readWithDeclared = async (declared: string): Promise<string | undefined> => {
      const bytes = await readCappedImageBytes({ headers: headers({ "content-length": declared }), body: bodyOf([text("ab")], watch()) }, 10);
      return bytes?.toString();
    };
    assert.equal(await readWithDeclared("abc"), "ab");
    assert.equal(await readWithDeclared("Infinity"), "ab", "an infinite declared length is not a finite one");
    assert.equal(await readWithDeclared(""), "ab");
    assert.equal(await readWithDeclared("-5"), "ab");
    // A declared length under what arrives does not stop the actual bytes from being measured.
    const seen = watch();
    assert.equal((await readCappedImageBytes({ headers: headers({ "content-length": "1" }), body: bodyOf([text("abc")], seen) }, 10))?.toString(), "abc");
  });

  it("has no bytes for an empty body or for no body at all", async () => {
    const empty = watch();
    assert.equal(await readCappedImageBytes({ headers: headers(), body: bodyOf([], empty) }, 10), null);
    assert.equal(await readCappedImageBytes({ headers: headers(), body: null as unknown as ReadableStream<Uint8Array> }, 10), null);
  });
});

describe("an image data URL", () => {
  it("is the declared image type and the bytes as base64", async () => {
    const response = new Response("abc", { headers: { "content-type": "image/png" } });
    assert.equal(await responseToImageDataUrl(response, 10), "data:image/png;base64,YWJj");

    const binary = new Response(new Uint8Array([0, 255, 1, 254]), { headers: { "content-type": "image/gif; charset=binary" } });
    assert.equal(await responseToImageDataUrl(binary, 10), "data:image/gif;base64,AP8B/g==");
  });

  it("is nothing when the response is not an image, not ok, or larger than the limit", async () => {
    assert.equal(await responseToImageDataUrl(new Response("abc", { headers: { "content-type": "text/html" } }), 10), null);
    assert.equal(await responseToImageDataUrl(new Response("abc"), 10), null);
    assert.equal(await responseToImageDataUrl(new Response("abc", { status: 404, headers: { "content-type": "image/png" } }), 10), null);
    assert.equal(await responseToImageDataUrl(new Response(null, { status: 204 }), 10), null);
    assert.equal(await responseToImageDataUrl(new Response("", { headers: { "content-type": "image/png" } }), 10), null, "an empty image is no image");
    assert.equal(await responseToImageDataUrl(new Response("abcdefghijk", { headers: { "content-type": "image/png" } }), 10), null);
    // The limit is a limit, not an exclusive bound: a body of exactly the limit is still an image.
    assert.equal(await responseToImageDataUrl(new Response("abc", { headers: { "content-type": "image/png" } }), 3), "data:image/png;base64,YWJj");
  });
});
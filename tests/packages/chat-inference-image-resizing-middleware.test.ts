import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IMAGE_RESIZE_CONCURRENCY,
  ImageResizingPromptExecutor,
  createImageResizingMiddleware,
  resizeImagesInMessage,
  resizeImagesInMessages,
} from "../../source/packages/chat-inference/middleware/image-resizing-middleware.ts";
import { MAX_IMAGE_SIZE_BYTES } from "../../source/packages/utils/image-resize.ts";

const TINY_PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const oversizedInvalid = () => new Uint8Array(MAX_IMAGE_SIZE_BYTES + 8);
const ctx = { get: () => ({ log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) } as never;
const userImage = (bytes: Uint8Array, mimeType = "image/png") => ({ role: "user", content: [{ type: "image", image: bytes, mimeType }] });
const toolImage = (base64: string) => ({ role: "tool", content: [{ type: "tool-result", experimental_content: [{ type: "image", data: base64, mimeType: "image/png" }] }] });

describe("resizing images in one message", () => {
  it("leaves non-user and text messages alone", async () => {
    const assistant = { role: "assistant", content: [{ type: "image", image: TINY_PNG }] };
    assert.equal(await resizeImagesInMessage(ctx, assistant), assistant);
    const text = { role: "user", content: "just text" };
    assert.equal(await resizeImagesInMessage(ctx, text), text);
    const badContent = { role: "user", content: 3 };
    assert.equal(await resizeImagesInMessage(ctx, badContent), badContent);
  });

  it("keeps parts it cannot classify and images that are not bytes", async () => {
    const message = { role: "user", content: [{ type: "text", text: "a" }, { type: "image", image: "not-bytes" }] };
    const result = await resizeImagesInMessage(ctx, message);
    assert.equal(result, message);
  });

  it("keeps a small image it cannot decode and drops an oversized one", async () => {
    const small = await resizeImagesInMessage(ctx, userImage(new Uint8Array([1, 2, 3])));
    assert.deepEqual((small.content as any[])[0].image, new Uint8Array([1, 2, 3]));
    const oversized = await resizeImagesInMessage(ctx, userImage(oversizedInvalid(), "image/webp"));
    const replacement = (oversized.content as any[])[0];
    assert.equal(replacement.type, "text");
    assert.equal(replacement.text.includes(String(MAX_IMAGE_SIZE_BYTES + 8)), true);
    assert.equal(replacement.text.includes("image/webp"), true);
  });

  it("keeps an oversized image part that is not bytes", async () => {
    const message = { role: "user", content: [{ type: "image", image: "x".repeat(MAX_IMAGE_SIZE_BYTES + 8) }] };
    assert.equal(await resizeImagesInMessage(ctx, message), message);
  });

  it("keeps a valid image as bytes", async () => {
    const result = await resizeImagesInMessage(ctx, userImage(TINY_PNG));
    const part = (result.content as any[])[0];
    assert.equal(part.type, "image");
    assert.equal(part.image instanceof Uint8Array, true);
  });

  it("handles images inside a tool result", async () => {
    const kept = await resizeImagesInMessage(ctx, toolImage(Buffer.from([1, 2, 3]).toString("base64")));
    assert.equal((kept.content as any[])[0].experimental_content[0].type, "image");
    const huge = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 8, 7).toString("base64");
    const dropped = await resizeImagesInMessage(ctx, toolImage(huge));
    const experimental = (dropped.content as any[])[0].experimental_content[0];
    assert.equal(experimental.type, "text");
    assert.equal(experimental.text.includes("image omitted"), true);
  });
});

describe("resizing across messages", () => {
  it("keeps the input order and handles an empty list", async () => {
    assert.deepEqual(await resizeImagesInMessages(ctx, []), []);
    const messages = [userImage(TINY_PNG), { role: "user", content: "text" }, userImage(new Uint8Array([9]))];
    const resized = await resizeImagesInMessages(ctx, messages as never);
    assert.equal(resized.length, 3);
    assert.equal((resized[1] as any).content, "text");
    assert.equal(IMAGE_RESIZE_CONCURRENCY > 0, true);
  });
});

describe("the resizing prompt executor", () => {
  it("rewrites the executor messages before streaming", async () => {
    const appended: any[] = [];
    const inner: any = {
      getMessages: () => [userImage(TINY_PNG)],
      clearMessages: () => appended.push(["cleared"]),
      appendMessages: (messages: any[]) => appended.push(messages),
      stream: async () => ({ fullStream: (async function* () { yield { part: 1 }; })(), response: Promise.resolve("response"), usage: Promise.resolve("usage"), providerMetadata: Promise.resolve("meta"), extendedUsage: Promise.resolve("extended"), invocationId: Promise.resolve("invocation") }),
    };
    const executor = new ImageResizingPromptExecutor(inner as never);
    const stream = executor.stream(ctx, "invocation");
    const parts = [];
    for await (const part of stream.fullStream) parts.push(part);
    assert.deepEqual(parts, [{ part: 1 }]);
    assert.equal(await stream.response, "response");
    assert.equal(await stream.usage, "usage");
    assert.equal(await stream.providerMetadata, "meta");
    assert.equal(await stream.extendedUsage, "extended");
    assert.equal(await stream.invocationId, "invocation");
    assert.deepEqual(appended[0], ["cleared"]);
    assert.equal((appended[1][0] as any).role, "user");
  });

  it("is created by the middleware factory", () => {
    const factory = createImageResizingMiddleware();
    const instance = factory({} as never);
    assert.equal(instance instanceof ImageResizingPromptExecutor, true);
  });
});

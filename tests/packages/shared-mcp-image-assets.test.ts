/**
 * The images an MCP tool result carries: what is said about an image saved to disk, and how a result's images are
 * persisted in place — with what was saved added as a text item, and what could not be saved left alone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { augmentMcpResultWithSavedImages, describeSavedImage } from "../../source/shared/node/mcp/mcp-image-assets.ts";
import { generatedMcpResultFactory } from "../../source/shared/node/mcp/mcp-result-factory.ts";
import { McpResult } from "../../source/packages/proto/generated/agent/v1/mcp_exec_pb.ts";
import type { McpContentItem } from "../../source/shared/node/mcp/mcp-image-assets.ts";

function imageItem(data: Uint8Array, mimeType = "image/png") {
  return { content: { case: "image", value: { data, mimeType } } };
}
function textItem(text: string) {
  return { content: { case: "text", value: { text } } };
}
/** A result in the shape the mirror is handed, without going through the platform's own message types first. */
function successResult(items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { result: { case: "success" as const, value: { content: items, ...extra } } };
}
function itemsOf(result: unknown) {
  return (result as { result: { value: { content: McpContentItem[] } } }).result.value.content;
}

describe("what is said about a saved image", () => {
  it("names where the image went, its size when it is known, and how to show it", () => {
    const withSize = describeSavedImage({ fileUrl: "file:///images/one.png", width: 640, height: 480 });
    assert.equal(withSize.includes("file:///images/one.png"), true);
    assert.equal(withSize.includes("(640x480)"), true);
    assert.equal(withSize.includes('{"type":"attachment","url":"file:///images/one.png"}'), true);
    // Half a size is no size.
    assert.equal(describeSavedImage({ fileUrl: "file:///images/two.png", width: 640 }).includes("x"), false);
    assert.equal(describeSavedImage({ fileUrl: "file:///images/three.png", height: 480 }).includes("(480"), false);
    assert.equal(describeSavedImage({ fileUrl: "file:///images/four.png" }).includes("("), false);
  });

  it("persists an image and says where it went, in the place the image was", async () => {
    const asked: Array<[unknown, string]> = [];
    const result = successResult([textItem("before"), imageItem(new Uint8Array([1, 2, 3])), textItem("after")]);
    const augmented = await augmentMcpResultWithSavedImages(
      result,
      async (data, mimeType) => {
        asked.push([data, mimeType]);
        return { fileUrl: "file:///saved/one.png", width: 2, height: 3 };
      },
      generatedMcpResultFactory,
    );
    assert.deepEqual([Array.from(asked[0]?.[0] as Uint8Array), asked[0]?.[1]], [[1, 2, 3], "image/png"]);
    // What was said about the saved image goes right after the image it describes, and the rest keeps its place.
    const items = itemsOf(augmented);
    assert.deepEqual(items.map((item) => item.content.case), ["text", "image", "text", "text"]);
    assert.equal((items[2]?.content.value as { text: string }).text, describeSavedImage({ fileUrl: "file:///saved/one.png", width: 2, height: 3 }));
    assert.equal((items[3]?.content.value as { text: string }).text, "after");
    assert.equal((items[0]?.content.value as { text: string }).text, "before");
  });

  it("leaves a result alone when there is nothing to persist, and skips what it could not persist", async () => {
    const notSuccess = { result: { case: "error" as const, value: { error: "no" } } };
    let asked = 0;
    const persist = async () => {
      asked += 1;
      return { fileUrl: "file:///saved.png" };
    };
    assert.equal(await augmentMcpResultWithSavedImages(notSuccess, persist), notSuccess);
    const noImages = successResult([textItem("only text")]);
    assert.equal(await augmentMcpResultWithSavedImages(noImages, persist), noImages);
    assert.equal(asked, 0);
    // An image with no bytes is not persisted and nothing is added for it; the result is still the platform's own.
    const empty = successResult([imageItem(new Uint8Array(0))]);
    assert.deepEqual(itemsOf(await augmentMcpResultWithSavedImages(empty, persist)).map((item) => item.content.case), ["image"]);
    assert.equal(asked, 0);
    const failing = successResult([imageItem(new Uint8Array([4])), imageItem(new Uint8Array([5]))]);
    let calls = 0;
    const augmented = await augmentMcpResultWithSavedImages(failing, async () => {
      calls += 1;
      if (calls === 1) throw new Error("no room on disk");
      return null;
    });
    assert.deepEqual(itemsOf(augmented).map((item) => item.content.case), ["image", "image"]);
    assert.equal(calls, 2);
  });

  it("uses the platform's own factory when none is given", async () => {
    const result = successResult([imageItem(new Uint8Array([6]))]);
    const augmented = await augmentMcpResultWithSavedImages(result, async () => ({ fileUrl: "file:///saved.png" }));
    const items = itemsOf(augmented);
    assert.deepEqual(items.map((item) => item.content.case), ["image", "text"]);
    assert.equal((items[1]?.content.value as { text: string }).text, describeSavedImage({ fileUrl: "file:///saved.png" }));
    // What came back is the platform's own result shape, not the item shape the test handed in.
    assert.equal((augmented as unknown) instanceof McpResult, true);
  });
});

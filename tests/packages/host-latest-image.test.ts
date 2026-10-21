import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findLatestImagePart,
  toUserMessageImagePart,
  type SummarizationImageMessage,
} from "../../source/packages/agent-summarization/latest-image.ts";

/** A user message carrying parts. */
const user = (...parts: unknown[]): SummarizationImageMessage => ({ role: "user", content: parts as never });

/** A tool result carrying experimental content. */
const tool = (...parts: unknown[]): SummarizationImageMessage => ({ role: "tool", content: parts as never });

describe("carrying a user's image into a model call", () => {
  it("wraps bare base64 in a data URL of the mime type it was given", () => {
    assert.deepEqual(toUserMessageImagePart({ image: "abc123", mimeType: "image/jpeg" }), { type: "image", image: "data:image/jpeg;base64,abc123", mimeType: "image/jpeg" });
  });

  it("assumes PNG when nothing says otherwise, and trims what it was told", () => {
    assert.equal(toUserMessageImagePart({ image: "abc" }).image, "data:image/png;base64,abc");
    assert.equal(toUserMessageImagePart({ image: "abc", mimeType: "  " }).image, "data:image/png;base64,abc");
    assert.equal(toUserMessageImagePart({ image: "abc", mimeType: " image/webp " }).image, "data:image/webp;base64,abc");
  });

  it("leaves a reference alone, whatever case it is written in", () => {
    for (const image of ["data:image/png;base64,x", "https://example.com/a.png", "HTTP://example.com/a.png", "blob:abc"]) {
      assert.equal(toUserMessageImagePart({ image }).image, image, image);
    }
  });

  it("hands over anything that is not base64 exactly as it was", () => {
    const object = { some: "image" };
    assert.deepEqual(toUserMessageImagePart({ image: object }), { type: "image", image: object });
  });

  it("carries a mime type only when one was given, even when it is null", () => {
    assert.equal("mimeType" in toUserMessageImagePart({ image: "abc" }), false);
    assert.equal(toUserMessageImagePart({ image: "abc", mimeType: null }).mimeType, null);
  });
});

describe("finding the newest image in a conversation", () => {
  it("answers nothing for a conversation without one", () => {
    assert.equal(findLatestImagePart([]), null);
    assert.equal(findLatestImagePart([user({ type: "text", text: "hello" })]), null);
    assert.equal(findLatestImagePart([{ role: "user", content: "just text" }]), null);
    assert.equal(findLatestImagePart([{ role: "assistant", content: [{ type: "image", image: "a" }] as never }]), null, "an assistant's image is not the one carried");
  });

  it("takes the last image in a user message, with its mime type when it has one", () => {
    assert.deepEqual(findLatestImagePart([user({ type: "image", image: "first" }, { type: "image", image: "second" })]), { image: "second" });
    assert.deepEqual(findLatestImagePart([user({ type: "image", image: "only", mimeType: "image/png" })]), { image: "only", mimeType: "image/png" });
  });

  it("takes an image a tool result carried in its experimental content", () => {
    assert.deepEqual(findLatestImagePart([tool({ experimental_content: [{ type: "image", data: "t1" }, { type: "image", data: "t2", mimeType: "image/jpeg" }] })]), { image: "t2", mimeType: "image/jpeg" });
  });

  it("ignores a tool image with no data, and one whose data is not text", () => {
    assert.equal(findLatestImagePart([tool({ experimental_content: [{ type: "image" }, { type: "image", data: 5 }, { type: "text", data: "x" }] })]), null);
    assert.equal(findLatestImagePart([tool({ experimental_content: undefined })]), null);
    assert.equal(findLatestImagePart([tool({ experimental_content: [] })]), null);
  });

  it("keeps looking past a message that has no image of its own", () => {
    const newestWithout = [user({ type: "image", image: "older" }), user({ type: "text", text: "and then just words" })];
    assert.deepEqual(findLatestImagePart(newestWithout), { image: "older" });
    const toolWithout = [user({ type: "image", image: "older" }), tool({ experimental_content: [{ type: "text", data: "x" }] })];
    assert.deepEqual(findLatestImagePart(toolWithout), { image: "older" });
  });

  it("carries a tool image's mime type only when it is text", () => {
    assert.deepEqual(findLatestImagePart([tool({ experimental_content: [{ type: "image", data: "t1", mimeType: 5 }] })]), { image: "t1" });
    assert.deepEqual(findLatestImagePart([tool({ experimental_content: [{ type: "image", data: "t1", mimeType: "image/webp" }] })]), { image: "t1", mimeType: "image/webp" });
  });

  it("takes the newest message's image, whichever kind of message it is in", () => {
    const userThenTool = [user({ type: "image", image: "u" }), tool({ experimental_content: [{ type: "image", data: "t" }] })];
    assert.deepEqual(findLatestImagePart(userThenTool), { image: "t" });
    const toolThenUser = [tool({ experimental_content: [{ type: "image", data: "t" }] }), user({ type: "image", image: "u" })];
    assert.deepEqual(findLatestImagePart(toolThenUser), { image: "u" });
  });

  it("reads a tool result whose content is not a list as holding nothing", () => {
    assert.equal(findLatestImagePart([{ role: "tool", content: "a string" }]), null);
  });
});

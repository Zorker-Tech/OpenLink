import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InputTokenLimitError,
  OutputTokensLimitExceededError,
  ProactiveSummarizationThresholdError,
  createImageResult,
  createStringResult,
} from "../../source/packages/chat-inference/prompt-executor.ts";

describe("a string tool result", () => {
  it("is one text part and the error flag", () => {
    assert.deepEqual(createStringResult("hello"), { content: [{ type: "text", text: "hello" }], isError: false });
    assert.equal(JSON.stringify(createStringResult("hello")), '{"content":[{"type":"text","text":"hello"}],"isError":false}');
    assert.deepEqual(createStringResult("hello", true), { content: [{ type: "text", text: "hello" }], isError: true });
    assert.deepEqual(createStringResult(""), { content: [{ type: "text", text: "" }], isError: false });
    assert.deepEqual(createStringResult("café ☕"), { content: [{ type: "text", text: "café ☕" }], isError: false });
  });

  it("builds a fresh content array each time", () => {
    const first = createStringResult("x");
    const second = createStringResult("x");
    assert.notEqual(first.content, second.content);
    assert.deepEqual(Object.keys(first), ["content", "isError"]);
    assert.deepEqual(Object.keys(first.content[0] as object), ["type", "text"]);
  });
});

describe("an image tool result", () => {
  it("is the image, and the line of text before it when there is one", () => {
    assert.equal(
      JSON.stringify(createImageResult("data:abc", "image/png")),
      '{"content":[{"type":"image","data":"data:abc","mimeType":"image/png"}],"isError":false}',
    );
    assert.equal(
      JSON.stringify(createImageResult("data:abc", "image/png", "a cat")),
      '{"content":[{"type":"text","text":"a cat"},{"type":"image","data":"data:abc","mimeType":"image/png"}],"isError":false}',
    );
    assert.equal(
      JSON.stringify(createImageResult("data:abc", "image/png", "a cat", true)),
      '{"content":[{"type":"text","text":"a cat"},{"type":"image","data":"data:abc","mimeType":"image/png"}],"isError":true}',
    );
  });

  it("leaves the text part off when the text says nothing", () => {
    assert.deepEqual(createImageResult("data:abc", "image/png", "").content, [{ type: "image", data: "data:abc", mimeType: "image/png" }]);
    assert.deepEqual(createImageResult("data:abc", "image/png", undefined).content.length, 1);
    assert.deepEqual(Object.keys(createImageResult("d", "m", "t")), ["content", "isError"]);
    assert.deepEqual(createImageResult("d", "m", "t").content.map((part) => Object.keys(part)), [["type", "text"], ["type", "data", "mimeType"]]);
  });
});

describe("the three limits a prompt can hit", () => {
  it("say what they are by default", () => {
    assert.equal(new OutputTokensLimitExceededError().message, "Provider exceeded max output tokens");
    assert.equal(new InputTokenLimitError().message, "Input token limit exceeded");
    assert.equal(new ProactiveSummarizationThresholdError().message, "Configured summarization threshold reached");
  });

  it("carry their class name, and a message when one is given", () => {
    const cases = [
      [OutputTokensLimitExceededError, "OutputTokensLimitExceededError"],
      [InputTokenLimitError, "InputTokenLimitError"],
      [ProactiveSummarizationThresholdError, "ProactiveSummarizationThresholdError"],
    ] as const;
    for (const [ErrorClass, name] of cases) {
      const built = new ErrorClass();
      assert.equal(built.name, name);
      assert.equal(built instanceof Error, true);
      assert.equal(built instanceof ErrorClass, true);
      assert.equal(built.toString(), name + ": " + built.message);
      assert.deepEqual(Object.keys(built), ["name"], "the name is an own enumerable field");
      const withMessage = new ErrorClass("custom message");
      assert.equal(withMessage.message, "custom message");
      assert.equal(withMessage.name, name);
    }
  });

  it("are three distinct kinds, so a caller can tell the three limits apart", () => {
    const output = new OutputTokensLimitExceededError();
    assert.equal(output instanceof InputTokenLimitError, false);
    assert.equal(output instanceof ProactiveSummarizationThresholdError, false);
    assert.equal(new InputTokenLimitError() instanceof ProactiveSummarizationThresholdError, false);
  });
});
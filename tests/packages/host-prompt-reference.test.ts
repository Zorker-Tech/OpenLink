import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROMPT_REFERENCE_ID_ALPHABET,
  PROMPT_REFERENCE_ID_LENGTH,
  createPromptReferenceId,
  createPromptReferenceIdFromMessageId,
  createToolCallReferenceId,
  isValidPromptReferenceId,
  parseLeadingUserMessageIdTag,
  renderToolCallIdTag,
  renderUserMessageIdTag,
} from "../../source/packages/agent/tools/prompt-reference-contract.ts";

describe("the reference a prompt uses for a message", () => {
  it("is seven characters of the alphabet", () => {
    assert.equal(PROMPT_REFERENCE_ID_LENGTH, 7);
    assert.equal(PROMPT_REFERENCE_ID_ALPHABET.length, 62);
    for (const id of ["abc", "a".repeat(200), "ünï", "  padded  "]) {
      const reference = createPromptReferenceIdFromMessageId(id);
      assert.equal(reference.length, 7);
      assert.equal(isValidPromptReferenceId(reference), true, id);
    }
  });

  it("is derived from the id, so the same message always has the same one", () => {
    assert.equal(createPromptReferenceIdFromMessageId("msg-1"), createPromptReferenceIdFromMessageId("msg-1"));
    assert.notEqual(createPromptReferenceIdFromMessageId("msg-1"), createPromptReferenceIdFromMessageId("msg-2"));
  });

  it("is made up when there is no id to derive it from, and derived from an id when there is", () => {
    for (const nothing of [undefined, null, "", "   "]) {
      const reference = createPromptReferenceId(nothing);
      assert.equal(reference.length, 7);
      assert.equal(isValidPromptReferenceId(reference), true, String(nothing));
    }
    assert.equal(createPromptReferenceId("  msg-1  "), createPromptReferenceIdFromMessageId("msg-1"), "the id is trimmed before it is used");
  });

  it("is valid only when it is exactly the right shape", () => {
    for (const candidate of ["abcdefg", "ABC1234", "1234567"]) assert.equal(isValidPromptReferenceId(candidate), true, candidate);
    for (const candidate of ["abcdef", "abcdefgh", "abc 123", "", "abcdef-", "ünïabcd"]) assert.equal(isValidPromptReferenceId(candidate), false, candidate);
  });
});

describe("the tag a reference is carried in", () => {
  it("is written around the reference, for a message and for a tool call", () => {
    assert.equal(renderUserMessageIdTag("abcdefg"), "<user_message_id>abcdefg</user_message_id>");
    assert.equal(renderToolCallIdTag("abcdefg"), "<tool_call_id>abcdefg</tool_call_id>");
  });

  it("is read back off the front of a message, in either spelling it has had", () => {
    assert.deepEqual(parseLeadingUserMessageIdTag("<user_message_id>abcdefg</user_message_id>\nhello"), { id: "abcdefg", strippedText: "hello" });
    assert.deepEqual(parseLeadingUserMessageIdTag("<user_message_id> abcdefg </user_message_id>hello"), { id: "abcdefg", strippedText: "hello" });
    assert.deepEqual(parseLeadingUserMessageIdTag("<user_message_id>message_id=abcdefg</user_message_id>\nhello"), { id: "abcdefg", strippedText: "hello" });
  });

  it("is nothing when the message does not open with one", () => {
    assert.equal(parseLeadingUserMessageIdTag("hello"), undefined);
    assert.equal(parseLeadingUserMessageIdTag("<user_message_id>short</user_message_id>"), undefined);
  });
});

describe("the reference a tool call already carries", () => {
  it("is the suffix when the id ends in one", () => {
    assert.equal(createToolCallReferenceId("call_abc_1234567"), "1234567");
    assert.equal(createToolCallReferenceId("a_b_c_ABCDEFG"), "ABCDEFG");
  });

  it("is the id itself when the suffix is not a reference, or there is none", () => {
    assert.equal(createToolCallReferenceId("call_123456"), "call_123456", "a suffix shorter than a reference is no reference");
    assert.equal(createToolCallReferenceId("no-underscore"), "no-underscore");
    assert.equal(createToolCallReferenceId("x_1234567890"), "1234567", "a longer suffix is cut to the reference's length");
    assert.equal(createToolCallReferenceId("  spaced_abcdefg  "), "abcdefg");
    assert.equal(createToolCallReferenceId(""), "");
    assert.equal(createToolCallReferenceId("call_ab-cdefg"), "call_ab-cdefg", "a suffix that is not a reference leaves the id whole");
    assert.equal(createToolCallReferenceId("x_abcdef"), "x_abcdef", "a suffix of six characters is not a reference");
  });
});

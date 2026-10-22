import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  METADATA_MARKER,
  SMART_MODE_CLASSIFIER_MANUAL_REVIEW_ERROR_REASON,
  parseSmartModeClassifierFailureMetadata,
} from "../../source/packages/agent/utils/smart-mode-error-metadata.ts";

const parse = (error: string | undefined) => parseSmartModeClassifierFailureMetadata(error);

describe("the metadata a failed classification carries", () => {
  it("is absent unless the error carries the marker", () => {
    assert.equal(parse(undefined), undefined);
    assert.equal(parse(""), undefined);
    assert.equal(parse("Something went wrong"), undefined);
    assert.equal(parse(METADATA_MARKER), undefined, "the marker alone has no payload");
    assert.equal(parse(METADATA_MARKER + "not json"), undefined);
  });

  it("is read back from the JSON written after the marker", () => {
    assert.deepEqual(parse(METADATA_MARKER + '{"failureReason":"the tool was unavailable","retryable":true}'), {
      failureReason: "the tool was unavailable",
      retryable: true,
    });
    assert.deepEqual(parse("the classifier failed  " + METADATA_MARKER + '{"retryable":false}'), {
      failureReason: undefined,
      retryable: false,
    });
    assert.deepEqual(parse(METADATA_MARKER + '{"failureReason":"café ☕"}'), {
      failureReason: "café ☕",
      retryable: undefined,
    });
  });

  it("reads the first marker in the text", () => {
    assert.deepEqual(parse("before" + METADATA_MARKER + '{"failureReason":"one"}'), { failureReason: "one", retryable: undefined });
    assert.equal(
      parse("first" + METADATA_MARKER + '{"failureReason":"one"}' + METADATA_MARKER + "{}"),
      undefined,
      "the first payload is everything after it, so a second marker makes it unreadable",
    );
  });

  it("keeps a field only when it has the field's own type", () => {
    assert.deepEqual(parse(METADATA_MARKER + '{"failureReason":7,"retryable":"yes"}'), { failureReason: undefined, retryable: undefined });
    assert.deepEqual(parse(METADATA_MARKER + '{"failureReason":"","retryable":true}'), { failureReason: "", retryable: true }, "an empty reason is still a string");
    assert.deepEqual(parse(METADATA_MARKER + '{"failureReason":null,"retryable":null}'), { failureReason: undefined, retryable: undefined });
    assert.deepEqual(parse(METADATA_MARKER + '{"failureReason":"why","other":1}'), { failureReason: "why", retryable: undefined });
  });

  it("answers the shape for any JSON object, even one that says nothing", () => {
    const empty = { failureReason: undefined, retryable: undefined };
    assert.deepEqual(parse(METADATA_MARKER + "{}"), empty);
    assert.deepEqual(parse(METADATA_MARKER + "[]"), empty, "an array is an object to the reader, and its named fields are absent");
    assert.deepEqual(Object.keys(parse(METADATA_MARKER + "{}") ?? {}), ["failureReason", "retryable"]);
  });

  it("answers nothing when the payload is not a JSON object", () => {
    for (const payload of ["null", "true", "false", "42", '"text"', "{} trailing", "{"]) {
      assert.equal(parse(METADATA_MARKER + payload), undefined, payload);
    }
  });

  it("exports the marker and the sentence the rest of the platform writes", () => {
    assert.equal(METADATA_MARKER, "\n\nSmartModeClassifierFailureMetadata:");
    assert.equal(SMART_MODE_CLASSIFIER_MANUAL_REVIEW_ERROR_REASON, "An error occured while classifying this action. Please review manually.");
  });
});

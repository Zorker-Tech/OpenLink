import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SLATE_COMPUTER_USE_MODEL_SELECTION,
  SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID,
  SLATE_SUMMARIZATION_MODEL_ID,
  isSlateAgentModelSelection,
  resolveComputerUseModelSelection,
} from "../../source/shared/agents/slate-agent-model.ts";

describe("the platform's own agent models", () => {
  it("names the model a summary runs on and the one a computer use turn runs on", () => {
    assert.equal(SLATE_SUMMARIZATION_MODEL_ID, "gemini-2.5-flash");
    assert.equal(SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID, "claude-opus-4-8");
    assert.deepEqual(SLATE_COMPUTER_USE_MODEL_SELECTION, {
      modelId: SLATE_COMPUTER_USE_SUBAGENT_MODEL_ID,
      maxMode: false,
      parameters: [
        { id: "thinking", value: "false" },
        { id: "effort", value: "low" },
      ],
    });
  });
});

describe("a model selection", () => {
  it("is recognized when it names a model, a mode and well-formed parameters", () => {
    assert.equal(isSlateAgentModelSelection({ modelId: "m", maxMode: false, parameters: [] }), true);
    assert.equal(isSlateAgentModelSelection({ modelId: "m", maxMode: true, parameters: [{ id: "thinking", value: "false" }] }), true);
    assert.equal(isSlateAgentModelSelection({ modelId: "m", maxMode: true, parameters: [{ id: "a", value: "" }], extra: 1 }), true, "extra fields are the caller's business");
  });

  it("is not recognized when the outer shape is not a plain record", () => {
    const notRecords = [undefined, null, 0, 42, "m", "{}", true, [], [{}], new (class {})(), Object.create(null)];
    for (const [index, value] of notRecords.entries()) {
      assert.equal(isSlateAgentModelSelection(value), false, "case " + index);
    }
    assert.equal(
      isSlateAgentModelSelection(Object.assign([], { modelId: "m", maxMode: false, parameters: [] })),
      false,
      "an array that carries the fields is still an array",
    );
  });

  it("is not recognized when the model is unnamed or the mode is not a boolean", () => {
    assert.equal(isSlateAgentModelSelection({ maxMode: false, parameters: [] }), false);
    assert.equal(isSlateAgentModelSelection({ modelId: "", maxMode: false, parameters: [] }), false, "an empty model id names nothing");
    assert.equal(isSlateAgentModelSelection({ modelId: 7, maxMode: false, parameters: [] }), false);
    assert.equal(isSlateAgentModelSelection({ modelId: "m", parameters: [] }), false);
    assert.equal(isSlateAgentModelSelection({ modelId: "m", maxMode: "false", parameters: [] }), false);
    assert.equal(isSlateAgentModelSelection({ modelId: "m", maxMode: false }), false);
    assert.equal(isSlateAgentModelSelection({ modelId: "m", maxMode: false, parameters: "none" }), false);
  });

  it("is not recognized when any parameter is not a named string value", () => {
    for (const parameter of [null, [], "thinking", { id: "", value: "x" }, { id: 3, value: "x" }, { id: "thinking" }, { id: "thinking", value: 4 }, {}]) {
      assert.equal(
        isSlateAgentModelSelection({ modelId: "m", maxMode: false, parameters: [parameter] }),
        false,
        JSON.stringify(parameter),
      );
    }
  });
});

describe("the computer use model", () => {
  it("is the explicit choice when there is one, and the stored one otherwise", () => {
    const stored = { modelId: "stored", maxMode: false, parameters: [] };
    const override = { modelId: "override", maxMode: true, parameters: [{ id: "effort", value: "high" }] };
    assert.equal(resolveComputerUseModelSelection({ storedModel: stored, overrideModel: override }), override);
    assert.equal(resolveComputerUseModelSelection({ storedModel: stored }), stored);
    assert.equal(resolveComputerUseModelSelection({ overrideModel: override }), override);
    assert.equal(resolveComputerUseModelSelection({}), undefined);
  });

  it("falls back to the stored selection when the explicit choice is null", () => {
    const stored = { modelId: "stored", maxMode: false, parameters: [] };
    assert.equal(resolveComputerUseModelSelection({ storedModel: stored, overrideModel: null as never }), stored, "null means no explicit choice");
  });
});

/**
 * Where an entry stands in a conversation, worked out from what is there: the lines a checkpoint derives, what a change
 * since the last checkpoint re-derives, and what it refuses to believe.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTranscriptOccurrenceDeriver } from "../../source/host/transcript/mirror/transcript-occurrence-deriver.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

/** The generated decoding, faked at the boundary it is handed over: blobs are the words they were written as. */
function codec(turns: Map<string, unknown>, steps: Map<string, unknown>, users: Map<string, unknown> = new Map()) {
  const calls: unknown[][] = [];
  return {
    calls,
    value: {
      decodeTurn: (value: Uint8Array) => { calls.push(["turn", text(value)]); return turns.get(text(value)) ?? { case: undefined }; },
      decodeUserMessage: (value: Uint8Array) => { calls.push(["user", text(value)]); return users.get(text(value)) ?? { text: text(value) }; },
      decodeStep: (value: Uint8Array) => { calls.push(["step", text(value)]); return steps.get(text(value)) ?? { case: undefined }; },
    },
  };
}

/** The blobs a transcript is made of: each one holds its own name, unless the test says it is missing. */
const storeOf = (missing: string[] = []) => ({ getBlob: async (_context: unknown, id: Uint8Array) => (missing.includes(text(id)) ? undefined : bytes(text(id))) });

const agentTurn = (userMessage: string, steps: string[]) => ({ case: "agent", userMessage: bytes(userMessage), steps: steps.map((step) => bytes(step)) });
const checkpoint = (...turns: Uint8Array[]) => ({ turns });

describe("deriving what a conversation holds", () => {
  it("refuses a codec that could not decode a transcript at all", () => {
    assert.throws(() => createTranscriptOccurrenceDeriver(undefined as never), { name: "TypeError", message: "generated transcript occurrence codec is incomplete" });
    assert.throws(() => createTranscriptOccurrenceDeriver({ decodeTurn: () => ({ case: undefined }) } as never), { name: "TypeError", message: "generated transcript occurrence codec is incomplete" });
    const complete = createTranscriptOccurrenceDeriver(codec(new Map(), new Map()).value as never);
    assert.equal(typeof complete.initial, "function");
    assert.equal(typeof complete.derive, "function");
  });

  it("derives the user's line, what the agent said and what it did", async () => {
    const turns = new Map([["turn-0", agentTurn("user-0", ["step-0", "step-1", "step-2", "step-3"])], ["turn-1", agentTurn("user-1", [])]]);
    const steps = new Map<string, unknown>([
      ["step-0", { case: "assistant", text: "Here you go." }],
      ["step-1", { case: "tool", name: "Grep", input: { pattern: "x" }, result: { hits: 1 } }],
      ["step-2", { case: "tool", name: "Write", input: { path: "/notes.md" } }],
      ["step-3", { case: "thinking", text: "<thinking>hmm</thinking>Done." }],
    ]);
    const users = new Map([["user-0", { text: "where is it?" }], ["user-1", { text: "thanks" }]]);
    const deriver = createTranscriptOccurrenceDeriver(codec(turns, steps, users).value as never);
    const derived = await deriver.initial({}, storeOf(), checkpoint(bytes("turn-0"), bytes("turn-1")) as never);
    // Every line says which turn and which step it came from, and what the reader should see.
    assert.deepEqual(derived.map((occurrence) => occurrence.id), [
      "turn:0:user", "turn:0:step:0:text", "turn:0:step:1:tool-use", "turn:0:step:1:tool-result", "turn:0:step:2:tool-use", "turn:0:step:3:text", "turn:1:user",
    ]);
    const line = (index: number) => JSON.parse(derived[index]!.line) as { role: string; message?: { content: Array<{ type: string; text?: string }> } };
    assert.deepEqual(line(0), { role: "user", message: { content: [{ type: "text", text: "where is it?" }] } });
    assert.equal(line(1).role, "assistant");
    // A tool call is what the agent did with what it was given, and its result is what the tool answered.
    assert.equal(line(2).role, "assistant");
    assert.equal(line(3).role, "tool");
    // What the agent was thinking is shown as what it said, with the thinking itself left out.
    assert.equal(line(5).message?.content[0]?.text, "Done.");
    // A turn with nothing in it still carries the user's line.
    assert.equal(line(6).message?.content[0]?.text, "thanks");
  });

  it("leaves out what nobody should read, and anything empty", async () => {
    const turns = new Map([["turn-0", agentTurn("user-0", ["step-0", "step-1", "step-2"])]]);
    const steps = new Map<string, unknown>([
      // A hidden tag is not something the user is shown, and a step that is only that is nothing at all.
      ["step-0", { case: "assistant", text: "<think>secret reasoning</think>" }],
      ["step-1", { case: "thinking", text: "   " }],
      ["step-2", { case: undefined }],
    ]);
    const users = new Map([["user-0", { text: "  <user_info>not for the room</user_info>\n\n please help  " }]]);
    const deriver = createTranscriptOccurrenceDeriver(codec(turns, steps, users).value as never);
    const derived = await deriver.initial({}, storeOf(), checkpoint(bytes("turn-0")) as never);
    // Only the user's own words are left.
    assert.deepEqual(derived.map((occurrence) => occurrence.id), ["turn:0:user"]);
    const line = JSON.parse(derived[0]!.line) as { message: { content: Array<{ text: string }> } };
    assert.equal(line.message.content[0]?.text.includes("please help"), true);
    assert.equal(line.message.content[0]?.text.includes("not for the room"), false);
  });

  it("takes the user's words from the blob they were put in when the message itself carries none", async () => {
    const turns = new Map([["turn-0", agentTurn("user-blob", [])]]);
    const users = new Map([["user-blob", { text: "", textBlobId: bytes("the words themselves") }]]);
    const deriver = createTranscriptOccurrenceDeriver(codec(turns, new Map(), users).value as never);
    const derived = await deriver.initial({}, storeOf(), checkpoint(bytes("turn-0")) as never);
    // What the message carried as a blob is what the reader is shown.
    const line = JSON.parse(derived[0]!.line) as { message: { content: Array<{ text: string }> } };
    assert.equal(line.message.content[0]?.text, "the words themselves");
  });

  it("refuses to carry a conversation that does not hold together", async () => {
    const cases: Array<[string, { turns: Map<string, unknown>; steps?: Map<string, unknown>; users?: Map<string, unknown>; missing?: string[]; error: string }]> = [
      ["a turn of a kind this platform does not have", { turns: new Map([["turn-0", { case: "shell" }]]), error: "Slate does not support shell conversation turns" }],
      ["a message that is not there", { turns: new Map([["turn-0", agentTurn("user-0", [])]]), missing: ["user-0"], error: "missing user-message blob while deriving transcript checkpoint" }],
      ["a step that is not there", { turns: new Map([["turn-0", agentTurn("user-0", ["step-0"])]]), missing: ["step-0"], error: "missing conversation-step blob while deriving transcript checkpoint" }],
    ];
    for (const [label, setup] of cases) {
      const deriver = createTranscriptOccurrenceDeriver(codec(setup.turns, setup.steps ?? new Map(), setup.users ?? new Map()).value as never);
      await deriver.initial({}, storeOf(setup.missing ?? []), checkpoint(bytes("turn-0")) as never).then(
        () => assert.fail(`${label} was derived anyway`),
        (error: Error) => assert.equal(error.message, setup.error, label),
      );
    }
  });

  it("re-derives only what changed since the last checkpoint", async () => {
    const previous = checkpoint(bytes("turn-0"));
    const unchanged = checkpoint(bytes("turn-0"));
    const deriver = createTranscriptOccurrenceDeriver(codec(new Map(), new Map()).value as never);
    // Nothing changed and nothing was deferred: nothing is derived.
    assert.deepEqual(await deriver.derive({}, storeOf(), previous as never, unchanged as never, false), { occurrences: [] });
    // A turn that moved backwards, and a history that changed behind the active turn, are both refused.
    await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0"), bytes("turn-1")) as never, checkpoint(bytes("turn-0")) as never, false).then(
      () => assert.fail("a conversation that lost a turn was accepted"),
      (error: Error) => assert.equal(error.message, "durable conversation turns moved backwards"),
    );
    await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0"), bytes("turn-1"), bytes("turn-2")) as never, checkpoint(bytes("turn-0"), bytes("turn-1-changed"), bytes("turn-2"), bytes("turn-3")) as never, false).then(
      () => assert.fail("a history that changed behind the active turn was accepted"),
      (error: Error) => assert.equal(error.message, "durable conversation history changed before the active turn"),
    );
  });

  it("derives the active turn again and the new ones after it", async () => {
        const turns = new Map([
      ["turn-0", agentTurn("user-0", [])],
      ["turn-0-new", agentTurn("user-0", ["step-0"])],
      ["turn-1", agentTurn("user-1", [])],
      ["turn-2", agentTurn("user-2", ["step-2"])],
    ]);
    const steps = new Map<string, unknown>([
      ["step-0", { case: "assistant", text: "the first answer" }],
      ["step-2", { case: "assistant", text: "still being written" }],
    ]);
    const users = new Map([["user-0", { text: "first" }], ["user-1", { text: "second" }], ["user-2", { text: "third" }]]);
    const writer = codec(turns, steps, users);
    const deriver = createTranscriptOccurrenceDeriver(writer.value as never);
    const derived = await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0")) as never, checkpoint(bytes("turn-0-new"), bytes("turn-1")) as never, true);
    // The turn that changed is derived again — without its user line, which was already there — and the new one whole.
    assert.deepEqual(derived.occurrences.map((occurrence) => occurrence.id), ["turn:0:step:0:text", "turn:1:user"]);
    // A turn that is still being written is not finished: its last words are held back for the next checkpoint.
    const writing = await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0"), bytes("turn-1")) as never, checkpoint(bytes("turn-0"), bytes("turn-1"), bytes("turn-2")) as never, false);
    // A turn that is still being written keeps its last words back for the next checkpoint.
    assert.deepEqual(writing.occurrences.map((occurrence) => occurrence.id), ["turn:2:user"]);
    assert.deepEqual(writing.deferredStep, { turnIndex: 2, stepIndex: 0 });
    // Being told about it again is not enough: it is written once the turn is finished.
    const stillWriting = await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0"), bytes("turn-1"), bytes("turn-2")) as never, checkpoint(bytes("turn-0"), bytes("turn-1"), bytes("turn-2")) as never, false, writing.deferredStep);
    assert.deepEqual(stillWriting.occurrences, []);
    assert.deepEqual(stillWriting.deferredStep, writing.deferredStep);
    const finished = await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0"), bytes("turn-1"), bytes("turn-2")) as never, checkpoint(bytes("turn-0"), bytes("turn-1"), bytes("turn-2")) as never, true, writing.deferredStep);
    assert.deepEqual(finished.occurrences.map((occurrence) => occurrence.id), ["turn:2:step:0:text"]);
    assert.equal(finished.deferredStep, undefined);
  });

  it("refuses a conversation whose recorded past no longer matches", async () => {
    const cases: Array<[string, { previousTurn: unknown; currentTurn: unknown; previousStep?: unknown; currentStep?: unknown; error: string }]> = [
      ["a turn that changed kind", { previousTurn: agentTurn("user-0", []), currentTurn: { case: undefined }, error: "durable conversation turn changed kind" }],
      ["a user message that changed", { previousTurn: agentTurn("user-0", []), currentTurn: agentTurn("user-other", []), error: "durable agent user message changed after checkpoint" }],
      ["steps that moved backwards", { previousTurn: agentTurn("user-0", ["step-0", "step-1"]), currentTurn: agentTurn("user-0", ["step-0"]), error: "durable agent steps moved backwards" }],
      ["a step that changed before the tail", { previousTurn: agentTurn("user-0", ["step-0", "step-1"]), currentTurn: agentTurn("user-0", ["step-changed", "step-1"]), error: "durable agent step changed before the checkpoint tail" }],
      ["a tool call that was renamed", { previousTurn: agentTurn("user-0", ["step-tool"]), currentTurn: agentTurn("user-0", ["step-tool-changed-name"]), previousStep: { case: "tool", name: "Grep", input: {} }, currentStep: { case: "tool", name: "Write", input: {} }, error: "durable tool call changed after checkpoint" }],
      ["a tool call that was completed and then changed", { previousTurn: agentTurn("user-0", ["step-tool"]), currentTurn: agentTurn("user-0", ["step-tool-with-result"]), previousStep: { case: "tool", name: "Grep", input: {}, result: { hits: 1 } }, currentStep: { case: "tool", name: "Grep", input: {}, result: { hits: 2 } }, error: "completed durable tool call changed after checkpoint" }],
    ];
    for (const [label, setup] of cases) {
      const turns = new Map([["turn-0", setup.previousTurn], ["turn-0-changed", setup.currentTurn]]);
      const steps = new Map<string, unknown>([["step-0", { case: "assistant", text: "one" }], ["step-1", { case: "assistant", text: "two" }], ["step-tool", setup.previousStep], ["step-tool-changed-name", setup.currentStep], ["step-tool-with-result", setup.currentStep]]);
      const deriver = createTranscriptOccurrenceDeriver(codec(turns, steps, new Map([["user-0", { text: "hello" }], ["user-other", { text: "hello" }]])).value as never);
      await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0")) as never, checkpoint(bytes("turn-0-changed")) as never, true).then(
        () => assert.fail(`${label} was accepted`),
        (error: Error) => assert.equal(error.message, setup.error, label),
      );
    }
  });

  it("refuses a step that changed kind and a tool call whose input changed", async () => {
    const kindTurns = new Map([["turn-0", agentTurn("user-0", ["step-tool"])], ["turn-changed", agentTurn("user-0", ["step-text"])]]);
    const kindSteps = new Map<string, unknown>([["step-tool", { case: "tool", name: "Grep", input: {} }], ["step-text", { case: "assistant", text: "one" }]]);
    const kindDeriver = createTranscriptOccurrenceDeriver(codec(kindTurns, kindSteps, new Map([["user-0", { text: "hello" }]])).value as never);
    await assert.rejects(() => kindDeriver.derive({}, storeOf(), checkpoint(bytes("turn-0")) as never, checkpoint(bytes("turn-changed")) as never, true), { message: "durable conversation step changed kind" });
    const inputTurns = new Map([["turn-0", agentTurn("user-0", ["step-tool"])], ["turn-changed", agentTurn("user-0", ["step-tool-changed"])]]);
    const inputSteps = new Map<string, unknown>([["step-tool", { case: "tool", name: "Grep", input: { pattern: "x" } }], ["step-tool-changed", { case: "tool", name: "Grep", input: { pattern: "y" } }]]);
    const inputDeriver = createTranscriptOccurrenceDeriver(codec(inputTurns, inputSteps, new Map([["user-0", { text: "hello" }]])).value as never);
    await assert.rejects(() => inputDeriver.derive({}, storeOf(), checkpoint(bytes("turn-0")) as never, checkpoint(bytes("turn-changed")) as never, true), { message: "durable tool call changed after checkpoint" });
  });

  it("derives the rest of a tool call that was already recorded, without saying it was used again", async () => {
    const turns = new Map([["turn-0", agentTurn("user-0", ["step-0"])], ["turn-0-with-result", agentTurn("user-0", ["step-0-with-result"])]]);
    const steps = new Map<string, unknown>([
      ["step-0", { case: "tool", name: "Grep", input: { pattern: "x" } }],
      ["step-0-with-result", { case: "tool", name: "Grep", input: { pattern: "x" }, result: { hits: 2 } }],
    ]);
    const deriver = createTranscriptOccurrenceDeriver(codec(turns, steps, new Map([["user-0", { text: "hello" }]])).value as never);
    const derived = await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0")) as never, checkpoint(bytes("turn-0-with-result")) as never, true);
    // Only the answer is new: the call itself was already read.
    assert.deepEqual(derived.occurrences.map((occurrence) => occurrence.id), ["turn:0:step:0:tool-result"]);
  });

  it("reads the user words from their own blob and strips hidden thinking from the agent answer", async () => {
    const turns = new Map([["turn-0", agentTurn("user-with-blob", ["step-think", "step-empty"])]]);
    const steps = new Map<string, unknown>([
      ["step-think", { case: "assistant", text: "<THINK>plan</THINK>the answer" }],
      ["step-empty", { case: "assistant", text: "   " }],
    ]);
    const users = new Map([["user-with-blob", { text: "", textBlobId: bytes("user-blob") }]]);
    const deriver = createTranscriptOccurrenceDeriver(codec(turns, steps, users).value as never);
    const derived = await deriver.initial({}, storeOf(), checkpoint(bytes("turn-0")) as never);
    assert.deepEqual(derived.map((occurrence) => occurrence.id), ["turn:0:user", "turn:0:step:0:text"]);
    assert.deepEqual(JSON.parse(derived[0]!.line), { role: "user", message: { content: [{ type: "text", text: "user-blob" }] } });
    assert.deepEqual(JSON.parse(derived[1]!.line), { role: "assistant", message: { content: [{ type: "text", text: "the answer" }] } });
  });

  it("refuses a shell turn and names a blob that is missing", async () => {
    const shell = createTranscriptOccurrenceDeriver(codec(new Map([["turn-shell", { case: "shell" }]]), new Map()).value as never);
    await assert.rejects(() => shell.initial({}, storeOf(), checkpoint(bytes("turn-shell")) as never), { message: "Slate does not support shell conversation turns" });
    const full = new Map([["turn-0", agentTurn("user-0", ["step-0"])]]);
    const steps = new Map([["step-0", { case: "assistant", text: "one" }]]);
    const users = new Map([["user-0", { text: "hello" }]]);
    const deriver = createTranscriptOccurrenceDeriver(codec(full, steps, users).value as never);
    await assert.rejects(() => deriver.initial({}, storeOf(["turn-0"]), checkpoint(bytes("turn-0")) as never), { message: "missing conversation-turn blob while deriving transcript checkpoint" });
    await assert.rejects(() => deriver.initial({}, storeOf(["user-0"]), checkpoint(bytes("turn-0")) as never), { message: "missing user-message blob while deriving transcript checkpoint" });
    await assert.rejects(() => deriver.initial({}, storeOf(["step-0"]), checkpoint(bytes("turn-0")) as never), { message: "missing conversation-step blob while deriving transcript checkpoint" });
  });

  it("holds a thinking step back while its turn is still being written", async () => {
    const turns = new Map([["turn-0", agentTurn("user-0", ["step-think"])]]);
    const steps = new Map([["step-think", { case: "thinking", text: "still thinking" }]]);
    const deriver = createTranscriptOccurrenceDeriver(codec(turns, steps, new Map([["user-0", { text: "hello" }]])).value as never);
    const writing = await deriver.derive({}, storeOf(), checkpoint() as never, checkpoint(bytes("turn-0")) as never, false);
    assert.deepEqual(writing.occurrences.map((occurrence) => occurrence.id), ["turn:0:user"]);
    assert.deepEqual(writing.deferredStep, { turnIndex: 0, stepIndex: 0 });
    const finished = await deriver.derive({}, storeOf(), checkpoint(bytes("turn-0")) as never, checkpoint(bytes("turn-0")) as never, true, writing.deferredStep);
    assert.deepEqual(finished.occurrences.map((occurrence) => occurrence.id), ["turn:0:step:0:text"]);
    assert.equal(finished.deferredStep, undefined);
  });

  it("refuses a codec that cannot decode a step", () => {
    assert.throws(() => createTranscriptOccurrenceDeriver({ decodeTurn: () => ({ case: undefined }), decodeUserMessage: () => ({ text: "" }) } as never), { name: "TypeError", message: "generated transcript occurrence codec is incomplete" });
  });

  it("names the role each tool line is written as, and skips a step it does not know", async () => {
    const turns = new Map([["turn-0", agentTurn("user-0", ["step-use", "step-other"])]]);
    const steps = new Map<string, unknown>([
      ["step-use", { case: "tool", name: "Grep", input: { pattern: "x" }, result: { hits: 1 } }],
      ["step-other", { case: "unknown-kind" }],
    ]);
    const deriver = createTranscriptOccurrenceDeriver(codec(turns, steps, new Map([["user-0", { text: "hello" }]])).value as never);
    const derived = await deriver.initial({}, storeOf(), checkpoint(bytes("turn-0")) as never);
    assert.deepEqual(derived.map((occurrence) => occurrence.id), ["turn:0:user", "turn:0:step:0:tool-use", "turn:0:step:0:tool-result"]);
    assert.equal(JSON.parse(derived[1]!.line).role, "assistant");
    assert.equal(JSON.parse(derived[2]!.line).role, "tool");
  });
});


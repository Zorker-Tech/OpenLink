import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as tool from "../../source/host/runner/tools/slate-computer-tool.ts";

const makeDeps = (log: unknown[][], options: Record<string, unknown> = {}) => ({
  resourceAccessor: { get: () => null },
  execute: async (_context: unknown, args: unknown) => {
    log.push(["execute", args]);
    return options.executionResult ?? { result: { case: "success", value: { screenshot: "aGk=" } } };
  },
  getPersistImage: () => (options.persistMissing ? undefined : async (bytes: unknown, mimeType: unknown) => {
    log.push(["persist", { bytes: Buffer.from(bytes as Uint8Array).toString("utf8"), mimeType }]);
    return { fileUrl: "file:///saved.webp" };
  }),
  isUnicodeTypingEnabled: () => options.unicode ?? false,
  onComputerAction: (action: unknown) => log.push(["reported", action]),
});

describe("the computer tool", () => {
  it("names its buttons, directions, limits and actions", () => {
    assert.deepEqual(tool.MOUSE_BUTTONS, { left: "LEFT", right: "RIGHT", middle: "MIDDLE" });
    assert.deepEqual(tool.SCROLL_DIRECTIONS, { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" });
    assert.equal(tool.SLATE_COMPUTER_MAX_WAIT_MS, 30_000);
    assert.equal(tool.SLATE_COMPUTER_MAX_FOLLOW_UP_ACTIONS, 9);
    assert.deepEqual([...tool.COMPUTER_ACTIONS], ["screenshot", "click", "move", "drag", "type", "key", "scroll", "wait"]);
  });

  it("validates an action, including the drag rule and the enforcing description rule", () => {
    const core = tool.buildComputerActionCoreSchema();
    assert.doesNotThrow(() => core.parse({ action: "drag", x: 1, y: 2, x2: 3, y2: 4 }));
    assert.throws(() => core.parse({ action: "drag" }), { name: "ZodError" });
    assert.doesNotThrow(() => core.parse({ action: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }));
    assert.throws(() => core.parse({ action: "click", x: 1.5, y: 2 }), { name: "ZodError" });
    assert.throws(() => core.parse({ action: "click", x: 1, y: 2, count: 4 }), { name: "ZodError" });
    assert.doesNotThrow(() => core.parse({ action: "click", x: 1, y: 2, button: "middle" }));
    assert.throws(() => core.parse({ action: "wait", durationMs: 30_001 }), { name: "ZodError" });
    assert.equal(tool.buildComputerParameters().safeParse({ action: "click", x: 1, y: 2 }).success, true);
    const enforcing = tool.buildComputerParameters({ mode: "enforce" });
    assert.equal(enforcing.safeParse({ action: "click", x: 1, y: 2 }).success, false);
    assert.equal(enforcing.safeParse({ action: "click", x: 1, y: 2, description: "press" }).success, true);
    assert.equal(enforcing.safeParse({ action: "click", x: 1, y: 2, description: "   " }).success, false);
    assert.equal(enforcing.safeParse({ action: "screenshot" }).success, true);
    assert.equal(tool.computerActionParameters.safeParse({ action: "scroll", direction: "left" }).success, true);
    assert.equal(tool.computerActionParameters.safeParse({ action: "bogus" }).success, false);
    assert.deepEqual(tool.screenshotParameters.parse({}), {});
  });

  it("converts an action to the box protocol, with its defaults", () => {
    assert.deepEqual(tool.toAction({ action: "screenshot" }), { action: { case: "screenshot", value: {} } });
    assert.deepEqual(tool.toAction({ action: "click", x: 1, y: 2 }), { action: { case: "click", value: { coordinate: { x: 1, y: 2 }, button: "LEFT", count: 1 } } });
    assert.deepEqual(tool.toAction({ action: "click", x: 1, y: 2, button: "middle", count: 2 }), { action: { case: "click", value: { coordinate: { x: 1, y: 2 }, button: "MIDDLE", count: 2 } } });
    assert.deepEqual(tool.toAction({ action: "move" }), { action: { case: "mouseMove", value: {} } });
    assert.deepEqual(tool.toAction({ action: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }), { action: { case: "drag", value: { path: [{ x: 1, y: 2 }, { x: 3, y: 4 }], button: "LEFT" } } });
    assert.throws(() => tool.toAction({ action: "drag" }), { name: "SlateToolInputError", message: "Drag requires x, y, x2, and y2 or a path with at least 2 points." });
    assert.deepEqual(tool.toAction({ action: "type" }), { action: { case: "type", value: { text: "" } } });
    assert.deepEqual(tool.toAction({ action: "key", key: "Enter" }), { action: { case: "key", value: { key: "Enter" } } });
    assert.deepEqual(tool.toAction({ action: "scroll", x: 5, y: 6, direction: "up", amount: 7 }), { action: { case: "scroll", value: { coordinate: { x: 5, y: 6 }, direction: "UP", amount: 7 } } });
    assert.deepEqual(tool.toAction({ action: "scroll" }), { action: { case: "scroll", value: { direction: "DOWN", amount: 3 } } });
    assert.deepEqual(tool.toAction({ action: "wait" }), { action: { case: "wait", value: { durationMs: 1_000 } } });
    assert.equal(tool.toAction({ action: "bogus" } as never), undefined, "an action outside the union converts to nothing");
  });

  it("reports where a batch worked, preferring a non-drag", () => {
    assert.deepEqual(tool.toReportedAction({ action: "drag", x: 1, y: 2, x2: 3, y2: 4 }), { type: "drag", x: 1, y: 2 });
    assert.deepEqual(tool.toReportedAction({ action: "click", x: 1, y: 2, button: "right", count: 2 }), { type: "click", x: 1, y: 2, button: "right", count: 2 });
    assert.deepEqual(tool.toReportedAction({ action: "click", x: 1, y: 2 }), { type: "click", x: 1, y: 2, button: "left", count: 1 });
    assert.deepEqual(tool.toReportedAction({ action: "scroll", x: 5, y: 6 }), { type: "scroll", x: 5, y: 6 });
    assert.equal(tool.toReportedAction({ action: "move" }), undefined);
    assert.equal(tool.toReportedAction({ action: "screenshot" }), undefined);
    const drag = { action: "drag", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } as never;
    const move = { action: "move", x: 5, y: 6 } as never;
    assert.deepEqual(tool.reportedBatchPosition([drag, move]), { type: "move", x: 5, y: 6 });
    assert.deepEqual(tool.reportedBatchPosition([drag]), { type: "drag", x: 1, y: 2 });
    assert.deepEqual(tool.reportedBatchPosition([move, drag]), { type: "move", x: 5, y: 6 }, "a drag later in the batch does not win");
    assert.equal(tool.reportedBatchPosition([]), undefined);
    assert.deepEqual(tool.dragPath(drag), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    assert.deepEqual(tool.dragPath({ action: "drag", x: 1, y: 2, x2: 3, y2: 4 }), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    assert.equal(tool.dragPath({ action: "drag", path: [{ x: 1, y: 2 }] }), undefined);
    assert.deepEqual(Object.keys(tool.toExactActionArgs({ action: "click", x: 1, y: 2, description: "d", then: [] })), ["action", "x", "y"]);
  });

  it("describes an outcome as a heading with the details a caller cares about", () => {
    assert.equal(tool.describeOutcome({ result: { case: "error", value: { error: "it broke" } } } as never, "screenshot"), "Screenshot failed: it broke");
    assert.equal(tool.describeOutcome({ result: { case: "error", value: { error: "it broke" } } } as never, "computer"), "Computer action failed: it broke");
    assert.equal(tool.describeOutcome({ result: { case: "success", value: {} } } as never, "screenshot"), "Screenshot captured from the box desktop.");
    assert.equal(tool.describeOutcome({ result: { case: "weird", value: {} } } as never, "computer"), "Computer action ran on the box desktop.");
    assert.equal(tool.describeOutcome({ result: { case: "success", value: { screenshotPath: "" } } } as never, "computer"), "Computer action ran on the box desktop.");
    assert.equal(
      tool.describeOutcome({ result: { case: "success", value: { screenshotPath: "p/x.webp", cursorPosition: { x: 3, y: 4 } } } } as never, "computer"),
      "Computer action ran on the box desktop.\nScreenshot saved to p/x.webp.\nCursor is at (3, 4).",
    );
  });

  it("runs the screenshot tool and saves what it captured", async () => {
    const log: unknown[][] = [];
    const screenshotTool = tool.createScreenshotTool(makeDeps(log) as never);
    assert.equal(screenshotTool.id, "OPENAI_COMPUTER_USE");
    assert.equal(screenshotTool.name, "Screenshot");
    const response = await screenshotTool.execute({}, { context: {}, toolCallId: "call-1" });
    assert.deepEqual(log[0], ["execute", { toolCallId: "call-1", actions: [{ action: { case: "screenshot", value: {} } }] }]);
    assert.deepEqual(log[1], ["persist", { bytes: "hi", mimeType: "image/webp" }]);
    const emptyLog: unknown[][] = [];
    const emptyTool = tool.createScreenshotTool(makeDeps(emptyLog, { executionResult: { result: { case: "success", value: { screenshot: "" } } } }) as never);
    await emptyTool.execute({}, { context: {} });
    assert.equal(emptyLog.some((entry) => entry[0] === "persist"), false, "an empty screenshot is not saved");
    assert.equal((response as never as { result: { value: { screenshotPath: string } } }).result.value.screenshotPath, "file:///saved.webp");
    assert.deepEqual(screenshotTool.render(response), { content: "Screenshot captured from the box desktop.\nScreenshot saved to file:///saved.webp." });
  });

  it("runs the computer tool, appends a screenshot and hands the details on", async () => {
    const log: unknown[][] = [];
    const computerTool = tool.createComputerTool(makeDeps(log, { unicode: true }) as never);
    const response = await computerTool.execute({ action: "click", x: 1, y: 2, description: "  press it  " }, { context: {} });
    const executeEntry = log.find((entry) => entry[0] === "execute");
    assert.notEqual(executeEntry, undefined);
    const call = executeEntry?.[1] as Record<string, unknown>;
    assert.equal(call.toolCallId, "");
    assert.deepEqual(call.actions, [
      { action: { case: "click", value: { coordinate: { x: 1, y: 2 }, button: "LEFT", count: 1 } } },
      { action: { case: "screenshot", value: {} } },
    ]);
    assert.equal(call.bindUnmappedCharacters, true);
    assert.equal(call.description, "press it");
    assert.deepEqual(log.find((entry) => entry[0] === "reported"), ["reported", { type: "click", x: 1, y: 2, button: "left", count: 1 }]);
    assert.deepEqual(computerTool.render(response), { content: "Computer action ran on the box desktop.\nScreenshot saved to file:///saved.webp." });
    await assert.rejects(() => computerTool.execute({ action: "drag" }, { context: {} }), { name: "ZodError" });
    const screenshotOnly = tool.createComputerTool(makeDeps([]) as never);
    await screenshotOnly.execute({ action: "screenshot" }, { context: {} });
    assert.equal((screenshotOnly.render({ result: { case: "success", value: {} } } as never) as { content: string }).content, "Computer action ran on the box desktop.");
  });
});
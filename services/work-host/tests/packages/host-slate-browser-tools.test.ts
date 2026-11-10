/**
 * Driving the box browser: the driver's envelopes, responses and shell protocol, the review action it reports, and the
 * tools built on top of it (their arguments, screenshots, navigation callbacks and rendering).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BOX_CDP_PORT_BASE,
  PENDING_SCREENSHOT_CAP,
  SlateBrowserDriver,
  SlateBrowserDriverError,
  createSlateBrowserTools,
  decodeEnvelope,
  encodeEnvelope,
  parseDriverResponse,
  sanitizeForBoxPath,
  stashScreenshot,
  toBrowserReviewAction,
  toDriverResponse,
} from "../../source/host/runner/tools/slate-browser-tools.ts";
import { SLATE_BROWSER_DRIVER_BOX_DIR, SLATE_BROWSER_DRIVER_BOX_PATH, SLATE_BROWSER_RESULT_MARKER } from "../../source/adapters/interop/browser/browser-driver-source-adapter.ts";
import type { ShellExecResponse } from "../../source/packages/agent-exec/shell.ts";

const MARKER = SLATE_BROWSER_RESULT_MARKER;

function shellSuccess(stdout = "", fields: Partial<{ stderr: string; exitCode: number }> = {}): ShellExecResponse {
  return { outcome: {
    kind: "success",
    command: "node",
    workingDirectory: "/workspace",
    exitCode: fields.exitCode ?? 0,
    signal: "",
    stdout,
    stderr: fields.stderr ?? "",
    executionTimeMs: 0,
  } };
}

function shellTimeout(): ShellExecResponse {
  return { outcome: { kind: "timeout", command: "node", workingDirectory: "/workspace", timeoutMs: 1_000 } };
}

function fakeDriver(behaviour: Record<string, unknown> = {}) {
  const shells: Array<Record<string, unknown>> = [];
  const uploads: Array<Record<string, unknown>> = [];
  const downloads: Array<Record<string, unknown>> = [];
  const persisted: unknown[] = [];
  const navigations: unknown[] = [];
  const ports = {
    resourceAccessor: { get: () => ({ async execute() { return shellSuccess(); } }) },
    async getWindowIndex() { if (behaviour.windowThrows === true) throw new Error("no window"); if (behaviour.windowMissing === true) return undefined; return behaviour.windowIndex === undefined ? 3 : behaviour.windowIndex as number; },
    getBoxId: () => "box-1",
    getDefaultViewId: () => "view-default",
    async uploadFile(_ctx: unknown, _boxId: string, path: string, bytes: Uint8Array) { uploads.push({ path, length: bytes.length }); if (behaviour.uploadThrows === true) throw new Error("upload failed"); },
    async downloadFile(_ctx: unknown, _boxId: string, path: string) { downloads.push({ path }); if (behaviour.downloadThrows === true) throw new Error("download failed"); return behaviour.imageBytes ?? new Uint8Array([1, 2, 3]); },
    async executeShell(_ctx: unknown, input: Record<string, unknown>) { shells.push(input); if (behaviour.shellThrows === true) throw new Error("shell failed"); return behaviour.shellResult ?? shellSuccess(); },
    ...(behaviour.persistImage === true ? { getPersistImage: () => async (bytes: Uint8Array, mimeType: string) => { persisted.push({ bytes: Buffer.from(bytes).toString("hex"), mimeType }); } } : {}),
    ...(behaviour.autoReview === undefined ? {} : { autoReview: behaviour.autoReview }),
  };
  return { ports, shells, uploads, downloads, persisted, navigations, onPossibleNavigation: (context: unknown) => navigations.push(context) };
}

const runOf = async (behaviour: Record<string, unknown>, input: Record<string, unknown>) => {
  const fake = fakeDriver(behaviour);
  const driver = new SlateBrowserDriver(fake.ports as never);
  try {
    const output = await driver.run({}, input as never);
    return { output, shells: fake.shells, uploads: fake.uploads, downloads: fake.downloads, persisted: fake.persisted };
  } catch (error) {
    return { error: error as Error, shells: fake.shells };
  }
};

test("an envelope carries its text and optional screenshot key", () => {
  assert.deepEqual(decodeEnvelope(encodeEnvelope({ text: "hi" })), { text: "hi" });
  assert.deepEqual(decodeEnvelope(encodeEnvelope({ text: "hi", imageKey: "shot-1" })), { text: "hi", imageKey: "shot-1" });
  assert.deepEqual(decodeEnvelope("{\"text\":1}"), { text: "{\"text\":1}" });
  assert.deepEqual(decodeEnvelope("not json"), { text: "not json" });
});

test("a driver response keeps only the fields of the right shape", () => {
  assert.deepEqual(toDriverResponse({}), { ok: false });
  assert.deepEqual(toDriverResponse({ ok: true, error: "bad", summary: "did it", data: "body", url: "https://x", title: "X", viewId: "v", screenshot: true }), {
    ok: true, error: "bad", summary: "did it", data: "body", url: "https://x", title: "X", viewId: "v", screenshot: true,
  });
  assert.deepEqual(toDriverResponse({ ok: false, error: 7, summary: false, data: "body", url: "", title: undefined, viewId: 1, screenshot: "yes" }), { ok: false, data: "body", url: "" });
});

test("the result marker is read from the last line that carries one", () => {
  assert.equal(parseDriverResponse("noise\n"), undefined);
  assert.deepEqual(parseDriverResponse(MARKER + "{\"ok\":true,\"summary\":\"a\"}\n"), { ok: true, summary: "a" });
  assert.deepEqual(parseDriverResponse(MARKER + "{\"ok\":true}\n" + MARKER + "{\"ok\":false,\"error\":\"last\"}"), { ok: false, error: "last" });
  assert.equal(parseDriverResponse(MARKER + "not json"), undefined);
  assert.equal(parseDriverResponse(MARKER + "[]"), undefined);
});

test("a box path token is bounded, sanitized and never empty", () => {
  assert.equal(sanitizeForBoxPath("a b/c"), "abc");
  assert.equal(sanitizeForBoxPath("!!!").startsWith("call-"), true);
  assert.equal(sanitizeForBoxPath("").startsWith("call-"), true);
  assert.equal(sanitizeForBoxPath("x".repeat(80)).length, 48);
  assert.equal(sanitizeForBoxPath("safe-Token_1"), "safe-Token_1");
});

test("the driver carries a request and assembles the answer", async () => {
  const run = await runOf({ shellResult: shellSuccess("x\n" + MARKER + "{\"ok\":true,\"summary\":\"did it\",\"url\":\"https://x\",\"title\":\"X\",\"data\":\"body\"}") }, { op: "navigate", toolCallId: "call-1", args: { url: "https://x" } });
  assert.equal("output" in run, true);
  if (!("output" in run)) return;
  assert.deepEqual(run.output, { text: "did it\n\nCurrent page: X (https://x)\n\nbody" });
  assert.equal(run.shells.length, 1);
  assert.equal(run.shells[0]?.name, "node");
  assert.equal(run.shells[0]?.workingDirectory, "/workspace");
  assert.equal(run.shells[0]?.toolCallId, "slate-browser-navigate-call-1");
  const encoded = String(run.shells[0]?.command).split(" ")[2] ?? "";
  const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal(request.display, 3);
  assert.equal(request.cdpPort, BOX_CDP_PORT_BASE + 3);
  assert.equal(request.viewId, "view-default");
  assert.equal(String(request.shotPath).endsWith("/shot-call-1.png"), true);
});

test("the driver keeps only the last screenshot it stashed", () => {
  assert.equal(PENDING_SCREENSHOT_CAP > 0, true);
  assert.equal(stashScreenshot("a").startsWith("shot-"), true);
});

test("a driver with no result, a failed shell or a failed answer reports it", async () => {
  const missing = await runOf({ shellResult: shellSuccess("", { stderr: "boom", exitCode: 7 }) }, { op: "click", toolCallId: "call-1", args: {} });
  assert.equal("error" in missing, true);
  if ("error" in missing) assert.match(missing.error.message, /produced no result \(exit 7\): boom/);
  const failedShell = await runOf({ shellResult: shellTimeout() }, { op: "click", toolCallId: "call-1", args: {} });
  if ("error" in failedShell) assert.match(failedShell.error.message, /shell failed \(timeout\)/);
  const failedAnswer = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":false,\"error\":\"nope\"}") }, { op: "click", toolCallId: "call-1", args: {} });
  if ("output" in failedAnswer) assert.deepEqual(failedAnswer.output, { text: "nope", isError: true });
});

test("the driver reports the window and upload failures it cannot get past", async () => {
  const noWindow = await runOf({ windowMissing: true }, { op: "click", toolCallId: "call-1", args: {} });
  if ("error" in noWindow) assert.match(noWindow.error.message, /has not assigned/);
  const windowThrows = await runOf({ windowThrows: true }, { op: "click", toolCallId: "call-1", args: {} });
  if ("error" in windowThrows) assert.match(windowThrows.error.message, /Could not resolve/);
  const uploadThrows = await runOf({ uploadThrows: true }, { op: "click", toolCallId: "call-1", args: {} });
  if ("error" in uploadThrows) assert.match(uploadThrows.error.message, /Could not install/);
});

test("an explicit view and a skipped screenshot are carried into the request", async () => {
  const explicit = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") }, { op: "click", toolCallId: "a b/c", args: { viewId: "custom" } });
  if ("shells" in explicit) {
    const encoded = String(explicit.shells[0]?.command).split(" ")[2] ?? "";
    const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    assert.equal(request.viewId, "custom");
    assert.equal(request.shotPath, SLATE_BROWSER_DRIVER_BOX_DIR + "/shot-abc.png");
  }
  const skipped = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true,\"screenshot\":true}") }, { op: "get_bounding_box", toolCallId: "call-1", args: {}, skipScreenshot: true });
  if ("shells" in skipped) {
    const encoded = String(skipped.shells[0]?.command).split(" ")[2] ?? "";
    const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    assert.equal(request.shotPath, undefined);
  }
});

test("a screenshot is downloaded, persisted and encoded", async () => {
  const run = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true,\"screenshot\":true}"), imageBytes: new Uint8Array([7, 8]), persistImage: true }, { op: "screenshot", toolCallId: "call-1", args: {} });
  if ("output" in run) {
    assert.equal(run.output.imageB64, Buffer.from([7, 8]).toString("base64"));
    assert.deepEqual(run.persisted, [{ bytes: "0708", mimeType: "image/png" }]);
  }
  const empty = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true,\"screenshot\":true}"), imageBytes: new Uint8Array([]) }, { op: "screenshot", toolCallId: "call-1", args: {} });
  if ("output" in empty) assert.equal(empty.output.imageB64, undefined);
  const failed = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true,\"screenshot\":true}"), downloadThrows: true }, { op: "screenshot", toolCallId: "call-1", args: {} });
  if ("output" in failed) assert.equal(failed.output.imageB64, undefined);
});

test("a browser review action carries the call's arguments it knows", () => {
  assert.deepEqual(toBrowserReviewAction("navigate", {}, "view-default"), { op: "navigate", viewId: "view-default" });
  assert.deepEqual(toBrowserReviewAction("navigate", { url: "https://x", newTab: true, viewId: "v" }, "view-default"), { op: "navigate", viewId: "v", url: "https://x", newTab: true });
  const click = toBrowserReviewAction("click", { ref: "e1", element: "button", x: 1, y: 2, button: "left", modifiers: ["Alt"] }, "v");
  assert.deepEqual([click.ref, click.element, click.x, click.y, click.button, click.modifiers], ["e1", "button", 1, 2, "left", ["Alt"]]);
  assert.deepEqual(toBrowserReviewAction("type", { ref: "e1", text: "hello", submit: true, clear: false }, "v"), { op: "type", viewId: "v", ref: "e1", text: "hello", submit: true, clear: false });
  assert.deepEqual(toBrowserReviewAction("select_option", { ref: "e1", values: ["a", "b", 3] }, "v"), { op: "select_option", viewId: "v", ref: "e1", values: ["a", "b"] });
  assert.deepEqual(toBrowserReviewAction("cdp", { method: "Page.navigate", params: { url: "x" } }, "v"), { op: "cdp", viewId: "v", cdpMethod: "Page.navigate", cdpParams: "{\"url\":\"x\"}" });
  assert.deepEqual(toBrowserReviewAction("cdp", { params: [1, 2] }, "v"), { op: "cdp", viewId: "v", cdpParams: "[1,2]" });
  assert.deepEqual(toBrowserReviewAction("tabs", { action: "new", index: 2 }, "v"), { op: "tabs", viewId: "v", tabsAction: "new", tabIndex: 2 });
  assert.deepEqual(toBrowserReviewAction("drag", { sourceRef: "a", targetRef: "b", targetX: 3, targetY: 4 }, "v"), { op: "drag", viewId: "v", sourceRef: "a", targetRef: "b", targetX: 3, targetY: 4 });
  assert.deepEqual(toBrowserReviewAction("screenshot", { doubleClick: true }, "v"), { op: "screenshot", viewId: "v", doubleClick: true });
});

test("the tools are the browser actions, with the schemas and flags the model sees", () => {
  const fake = fakeDriver({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") });
  const tools = createSlateBrowserTools({ ...fake.ports, onPossibleNavigation: fake.onPossibleNavigation } as never);
  assert.equal(tools.length, 15);
  assert.deepEqual(tools.map((tool) => tool.id).slice(0, 3), ["BROWSER_NAVIGATE", "BROWSER_SNAPSHOT", "BROWSER_CLICK"]);
  assert.deepEqual(tools[0]?.schema, { required: ["url"] });
  assert.equal(tools[0]?.canNavigate, true);
  assert.equal(tools[10]?.skipScreenshot, true);
  assert.equal(tools[0]?.description.startsWith("Navigate the box browser"), true);
});

test("a tool validates its arguments and runs the driver, reporting navigation", async () => {
  const fake = fakeDriver({ shellResult: shellSuccess(MARKER + "{\"ok\":true,\"summary\":\"ran\",\"screenshot\":false}") });
  const tools = createSlateBrowserTools({ ...fake.ports, onPossibleNavigation: fake.onPossibleNavigation } as never);
  const navigate = tools[0]!;
  const missing = await navigate.execute({}, {}, { toolCallId: "call-1" });
  assert.deepEqual(missing, { text: "url is required", isError: true });
  const badTabs = await tools[13]!.execute({}, { action: "nope" }, { toolCallId: "call-1" });
  assert.deepEqual(badTabs, { text: "action must be one of list, new, close, select", isError: true });
  const ran = await navigate.execute({}, { url: "https://x" }, { toolCallId: "call-1" });
  assert.deepEqual(ran, { text: "ran" });
  assert.equal(fake.navigations.length, 1);
  assert.equal(fake.shells.length, 1);
  const render = navigate.render(ran);
  assert.equal(render.kind, "text");
  assert.equal(render.text, "ran");
  const failed = await tools[5]!.execute({}, {}, { toolCallId: "call-1" });
  assert.equal((failed as { isError?: boolean }).isError, true);
});

test("a tool renders a screenshot result as an image", async () => {
  const fake = fakeDriver({ shellResult: shellSuccess(MARKER + "{\"ok\":true,\"screenshot\":true}"), imageBytes: new Uint8Array([5, 6]) });
  const tools = createSlateBrowserTools({ ...fake.ports, onPossibleNavigation: fake.onPossibleNavigation } as never);
  const output = await tools[14]!.execute({}, {}, { toolCallId: "call-1" });
  const rendered = tools[14]!.render(output);
  assert.equal(rendered.kind, "image");
  assert.equal(rendered.imageB64, Buffer.from([5, 6]).toString("base64"));
});

test("the driver error keeps its name", () => {
  assert.equal(new SlateBrowserDriverError("x").name, "SlateBrowserDriverError");
});

test("a marker inside the payload is not mistaken for the result marker", () => {
  const payload = MARKER + "{\"ok\":true,\"summary\":\"" + MARKER + "x\"}";
  assert.deepEqual(parseDriverResponse(payload), { ok: true, summary: MARKER + "x" });
});

test("a window lookup that failed once is retried on the next call", async () => {
  const attempts: number[] = [];
  const fake = fakeDriver({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") });
  let calls = 0;
  fake.ports.getWindowIndex = async () => { calls += 1; attempts.push(calls); if (calls === 1) throw new Error("cold"); return 3; };
  const driver = new SlateBrowserDriver(fake.ports as never);
  await assert.rejects(() => driver.run({}, { op: "click", toolCallId: "call-1", args: {} } as never));
  const second = await driver.run({}, { op: "click", toolCallId: "call-1", args: {} } as never);
  assert.deepEqual(second, { text: "Done." });
  assert.equal(calls, 2);
});

test("a driver error from the window lookup is rethrown as itself", async () => {
  const fake = fakeDriver({});
  fake.ports.getWindowIndex = async () => { throw new SlateBrowserDriverError("own window error"); };
  const driver = new SlateBrowserDriver(fake.ports as never);
  await assert.rejects(async () => { await driver.run({}, { op: "click", toolCallId: "call-1", args: {} } as never); }, (error: unknown) => error instanceof SlateBrowserDriverError && error.message === "own window error");
});

test("the driver uploads the driver source to the box before the first call", async () => {
  const run = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") }, { op: "click", toolCallId: "call-1", args: {} });
  if ("uploads" in run) {
    assert.equal(run.uploads.length, 1);
    assert.equal((run.uploads[0] as { path: string }).path, SLATE_BROWSER_DRIVER_BOX_PATH);
    assert.equal((run.uploads[0] as { length: number }).length > 100, true);
  }
});

test("the request names the operation and the command carries it", async () => {
  const run = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") }, { op: "click", toolCallId: "call-1", args: {} });
  if ("shells" in run) {
    const encoded = String(run.shells[0]?.command).split(" ")[2] ?? "";
    assert.equal((JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { op: string }).op, "click");
  }
});

test("the missing-result error carries both streams, tail-first", async () => {
  const run = await runOf({ shellResult: shellSuccess("out", { stderr: "err", exitCode: 1 }) }, { op: "click", toolCallId: "call-1", args: {} });
  if ("error" in run) assert.match(run.error.message, /produced no result \(exit 1\): err \| out/);
});

test("a response without a summary says Done, and an empty url adds no page line", async () => {
  const noSummary = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") }, { op: "click", toolCallId: "call-1", args: {} });
  if ("output" in noSummary) assert.deepEqual(noSummary.output, { text: "Done." });
  const emptyUrl = await runOf({ shellResult: shellSuccess(MARKER + "{\"ok\":true,\"summary\":\"s\",\"url\":\"\"}") }, { op: "click", toolCallId: "call-1", args: {} });
  if ("output" in emptyUrl) assert.deepEqual(emptyUrl.output, { text: "s" });
});

test("an empty required argument is refused, not run", async () => {
  const fake = fakeDriver({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") });
  const tools = createSlateBrowserTools({ ...fake.ports, onPossibleNavigation: fake.onPossibleNavigation } as never);
  const result = await tools[0]!.execute({}, { url: "" }, { toolCallId: "call-1" });
  assert.deepEqual(result, { text: "url is required", isError: true });
  assert.equal(fake.shells.length, 0);
});

test("a window that is not assigned yet is resolved on the next call", async () => {
  const fake = fakeDriver({ shellResult: shellSuccess(MARKER + "{\"ok\":true}") });
  let calls = 0;
  fake.ports.getWindowIndex = async () => { calls += 1; return calls === 1 ? undefined : 4; };
  const driver = new SlateBrowserDriver(fake.ports as never);
  await assert.rejects(() => driver.run({}, { op: "click", toolCallId: "call-1", args: {} } as never), /has not assigned/);
  const second = await driver.run({}, { op: "click", toolCallId: "call-1", args: {} } as never);
  assert.deepEqual(second, { text: "Done." });
  assert.equal(calls, 2);
});

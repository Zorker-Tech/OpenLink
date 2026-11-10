import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { posix } from "node:path";
import {
  SLATE_BOX_UPLOADS_DIR,
  resolveBoxWorkspacePath,
  type TransferBox,
} from "../../source/host/boxes/box-transfer.ts";
import { SLATE_BOX_NOT_READY_MESSAGE } from "../../source/host/ports/box.ts";
import {
  assertBoxReady,
  copyFileFromBox,
  copyFileToBox,
  createFileTransferTools,
  formatBytes,
  resolveComputerOrThrow,
  type FileTransferController,
  type UserComputerHandle,
} from "../../source/host/runner/tools/slate-file-transfer-tools.ts";

function fakeBox(options: { data?: Uint8Array; fail?: Error } = {}) {
  const uploads: Array<{ agentId: string; path: string; data: Uint8Array }> = [];
  const box: TransferBox = {
    downloadFile: async () => { if (options.fail) throw options.fail; return options.data ?? new Uint8Array([1, 2, 3]); },
    uploadFile: async (_ctx, agentId, path, data) => { uploads.push({ agentId, path, data }); },
  };
  return { box, uploads };
}
function controller(options: { connected?: boolean; preparing?: boolean; computers?: UserComputerHandle[] } = {}) {
  const agentBox = fakeBox();
  const computerBox = fakeBox();
  const handle: UserComputerHandle = { id: "computer-1", label: "My laptop", connected: options.connected !== false, box: computerBox.box };
  const computers = options.computers ?? [handle];
  const instance: FileTransferController = {
    agentBox: agentBox.box,
    userComputers: { resolve: (id) => { const found = id === undefined ? computers[0] : computers.find((entry) => entry.id === id); return found?.connected === false ? undefined : found; }, list: () => computers },
    getComputerAgentId: () => "computer-agent-1",
    getBoxId: () => "box-1",
    isBoxPreparing: () => options.preparing === true,
  };
  return { controller: instance, agentBox, computerBox, handle };
}
const args = (overrides: Record<string, unknown> = {}) => ({ computer_path: "/home/me/data.csv", ...overrides }) as never;

describe("formatting transferred sizes", () => {
  it("reads bytes, kilobytes and gigabytes", () => {
    assert.equal(formatBytes(0), "0 bytes");
    assert.equal(formatBytes(1_023), "1023 bytes");
    assert.equal(formatBytes(1_024), "1 KB");
    assert.equal(formatBytes(1_536), "1.5 KB");
    assert.equal(formatBytes(10 * 1_024), "10 KB");
    assert.equal(formatBytes(1_024 ** 3), "1 GB");
  });
});

describe("finding the computer to transfer with", () => {
  it("returns the selected handle or explains what is connected", () => {
    const { controller: instance } = controller();
    assert.equal(resolveComputerOrThrow(instance).id, "computer-1");
    assert.throws(() => resolveComputerOrThrow(instance, "missing"), /Unknown computer "missing"/);
    const { controller: none } = controller({ computers: [] });
    assert.throws(() => resolveComputerOrThrow(none), (error: unknown) => String((error as Error).message) === "No computer is connected right now (the Slate desktop app must be open and online to transfer files). Connected computers: none connected.");
    const offline = controller({ computers: [{ id: "offline-1", label: "Old", connected: false, box: fakeBox().box }] });
    assert.throws(() => resolveComputerOrThrow(offline.controller, "offline-1"), /Unknown computer "offline-1"/);
    const offlineDefault = controller({ computers: [{ id: "offline-1", label: "Old", connected: false, box: fakeBox().box }] });
    assert.throws(() => resolveComputerOrThrow(offlineDefault.controller), /offline-1 \(offline\)/);
  });

  it("refuses to transfer while the box is preparing", () => {
    const { controller: instance } = controller({ preparing: true });
    assert.throws(() => assertBoxReady(instance), (error: unknown) => String((error as Error).message) === SLATE_BOX_NOT_READY_MESSAGE);
  });
});

describe("copying a file into the box", () => {
  it("lands the file in uploads under its own name", async () => {
    const { controller: instance, agentBox } = controller();
    const message = await copyFileToBox({}, args(), instance);
    const expected = resolveBoxWorkspacePath(posix.join(SLATE_BOX_UPLOADS_DIR, "data.csv"));
    assert.equal(agentBox.uploads.length, 1);
    assert.equal(agentBox.uploads[0]!.path, expected);
    assert.equal(agentBox.uploads[0]!.agentId, "box-1");
    assert.equal(message, `Copied /home/me/data.csv from My laptop into your box at ${expected} (3 bytes). Open it with Shell.`);
  });

  it("honours an explicit box path and reports a missing computer", async () => {
    const { controller: instance, agentBox } = controller();
    await copyFileToBox({}, args({ box_path: "data/renamed.csv", computer: "computer-1" }), instance);
    assert.equal(agentBox.uploads[0]!.path, resolveBoxWorkspacePath("data/renamed.csv"));
    await assert.rejects(() => copyFileToBox({}, args({ computer: "missing" }), instance), /Unknown computer/);
    await assert.rejects(() => copyFileToBox({}, args(), controller({ preparing: true }).controller), (error: unknown) => String((error as Error).message) === SLATE_BOX_NOT_READY_MESSAGE);
  });
});

describe("copying a file out of the box", () => {
  it("pushes the file to the computer under its own name", async () => {
    const { controller: instance, computerBox } = controller();
    const message = await copyFileFromBox({}, { box_path: "/workspace/report.pdf" } as never, instance);
    assert.equal(computerBox.uploads.length, 1);
    assert.equal(computerBox.uploads[0]!.path, "report.pdf");
    assert.equal(computerBox.uploads[0]!.agentId, "computer-agent-1");
    assert.equal(message.includes("from your box to My laptop at report.pdf"), true);
  });

  it("honours an explicit computer path", async () => {
    const { controller: instance, computerBox } = controller();
    await copyFileFromBox({}, { box_path: "/workspace/report.pdf", computer_path: "/home/me/out.pdf" } as never, instance);
    assert.equal(computerBox.uploads[0]!.path, "/home/me/out.pdf");
  });
});

describe("the file transfer tools", () => {
  it("defines the two communicate tools with their activity detail", async () => {
    const { controller: instance } = controller();
    const tools = createFileTransferTools(instance) as unknown as Array<{ name: string; execute: (...args: never[]) => Promise<string> }>;
    assert.deepEqual(tools.map((tool) => tool.name), ["CopyToBox", "CopyFromBox"]);
    assert.equal(JSON.stringify(tools[0]).includes("COPY_TO_BOX"), true);
    assert.equal(JSON.stringify(tools[1]).includes("COPY_FROM_BOX"), true);
    assert.equal(typeof tools[0]!.execute, "function");
    assert.equal(typeof tools[1]!.execute, "function");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  asCapableTransferBox,
  asPromptUserComputers,
  asRemoteBoxResourceOwner,
  asTransferBox,
  isAgentContext,
} from "../../source/host/runner/host-runner-capabilities.ts";

describe("runner extension capabilities", () => {
  it("requires both transfer operations and preserves their source receiver", async () => {
    assert.equal(asTransferBox({ downloadFile() {} }), undefined);
    const source = {
      id: "box-1",
      downloadFile(this: { id: string }, _context: unknown, _agentId: string, _path: string) {
        return new TextEncoder().encode(this.id);
      },
      uploadFile(this: { id: string }, _context: unknown, _agentId: string, _path: string, _data: Uint8Array) {
        return this.id;
      },
    };
    const box = asTransferBox(source)!;
    assert.deepEqual(await box.downloadFile({}, "agent-1", "/workspace/a"), new TextEncoder().encode("box-1"));
    assert.equal(await box.uploadFile({}, "agent-1", "/workspace/a", new Uint8Array()), "box-1");
  });

  it("keeps optional box abilities absent and requires readiness for remote ownership", () => {
    const transfer = { downloadFile() {}, uploadFile() {} };
    const capable = asCapableTransferBox(transfer)!;
    assert.equal(capable.getTerminalsFolder, undefined);
    const remote = { ...transfer, ensureReady: async () => ({ terminalsFolder: "t", remoteAccessor: {} }) };
    assert.equal(asRemoteBoxResourceOwner(transfer), undefined);
    assert.equal(typeof asRemoteBoxResourceOwner(remote)?.ensureReady, "function");
  });

  it("filters invalid connected computers while binding resolve and list receivers", () => {
    const source = {
      id: "computer-1",
      downloadFile: () => new Uint8Array(),
      uploadFile: () => {},
      resolve(id?: string) {
        return id === this.id ? { id: this.id, label: "Laptop", connected: true, box: this } : undefined;
      },
      list() {
        return [this.resolve(this.id), { id: "bad", label: "", connected: true }, null];
      },
    };
    const computers = asPromptUserComputers(source)!;
    assert.equal(computers.resolve("computer-1")?.label, "Laptop");
    assert.deepEqual(computers.list().map(({ id }) => id), ["computer-1"]);
    assert.equal(asPromptUserComputers({ resolve() {} }), undefined);
  });

  it("accepts only a context carrying all three runner operations", () => {
    assert.equal(isAgentContext({ with() {}, get() {}, withCancel() {} }), true);
    assert.equal(isAgentContext({ with() {}, get() {} }), false);
    assert.equal(isAgentContext(null), false);
  });
});

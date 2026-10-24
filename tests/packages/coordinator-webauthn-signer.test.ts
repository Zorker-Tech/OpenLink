import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  SIGNER_EVENT_PREFIX,
  createSpawnedWebAuthnSigner,
  describeSignerEventAsStatus,
  devRepoRoot,
  parseSignerEvent,
  resolveWebAuthnSignerPath,
} from "../../source/coordinator/webauthn/signer.ts";

const NL = String.fromCharCode(10);
const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "webauthn-signer-"));
  roots.push(root);
  return root;
}
after(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function script(body: string): string {
  const path = join(freshRoot(), "helper.sh");
  writeFileSync(path, "#!/bin/sh\n" + body + "\n");
  chmodSync(path, 0o755);
  return path;
}
const ceremony = { challenge: "challenge-1", rpId: "example.test" } as never;

describe("describing signer events", () => {
  it("maps every event kind to the status the user reads", () => {
    assert.equal(describeSignerEventAsStatus({ kind: "presence-required" }), "Touch your security key now");
    assert.equal(describeSignerEventAsStatus({ kind: "select-device" }), "Touch the security key you want to use");
    assert.equal(describeSignerEventAsStatus({ kind: "pin-blocked" }), "Your security key is locked");
    assert.equal(describeSignerEventAsStatus({ kind: "pin-required" }), undefined);
    assert.equal(describeSignerEventAsStatus({ kind: "pin-invalid", retries: 2 }), undefined);
  });

  it("parses an event and reports an unreadable one", () => {
    assert.deepEqual(parseSignerEvent('{"kind":"presence-required"}', () => assert.fail("no log")), { kind: "presence-required" });
    const logs: string[] = [];
    assert.equal(parseSignerEvent("not json", (message) => logs.push(message)), undefined);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.includes("unreadable signer event"), true);
  });
});

describe("locating the signer binary", () => {
  it("honours the override and falls back to the dev tree", () => {
    assert.equal(devRepoRoot("/tmp/repo"), "/tmp/repo");
    const binary = script("exit 0");
    const previous = process.env.SLATE_WEBAUTHN_SIGNER_PATH;
    process.env.SLATE_WEBAUTHN_SIGNER_PATH = binary;
    try {
      assert.equal(resolveWebAuthnSignerPath({ isPackaged: false }), binary);
      process.env.SLATE_WEBAUTHN_SIGNER_PATH = join(freshRoot(), "missing-binary");
      assert.equal(resolveWebAuthnSignerPath({ isPackaged: false }), undefined);
    } finally {
      if (previous === undefined) delete process.env.SLATE_WEBAUTHN_SIGNER_PATH;
      else process.env.SLATE_WEBAUTHN_SIGNER_PATH = previous;
    }
    assert.equal(resolveWebAuthnSignerPath({ isPackaged: true, repoRoot: freshRoot() }), undefined);
  });
});

describe("signing with a spawned helper", () => {
  it("returns the credential the helper prints and reports status events", async () => {
    const binaryPath = script(["read request", "echo \"[signer-event] {\\\"kind\\\":\\\"presence-required\\\"}\" >&2", "echo \"{\\\"ok\\\": true, \\\"credentialJson\\\": {\\\"id\\\": \\\"credential-1\\\"}}\""].join(NL));
    const statuses: string[] = [];
    const signer = createSpawnedWebAuthnSigner({ binaryPath, onStatus: (status) => statuses.push(status) });
    const result = await signer.sign(ceremony, new AbortController().signal);
    assert.deepEqual(result, { ok: true, credentialJson: { id: "credential-1" } });
    assert.deepEqual(statuses, ["Touch your security key now"]);
  });

  it("answers a pin request with the prompted pin", async () => {
    const binaryPath = script(["read request", "echo \"[signer-event] {\\\"kind\\\":\\\"pin-required\\\"}\" >&2", "read reply", "echo \"{\\\"ok\\\":true,\\\"credentialJson\\\":$reply}\""].join(NL));
    const prompts: unknown[] = [];
    const signer = createSpawnedWebAuthnSigner({
      binaryPath,
      onPinRequest: async (request) => { prompts.push(request); return "1234"; },
    });
    const result = await signer.sign(ceremony, new AbortController().signal, { approved: true, promptId: "prompt-1" } as never);
    assert.equal(result.ok, true);
    assert.deepEqual((result as { credentialJson: unknown }).credentialJson, { kind: "pin", pin: "1234" });
    assert.deepEqual(prompts, [{ invalid: false }]);
  });

  it("cancels the helper when the prompt is dismissed", async () => {
    const binaryPath = script(["read request", "echo \"[signer-event] {\\\"kind\\\":\\\"pin-invalid\\\",\\\"retries\\\":1}\" >&2", "read reply", "echo \"{\\\"ok\\\":true,\\\"credentialJson\\\":$reply}\""].join(NL));
    const signer = createSpawnedWebAuthnSigner({ binaryPath, onPinRequest: async () => undefined });
    const result = await signer.sign(ceremony, new AbortController().signal, { approved: true, promptId: "prompt-2" } as never);
    assert.deepEqual((result as { credentialJson: unknown }).credentialJson, { kind: "cancel" });
  });

  it("reports a helper that exits without a result", async () => {
    const binaryPath = script(["read request", "echo \"helper broke\" >&2", "exit 3"].join(NL));
    const logs: string[] = [];
    const signer = createSpawnedWebAuthnSigner({ binaryPath, log: (message) => logs.push(message) });
    const result = await signer.sign(ceremony, new AbortController().signal);
    assert.equal(result.ok, false);
    assert.equal((result as { error: { code?: string } }).error.code, "helper_no_result");
  });

  it("reports a helper that cannot be started", async () => {
    const signer = createSpawnedWebAuthnSigner({ binaryPath: join(freshRoot(), "missing-binary") });
    const result = await signer.sign(ceremony, new AbortController().signal);
    assert.equal((result as { error: { code?: string } }).error.code, "helper_spawn_failed");
  });

  it("kills the helper when the request is aborted", async () => {
    const binaryPath = script(["read request", "sleep 5"].join(NL));
    const signer = createSpawnedWebAuthnSigner({ binaryPath });
    const controller = new AbortController();
    const running = signer.sign(ceremony, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    assert.equal((result as { error: { code?: string } }).error.code, "cancelled_or_timeout");
  });
  it("reports an unreadable result from the helper", async () => {
    const binaryPath = script(["read request", "echo not-json"].join(NL));
    const signer = createSpawnedWebAuthnSigner({ binaryPath });
    const result = await signer.sign(ceremony, new AbortController().signal);
    assert.equal((result as { error: { message: string } }).error.message.includes("unreadable result"), true);
  });
});

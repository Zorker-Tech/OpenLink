/**
 * Generating an image for an agent — which model it runs on, and what happens when it cannot be saved — and the audit
 * extension that declares itself on top of the host's own auth, gate and telemetry.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { SLATE_DEFAULT_MODEL_ID } from "../../source/shared/agents/agent-model.ts";
import { createSlateGenerateImageService, SlateGenerateImagePersistError, type GenerateImageFactory } from "../../source/host/attachments/generate-image-service.ts";
import { actionAuditExtension, SLATE_ACTION_AUDIT_LOGS_GATE } from "../../source/host/extensions/action-audit/extension.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-generate-image-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => delete process.env["SLATE_AGENT_MODEL"]);

const auth = { getAccessToken: async () => "token", getMachineId: async () => "machine" };

describe("generating an image for an agent", () => {
  function imageWorld(options: { persist?: (bytes: Uint8Array, mimeType: string) => Promise<{ absolutePath: string } | null>; generated?: { imageData: string; mimeType: string }; fails?: Error } = {}) {
    const built: Parameters<GenerateImageFactory>[0][] = [];
    const persisted: { bytes: Uint8Array; mimeType: string }[] = [];
    const asked: { description: string; images: readonly { data: string; mimeType: string }[] }[] = [];
    const generateImage: GenerateImageFactory = (given) => {
      built.push(given);
      return async (_ctx: unknown, description: string, referenceImages?: readonly { data: string; mimeType: string }[]) => {
        asked.push({ description, images: referenceImages ?? [] });
        if (options.fails !== undefined) throw options.fails;
        return options.generated ?? { imageData: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" };
      };
    };
    const service = createSlateGenerateImageService(auth, {
      persistImage: async (bytes, mimeType) => {
        persisted.push({ bytes, mimeType });
        return options.persist === undefined ? { absolutePath: join(scratch, "saved.png") } : await options.persist(bytes, mimeType);
      },
      generateImage,
    });
    return { service, built, persisted, asked };
  }

  it("runs on the model the turn named, or the platform's own, in max mode", async () => {
    const world = imageWorld();
    await world.service(undefined, "a cat", "", []);
    assert.deepEqual(
      [world.built[0]!.modelId, world.built[0]!.maxMode, world.built[0]!.onRequestId],
      [SLATE_DEFAULT_MODEL_ID, true, undefined],
    );
    assert.equal(await world.built[0]!.getMachineId(), "machine");
    // A model named in the environment is the one a turn runs on.
    process.env["SLATE_AGENT_MODEL"] = "environment-model";
    const named = imageWorld();
    await named.service(undefined, "a cat", "", []);
    assert.equal(named.built[0]!.modelId, "environment-model");
    // A caller that wants to hear the request id is passed on.
    const withId = createSlateGenerateImageService(auth, { persistImage: async () => ({ absolutePath: "/tmp/x.png" }), generateImage: (given) => { assert.equal(typeof given.onRequestId, "function"); return async () => ({ imageData: "", mimeType: "image/png" }); }, onRequestId: () => {} });
    await withId(undefined, "a cat", "", []);
  });

  it("hands the picture and its type to the media store, and answers with where it went", async () => {
    const world = imageWorld();
    const answered = await world.service(undefined, "a cat", "", [{ data: "reference", mimeType: "image/jpeg" }]);
    assert.deepEqual(answered, { filePath: join(scratch, "saved.png"), imageData: Buffer.from("image-bytes").toString("base64") });
    assert.deepEqual(world.asked, [{ description: "a cat", images: [{ data: "reference", mimeType: "image/jpeg" }] }]);
    // What the store was handed is the picture's own bytes, not the base64 text.
    assert.deepEqual([...world.persisted[0]!.bytes], [...Buffer.from("image-bytes")]);
    assert.equal(world.persisted[0]!.mimeType, "image/png");
  });

  it("fails the call when the image could not be kept, rather than answering with one that is not there", async () => {
    const unsaved = imageWorld({ persist: async () => null });
    await assert.rejects(unsaved.service(undefined, "a cat", "", []), (error: Error) => error instanceof SlateGenerateImagePersistError && error.message === "Failed to save the generated image into the agent's media store.");
    // A generator that refused is not turned into a persist failure.
    const refused = imageWorld({ fails: new Error("the model is down") });
    await assert.rejects(refused.service(undefined, "a cat", "", []), /the model is down/);
    assert.deepEqual(refused.persisted, []);
  });
});

describe("the audit extension", () => {
  function extensionWorld() {
    const visible = new Set<string>();
    const teardowns: (() => void | Promise<void>)[] = [];
    const diagnostics: unknown[] = [];
    const deps = {
      [HostExtensions.Auth]: { getAccessToken: async () => "token", getMachineId: async () => "machine" },
      [HostExtensions.Experiments]: {
        checkGate: async (name: string) => {
          visible.add(name);
          return false;
        },
      },
      [HostExtensions.Telemetry]: { logs: { reportHostExtensionDiagnostic: (value: unknown) => void diagnostics.push(value) } },
    };
    return { deps, visible, teardowns, diagnostics };
  }

  it("declares itself with what it needs, and hands the host the auditor", () => {
    const world = extensionWorld();
    assert.equal(actionAuditExtension.kind, "host-extension");
    assert.equal(actionAuditExtension.id, HostExtensions.ActionAudit);
    assert.deepEqual(actionAuditExtension.dependencies, [HostExtensions.Auth, HostExtensions.Experiments, HostExtensions.Telemetry]);
    assert.equal(SLATE_ACTION_AUDIT_LOGS_GATE, "slate_action_audit_logs");
    const auditor = actionAuditExtension.start({
      deps: world.deps,
      host: {},
      onStop: (teardown: () => void | Promise<void>) => void world.teardowns.push(teardown),
    } as never);
    // What the host gets is the auditor, and recording onto it is safe before anything was enabled.
    assert.equal(typeof (auditor as { record: unknown }).record, "function");
    (auditor as { record(record: unknown): void }).record({ occurredAtMs: 1, agentId: "agent-1", action: { kind: "browserNavigation", url: "https://example.test", pageTitle: "Example" } });
    assert.deepEqual(world.teardowns.length, 1);
    // Nothing was asked of the gate yet: it is asked when the audit is about to be forwarded.
    assert.deepEqual([...world.visible], []);
  });

  it("lets the auditor go when the host stops", async () => {
    const world = extensionWorld();
    actionAuditExtension.start({
      deps: world.deps,
      host: {},
      onStop: (teardown: () => void | Promise<void>) => void world.teardowns.push(teardown),
    } as never);
    await world.teardowns[0]!();
    assert.equal(world.teardowns.length, 1);
  });
});

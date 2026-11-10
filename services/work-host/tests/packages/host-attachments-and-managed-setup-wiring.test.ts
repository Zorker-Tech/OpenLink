/**
 * Two host wirings: the attachments extension (what it declares, the service it hands over, and the report it wires)
 * and the managed setup's production extras (the one dashboard client its three parts are built over).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { attachmentsExtension } from "../../source/host/attachments/extension.ts";
import { createManagedSetupProductionExtras } from "../../source/host/extensions/managed-setup/production.ts";
import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-wiring-"));
const previousRoot = process.env["SLATE_DATA_ROOT"];
const platformRoot = join(scratch, "root");
process.env["SLATE_DATA_ROOT"] = platformRoot;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env["SLATE_DATA_ROOT"];
  else process.env["SLATE_DATA_ROOT"] = previousRoot;
});

describe("the attachments extension", () => {
  it("declares what it needs, and hands the host a service that reports what it could not do", async () => {
    assert.equal(attachmentsExtension.kind, "host-extension");
    assert.equal(attachmentsExtension.id, HostExtensions.Attachments);
    assert.deepEqual(attachmentsExtension.dependencies, [HostExtensions.Auth, HostExtensions.ForeverBox, HostExtensions.Telemetry]);
    const reported: Record<string, unknown>[] = [];
    const box = { describe: () => ({ backend: "test" }) };
    const service = attachmentsExtension.start({
      deps: {
        auth: { getAccessToken: async () => "token", getMachineId: async () => "machine-1" },
        "forever-box": { box },
        telemetry: { logs: { reportHostExtensionDiagnostic: (value: Record<string, unknown>) => void reported.push(value) } },
      },
      host: {},
      onStop: () => {},
    } as never) as unknown as {
      box: unknown;
      readText(args: { path: string }): Promise<unknown>;
      readImage(args: { path: string }): Promise<unknown>;
      upload(args: { filename: string; bytesBase64: string }): Promise<unknown>;
      stageIntoBox: unknown;
      createGenerateImageService: unknown;
    };
    // The surface is the service's own, built over the box the host lent it.
    assert.deepEqual([typeof service.readText, typeof service.readImage, typeof service.upload, typeof service.stageIntoBox, typeof service.createGenerateImageService], ["function", "function", "function", "function", "function"]);
    // A read that found no owner is reported through the host's telemetry rather than answered silently.
    assert.equal(await service.readText({ path: "/etc/hosts" }), null);
    assert.deepEqual(reported, [{ extension: "attachments", kind: "read_text_miss", hasActive: false }]);
    // A host that never lent it a box cannot be given the service at all.
    assert.throws(() => attachmentsExtension.start({
      deps: { auth: { getAccessToken: async () => "token", getMachineId: async () => "machine-1" }, telemetry: { logs: { reportHostExtensionDiagnostic: () => {} } } },
      host: {},
      onStop: () => {},
    } as never), TypeError);
    assert.equal(typeof box, "object");
  });
});

describe("the managed setup's production extras", () => {
  function extrasWorld() {
    const reported: unknown[] = [];
    const diagnostics: Record<string, unknown>[] = [];
    const context = {
      deps: {
        auth: { getAccessToken: async () => "token", getMachineId: async () => "machine-1" },
        telemetry: { logs: { reportHostExtensionDiagnostic: (value: Record<string, unknown>) => void diagnostics.push(value) } },
      },
      host: {},
      onStop: () => {},
    };
    return { context, reported, diagnostics, extras: createManagedSetupProductionExtras(context as never) };
  }

  it("builds the three parts the extension's context asks for, the way the context asks for them", async () => {
    const world = extrasWorld();
    assert.deepEqual(Object.keys(world.extras).sort(), ["createManagedSkills", "createTeamRules", "fetchSkillCatalog"]);
    for (const [name, factory] of Object.entries(world.extras)) assert.equal(typeof factory, "function", name);
    const auth = { getAccessToken: async () => "token", getMachineId: () => "machine-1", peekAccessToken: () => null };
    // What the platform manages is a service the extension can drive, kept under the platform's own root.
    const skills = world.extras.createManagedSkills({ getAccessToken: async () => null, report: (event: unknown) => void world.reported.push(event) });
    assert.deepEqual([typeof (skills as { ensureSkillIsCached: unknown }).ensureSkillIsCached, typeof (skills as { dispose: unknown }).dispose], ["function", "function"]);
    // What the platform manages is kept where the platform keeps everything of its own.
    const options = (skills as unknown as { options: { getCacheDir(): string } }).options;
    assert.equal(options.getCacheDir(), join(platformRoot, "managed-skills"));
    assert.equal(options.getCacheDir().startsWith(platformRoot), true);
    (skills as { dispose(): void }).dispose();
    // The team rules are a resolver the extension starts, refreshes and reads.
    const teamRules = world.extras.createTeamRules({ auth, report: () => {} });
    assert.deepEqual([typeof (teamRules as { start: unknown }).start, typeof (teamRules as { refresh: unknown }).refresh, typeof (teamRules as { resolveRules: unknown }).resolveRules], ["function", "function", "function"]);
    // The catalog is read best-effort; with no reachable dashboard that is an empty answer rather than a thrown one.
    assert.deepEqual(await world.extras.fetchSkillCatalog(async () => null), []);
    assert.deepEqual(world.diagnostics.length >= 1, true);
  });
});

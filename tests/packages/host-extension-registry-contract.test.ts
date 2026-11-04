import assert from "node:assert/strict";
import { test } from "node:test";

import { orderRegisteredHostExtensions, startWorkHostExtensions, WORK_HOST_EXTENSION_REGISTRATION_ORDER } from "../../source/host/extensions/registry.ts";
import { defineHostExtension } from "../../source/host/extensions/host-extensions.ts";
import { HostExtensions, type HostExtensionId } from "../../source/host/extensions/extension-ids.generated.ts";

function declarations(onStart: (id: HostExtensionId) => void, onStop: (id: HostExtensionId) => void) {
  return Object.fromEntries(WORK_HOST_EXTENSION_REGISTRATION_ORDER.map((id) => [
    id,
    defineHostExtension({
      id,
      dependencies: [],
      start(context) {
        onStart(id);
        context.onStop(() => onStop(id));
        return { id };
      },
    }),
  ])) as Record<HostExtensionId, ReturnType<typeof defineHostExtension>>;
}

test("registration order includes every unique host extension and validates each registry slot", () => {
  const registry = declarations(() => {}, () => {});
  const ordered = orderRegisteredHostExtensions(registry);
  assert.deepEqual(ordered.map(({ id }) => id), WORK_HOST_EXTENSION_REGISTRATION_ORDER);

  const missing = { ...registry } as Partial<typeof registry>;
  delete missing[HostExtensions.Telemetry];
  assert.throws(() => orderRegisteredHostExtensions(missing), /registry is missing/);

  const mismatched = { ...registry, [HostExtensions.Telemetry]: registry[HostExtensions.Auth] };
  assert.throws(() => orderRegisteredHostExtensions(mismatched), /registry slot/);
});

test("extension startup exposes each api and stops the graph through its lifecycle owner", async () => {
  const started: HostExtensionId[] = [];
  const stopped: HostExtensionId[] = [];
  const registry = await startWorkHostExtensions({
    host: { log: () => {} },
    extensionsById: declarations((id) => started.push(id), (id) => stopped.push(id)),
  });
  assert.equal(started.length, WORK_HOST_EXTENSION_REGISTRATION_ORDER.length);
  const telemetryApi = registry.api(HostExtensions.Telemetry) as { readonly id: string };
  assert.equal(telemetryApi.id, HostExtensions.Telemetry);
  await registry.stop();
  assert.equal(stopped.length, WORK_HOST_EXTENSION_REGISTRATION_ORDER.length);
});

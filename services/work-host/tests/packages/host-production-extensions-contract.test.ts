import assert from "node:assert/strict"
import { test } from "node:test"

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import { WORK_HOST_EXTENSION_REGISTRATION_ORDER } from "../../source/host/extensions/registry.ts"
import { bindRecoveredProductionExtensions, createRecoveredProductionExtensionRegistry } from "../../source/host/host-production-extensions.ts"
import type { ProductionSlateHostPorts } from "../../source/host/slate-host-production.ts"

const bindings = {
  stateBackstop: {} as never,
  localExecCodec: {} as never,
  secretsContext: {} as never,
}

test("the production registry contains every host extension in its explicit order", () => {
  const registry = createRecoveredProductionExtensionRegistry({ ...bindings })
  assert.deepEqual(Object.keys(registry), WORK_HOST_EXTENSION_REGISTRATION_ORDER)
  assert.equal(new Set(Object.keys(registry)).size, Object.keys(HostExtensions).length)
  for (const [id, declaration] of Object.entries(registry)) assert.equal(declaration.id, id, `registry slot ${id} keeps its extension id`)
})

test("binding the production registry preserves the caller's host ports", () => {
  const ownedPort = Symbol("host-port")
  const ports = { ownedPort } as unknown as Omit<ProductionSlateHostPorts, "extensionsById">
  const bound = bindRecoveredProductionExtensions(ports, { ...bindings })
  assert.equal((bound as unknown as { ownedPort: symbol }).ownedPort, ownedPort)
  assert.deepEqual(Object.keys(bound.extensionsById), WORK_HOST_EXTENSION_REGISTRATION_ORDER)
})

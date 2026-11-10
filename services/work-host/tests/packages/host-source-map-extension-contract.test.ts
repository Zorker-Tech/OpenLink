import assert from "node:assert/strict"
import { test } from "node:test"

import { HostExtensions } from "../../source/host/extensions/extension-ids.generated.ts"
import { sourceMapExtension } from "../../source/host/extensions/source-map/extension.ts"
import { SlateSourceMap } from "../../source/host/extensions/source-map/source-map-service.ts"

test("the source-map extension is a dependency-free host registration that starts its Slate service", () => {
  assert.equal(sourceMapExtension.kind, "host-extension")
  assert.equal(sourceMapExtension.id, HostExtensions.SourceMap)
  assert.deepEqual(sourceMapExtension.dependencies, [])
  const service = sourceMapExtension.start({ deps: {}, host: {}, onStop: () => {} })
  assert.equal(service instanceof SlateSourceMap, true)
})

import assert from "node:assert/strict"
import { test } from "node:test"

import * as packageSurface from "../../source/packages/hooks-carriers/index.ts"
import * as additionalContext from "../../source/packages/hooks-carriers/hook-additional-context.ts"
import * as contextRendering from "../../source/packages/hooks-carriers/hook-context-rendering.ts"
import * as carrierSpec from "../../source/packages/hooks-carriers/carrier-spec.ts"

test("hooks-carriers exposes exactly its Slate context, renderer and carrier-spec modules", () => {
  const declaredSurface = new Set([
    ...Object.keys(additionalContext),
    ...Object.keys(contextRendering),
    ...Object.keys(carrierSpec),
  ])
  assert.deepEqual(Object.keys(packageSurface).sort(), [...declaredSurface].sort())
})

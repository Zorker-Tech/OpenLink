import assert from "node:assert/strict"
import { test } from "node:test"

import * as packageSurface from "../../source/packages/shell-exec/index.ts"
import * as naive from "../../source/packages/shell-exec/naive.ts"
import * as parser from "../../source/packages/shell-exec/shell-parser.ts"
import * as types from "../../source/packages/shell-exec/types.ts"
import * as bash from "../../source/packages/shell-exec/bash.ts"
import * as powershell from "../../source/packages/shell-exec/powershell.ts"
import * as zsh from "../../source/packages/shell-exec/zsh.ts"
import * as zshLight from "../../source/packages/shell-exec/zsh-light.ts"
import * as core from "../../source/packages/shell-exec/core.ts"

test("the shell-exec package entry re-exports exactly its declared runtime modules", () => {
  const declaredSurface = new Set([
    ...Object.keys(naive),
    ...Object.keys(parser),
    ...Object.keys(types),
    ...Object.keys(bash),
    ...Object.keys(powershell),
    ...Object.keys(zsh),
    ...Object.keys(zshLight),
    ...Object.keys(core),
  ])
  assert.deepEqual(Object.keys(packageSurface).sort(), [...declaredSurface].sort())
})

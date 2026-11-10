import assert from "node:assert/strict"
import { test } from "node:test"

import * as packageSurface from "../../source/packages/local-exec/index.ts"
import * as backgroundShell from "../../source/packages/local-exec/background-shell.ts"
import * as directoryListing from "../../source/packages/local-exec/ls.ts"
import * as mcpDiskCatalog from "../../source/packages/local-exec/mcp-disk-catalog-read.ts"
import * as mcpDiskFreshness from "../../source/packages/local-exec/mcp-disk-freshness-on-access.ts"
import * as mcpAnnotations from "../../source/packages/local-exec/mcp-tool-annotations.ts"
import * as mcp from "../../source/packages/local-exec/mcp.ts"
import * as read from "../../source/packages/local-exec/read.ts"
import * as shellCore from "../../source/packages/local-exec/shell-core.ts"
import * as shellStream from "../../source/packages/local-exec/shell-stream.ts"
import * as ignorePolicy from "../../source/packages/local-exec/runtime-ignore-policy.ts"
import * as permissionPolicy from "../../source/packages/local-exec/runtime-permission-policy.ts"

test("the local-exec entry re-exports exactly the modules it owns", () => {
  const declaredSurface = new Set([
    ...Object.keys(backgroundShell),
    ...Object.keys(directoryListing),
    ...Object.keys(mcpDiskCatalog),
    ...Object.keys(mcpDiskFreshness),
    ...Object.keys(mcpAnnotations),
    ...Object.keys(mcp),
    ...Object.keys(read),
    ...Object.keys(shellCore),
    ...Object.keys(shellStream),
    ...Object.keys(ignorePolicy),
    ...Object.keys(permissionPolicy),
  ])

  assert.deepEqual(Object.keys(packageSurface).sort(), [...declaredSurface].sort())
})

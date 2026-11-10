import assert from "node:assert/strict"
import test from "node:test"

import { boxExecDaemonOptionsFromEnvironment } from "../../source/box-exec/main.ts"

test("box daemon settings resolve the workspace and include configured process options", () => {
  assert.deepEqual(boxExecDaemonOptionsFromEnvironment({}, "/opt/slate/box"), {
    workspaceRoot: "/opt/slate/box",
  })

  assert.deepEqual(boxExecDaemonOptionsFromEnvironment({
    SLATE_BOX_WORKSPACE_ROOT: "../workspace",
    SLATE_BOX_EXEC_DAEMON_PORT: "4210-extra",
    SLATE_BOX_TERMINALS_DIRECTORY: "/run/slate/terminals",
    SLATE_BOX_EXEC_DAEMON_AUTH_TOKEN: "test-token",
  }, "/opt/slate/box"), {
    workspaceRoot: "/opt/slate/workspace",
    port: 4210,
    terminalsDirectory: "/run/slate/terminals",
    authToken: "test-token",
  })
})

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  availableBuiltinMcpServers,
  composeBoxComputerEnvironment,
  locateBoxComputerBundle,
} from "../../source/shared/node/mcp/builtin-mcp.ts"
import {
  LOCAL_DOCKER_SENTINEL,
  SLATE_BOX_COMPUTER_SERVER,
  SLATE_BOX_CONTAINER_DEFAULT,
  selectBoxComputerRuntime,
} from "../../source/shared/node/mcp/box-computer-runtime-policy.ts"

test("box-computer runtime selection honors the active box and explicit boolean flags", () => {
  assert.equal(selectBoxComputerRuntime(false, { SLATE_BOX_COMPUTER_SHARED_DOCKER: " TRUE " }).shared, true)
  assert.equal(selectBoxComputerRuntime(true, {}).shared, true)
  assert.equal(selectBoxComputerRuntime(false, { SLATE_BOX_COMPUTER_SHARED_DOCKER: "yes" }).shared, false)
})

test("box-computer settings trim overrides and treat the local sentinel as no remote host", () => {
  assert.deepEqual(selectBoxComputerRuntime(false, {
    SLATE_BOX_COMPUTER_DOCKER_HOST: " tcp://box-host:2375 ",
    SLATE_BOX_COMPUTER_SHARED_CONTAINER: " named-box ",
  }), {
    shared: false,
    containerName: "named-box",
    dockerHost: "tcp://box-host:2375",
    dockerPath: "docker",
  })
  assert.equal(selectBoxComputerRuntime(false, {
    SLATE_BOX_COMPUTER_DOCKER_HOST: LOCAL_DOCKER_SENTINEL.toUpperCase(),
  }).dockerHost, undefined)
  assert.equal(selectBoxComputerRuntime(false, {}).containerName, SLATE_BOX_CONTAINER_DEFAULT)
})

test("shared runtime environment is copied and only overrides its scoped container settings", () => {
  const base = { PATH: "/bin", DOCKER_HOST: "tcp://stale-host", OMIT: undefined }
  const configured = composeBoxComputerEnvironment({ shared: true, containerName: "slate-box-2", dockerHost: undefined, dockerPath: "docker" }, base)

  assert.notEqual(configured, base)
  assert.deepEqual(configured, {
    PATH: "/bin",
    ELECTRON_RUN_AS_NODE: "1",
    SLATE_BOX_COMPUTER: "1",
    BOX_COMPUTER_BACKEND: "shared-docker",
    BOX_COMPUTER_SHARED_CONTAINER_NAME: "slate-box-2",
  })
  assert.equal(base.DOCKER_HOST, "tcp://stale-host")
})

test("builtin entry resolution accepts an override and otherwise stays beside the host bundle", () => {
  assert.equal(locateBoxComputerBundle({ SLATE_BOX_COMPUTER_ENTRY: " /opt/slate/mcp.js " }), "/opt/slate/mcp.js")
  assert.match(locateBoxComputerBundle({}, "file:///opt/slate/host/builtin.js"), /projects\/box-computer\/dist\/mcp\.js$/)
})

test("a builtin server is absent until its bundle exists and then receives the runtime environment", () => {
  const runtime = { shared: true, containerName: "slate-box", dockerHost: "tcp://remote", dockerPath: "docker" as const }
  assert.deepEqual(availableBuiltinMcpServers(runtime, "/missing/mcp.js", () => false), {})
  const servers = availableBuiltinMcpServers(runtime, "/bundle/mcp.js", () => true)

  assert.equal(servers[SLATE_BOX_COMPUTER_SERVER]?.type, "stdio")
  assert.deepEqual(servers[SLATE_BOX_COMPUTER_SERVER]?.args, ["/bundle/mcp.js"])
  assert.equal(servers[SLATE_BOX_COMPUTER_SERVER]?.env?.BOX_COMPUTER_SHARED_CONTAINER_NAME, "slate-box")
  assert.equal(servers[SLATE_BOX_COMPUTER_SERVER]?.env?.DOCKER_HOST, "tcp://remote")
})

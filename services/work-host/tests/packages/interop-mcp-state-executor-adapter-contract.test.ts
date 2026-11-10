import assert from "node:assert/strict"
import test from "node:test"
import { createMcpStateExecutorAdapter } from "../../source/adapters/interop/mcp/mcp-state-executor-adapter.ts"

const context = { turnId: "turn-7" }

test("provider tool definitions are grouped into the external server response", async () => {
  const schema = { type: "object", properties: { issueId: { type: "string" } } }
  let receivedContext: unknown
  const executor = createMcpStateExecutorAdapter({
    getTools: async (requestContext) => {
      receivedContext = requestContext
      return [
        { providerIdentifier: "linear", name: "issue", toolName: "linear_issue", description: "Read an issue", inputSchema: schema },
        { providerIdentifier: "linear", name: "comment", toolName: "linear_comment" },
        { providerIdentifier: "slack", name: "post", toolName: "slack_post" },
      ]
    },
  })

  const result = await executor.execute(context)

  assert.equal(result.result.case, "success")
  const servers = result.result.case === "success" ? result.result.value.servers : []
  assert.equal(receivedContext, context)
  assert.deepEqual(servers.map(server => server.serverIdentifier), ["linear", "slack"])
  assert.deepEqual(servers.map(server => server.serverName), ["linear", "slack"])
  assert.deepEqual(servers.map(server => server.status), ["connected", "connected"])
  assert.deepEqual(servers[0]?.tools.map(tool => tool.toolName), ["linear_issue", "linear_comment"])
  assert.equal(servers[0]?.tools[0]?.name, "issue")
  assert.equal(servers[0]?.tools[0]?.description, "Read an issue")
  assert.deepEqual(servers[0]?.tools[0]?.inputSchema?.toJson(), schema)
})

test("an empty discovery result encodes a successful response with no servers", async () => {
  const executor = createMcpStateExecutorAdapter({ getTools: async () => [] })

  const result = await executor.execute(context)

  assert.equal(result.result.case, "success")
  assert.deepEqual(result.result.case === "success" ? result.result.value.servers : [], [])
})

test("a discovery error propagates to the state-executor caller", async () => {
  const offline = new Error("discovery unavailable")
  const executor = createMcpStateExecutorAdapter({ getTools: async () => { throw offline } })

  await assert.rejects(executor.execute(context), offline)
})

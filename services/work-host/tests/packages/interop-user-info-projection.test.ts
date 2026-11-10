import assert from "node:assert/strict"
import test from "node:test"

import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { CursorRuleSource, CursorRule, CursorRuleType } from "../../source/adapters/interop/proto/generated/agent/v1/rules_pb.ts"
import { McpDescriptor } from "../../source/adapters/interop/proto/generated/agent/v1/mcp_pb.ts"
import { projectInteropCursorRule, projectInteropEnvironment, renderInteropUserInfo } from "../../source/adapters/interop/agent/user-info-input-adapter.ts"
import { MountedAgentStoreKind, RequestContextEnv } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts"

test("wire rules are projected into a narrow prompt-owned descriptor", () => {
  const rule = new CursorRule({
    fullPath: "/repo/.cursor/rules/source.mdc",
    content: "Use the repository formatter.",
    source: CursorRuleSource.USER,
    environments: ["local"],
    disabledEnvironments: ["cloud"],
    type: {
      type: {
        case: "fileGlobbed",
        value: { globs: ["src/**"] },
      },
    },
  } as never)

  assert.deepEqual(projectInteropCursorRule(rule), {
    fullPath: "/repo/.cursor/rules/source.mdc",
    content: "Use the repository formatter.",
    source: "user",
    environments: ["local"],
    disabledEnvironments: ["cloud"],
    type: { type: { case: "fileGlobbed", value: { globs: ["src/**"] } } },
  })
})

test("request environment projects only the machine facts used by the prompt", () => {
  const env = new RequestContextEnv({
    osVersion: "Slate OS",
    shell: "zsh",
    workspacePaths: ["/repo"],
    projectFolder: "/repo",
    timeZone: "UTC",
    processWorkingDirectory: "/repo/packages/app",
    isWorkingDirHomeDir: false,
    agentTranscriptsFolder: "/repo/.slate/transcripts",
    mountedAgentStores: [{ path: "/stores/user", kind: MountedAgentStoreKind.PRINCIPAL, alias: "user" }],
  })

  assert.deepEqual(projectInteropEnvironment(env), {
    osVersion: "Slate OS",
    shell: "zsh",
    workspacePaths: ["/repo"],
    projectFolder: "/repo",
    timeZone: "UTC",
    processWorkingDirectory: "/repo/packages/app",
    agentTranscriptsFolder: "/repo/.slate/transcripts",
    isWorkingDirHomeDir: false,
    mountedAgentStores: [{ path: "/stores/user", kind: "principal", alias: "user", readOnly: false }],
  })
})

test("project mode removes counterpart root-changing tools at the adapter boundary", () => {
  const descriptor = new McpDescriptor({
    serverIdentifier: "cursor-app-control",
    tools: [
      { toolName: "move_agent_to_root" },
      { toolName: "lookup_project" },
    ],
  } as never)
  const rendered = renderInteropUserInfo({
    mode: AgentMode.PROJECT,
    rules: [new CursorRule({
      fullPath: "/repo/.slate/rules/style.md",
      content: "Use the workspace formatter.",
      source: CursorRuleSource.USER,
    })],
    displayOptions: { displayGitStatus: false, displayTodaysDate: false },
    isLargeContextModel: true,
    mcpMetaToolOptions: { enabled: true, mcpDescriptors: [descriptor] },
  })

  assert.match(rendered, /Use the workspace formatter\./)
  assert.match(rendered, /lookup_project/)
  assert.doesNotMatch(rendered, /move_agent_to_root/)
})

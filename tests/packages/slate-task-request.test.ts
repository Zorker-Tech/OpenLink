import assert from "node:assert/strict"
import test from "node:test"

import { slateTaskRequestFromModelArgumentsInterop } from "../../source/adapters/interop/agent/task-tool-protocol-adapter.ts"

test("model tool argument names enter the task core as a detached Slate request", () => {
  const attachments = ["/repo/report.png"]
  const labels: Record<string, string> = { tier: "gpu", region: "eu" }
  const request = slateTaskRequestFromModelArgumentsInterop({
    description: "read the report",
    prompt: "summarize the report",
    model: "model-2",
    resume: "agent-7",
    subagent_type: "browserUse",
    file_attachments: attachments,
    machine: { type: "self_hosted_pool", pool: "reviewers", labels },
    run_in_background: false,
    interrupt: true,
  })

  assert.equal(request.targetMachine?.kind, "worker-pool")
  if (request.targetMachine?.kind === "worker-pool") {
    assert.deepEqual(Object.keys(request.targetMachine.labels ?? {}), ["region", "tier"])
  }

  attachments.push("/repo/second.png")
  labels.region = "us"

  assert.deepEqual(request, {
    description: "read the report",
    prompt: "summarize the report",
    model: "model-2",
    resume: "agent-7",
    subagentType: "browserUse",
    fileAttachments: ["/repo/report.png"],
    targetMachine: { kind: "worker-pool", pool: "reviewers", labels: { region: "eu", tier: "gpu" } },
    runInBackground: false,
    interrupt: true,
  })
})

test("legacy cloud placement arguments are normalized to Slate request names", () => {
  assert.deepEqual(slateTaskRequestFromModelArgumentsInterop({
    prompt: "delegate this",
    environment: "cloud",
    cloud_base_branch: "release",
    cloud_requested_environment_build_id: "build-4",
  }), {
    prompt: "delegate this",
    environment: "cloud",
    cloudBaseBranch: "release",
    requestedRuntimeBuildId: "build-4",
  })
})

test("legacy target variants normalize to Slate placement kinds and fields", () => {
  assert.deepEqual(slateTaskRequestFromModelArgumentsInterop({
    prompt: "delegate this",
    machine: { type: "new_cloud_vm", base_branch: "release", environment_build_id: "build-4" },
  }).targetMachine, {
    kind: "cloud-machine",
    baseBranch: "release",
    environmentBuildId: "build-4",
  })
})

test("model tool argument projection refuses non-object inputs and missing prompts", () => {
  assert.throws(() => slateTaskRequestFromModelArgumentsInterop(null), /Task tool input must be an object/)
  assert.throws(() => slateTaskRequestFromModelArgumentsInterop({ description: "missing prompt" }), /Task tool prompt must be a string/)
})

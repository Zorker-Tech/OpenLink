import assert from "node:assert/strict"
import test from "node:test"
import { AgentMode } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { isManagedCanvasEditPath, isPlanMode } from "../../source/adapters/interop/agent/plan-edit-policy-adapter.ts"

test("the mode adapter maps the external planning value into a Slate boolean", () => {
  assert.equal(isPlanMode(AgentMode.PLAN), true)
  assert.equal(isPlanMode(AgentMode.AGENT), false)
})

test("the canvas adapter accepts only managed project canvas paths", () => {
  assert.equal(isManagedCanvasEditPath("/repo/.cursor/projects/p1/canvases/board.canvas.tsx"), true)
  assert.equal(isManagedCanvasEditPath("C:\\repo\\.cursor\\projects\\p1\\canvases\\board.canvas.tsx"), true)
  assert.equal(isManagedCanvasEditPath("/repo/.cursor/projects/p1/canvases/nested/board.canvas.tsx"), false)
  assert.equal(isManagedCanvasEditPath("/repo/.cursor/projects/p1/canvases/board.tsx"), false)
})

import { test } from "node:test"
import assert from "node:assert/strict"

import { adaptInteropTestingPromptProfile } from "../../source/adapters/interop/agent/testing-prompt-profile-adapter.ts"
import { renderContent } from "../../source/packages/prompt-jsx/index.ts"
import { TestingInstructions2 } from "../../source/packages/agent/prompts/testing/instructions.ts"
import { TestingInstructions } from "../../source/packages/agent/prompts/testing/testing-instructions.ts"

function render(overrides: Record<string, unknown> = {}): string {
  return renderContent(TestingInstructions({
    props: {
      env: { artifactsFolder: "/tmp/run-artifacts/" },
      modelInfo: {},
      toolInfo: { allTools: {} },
      ...((overrides.props ?? {}) as Record<string, unknown>),
    },
    ...overrides,
  } as never))
}

test("the full workflow orders success criteria, plan, implementation, checks and review", () => {
  const prompt = render()
  const sequence = [
    "define_success_state",
    "form_test_plan",
    "perform_implementation",
    "test_your_work",
    "validate_testing",
    "iterative_debugging",
    "post_testing_cleanup",
    "walkthrough_artifacts",
  ].map(marker => prompt.indexOf(marker))
  assert.equal(sequence.every(index => index >= 0), true)
  assert.deepEqual(sequence, [...sequence].sort((left, right) => left - right))
  assert.match(prompt, /observable result would show that the request is complete/)
  assert.match(prompt, /focused automated or manual checks/)
  assert.match(prompt, /run the changed path/)
  assert.match(prompt, /\/tmp\/run-artifacts/)
})

test("the compact mode retains verification, validation and caller instructions", () => {
  const prompt = render({
    omitTestingWorkflow: true,
    additionalInstructions: ["Verify the callback path."],
  })
  assert.doesNotMatch(prompt, /define_success_state/)
  assert.doesNotMatch(prompt, /perform_implementation/)
  assert.match(prompt, /testing_directives/)
  assert.match(prompt, /validate_testing/)
  assert.match(prompt, /Verify the callback path\./)
  assert.match(prompt, /walkthrough_artifacts/)
})

test("artifact and debugging sections follow their explicit switches", () => {
  const withoutArtifacts = render({ disableDemoCreation: true })
  assert.doesNotMatch(withoutArtifacts, /walkthrough_artifacts/)

  const withDebugHelper = render({ props: { featureFlags: { enableDebugSubagent: true }, toolInfo: { allTools: { DELETE: { name: "RemoveFile" } } } } })
  assert.match(withDebugHelper, /debugging_with_subagent/)
  assert.match(withDebugHelper, /RemoveFile/)
  assert.doesNotMatch(withDebugHelper, /iterative_debugging/)
})

test("the adapter maps external model and tool metadata to Slate prompt controls", () => {
  assert.deepEqual(adaptInteropTestingPromptProfile(
    { isCodexFamily: true, isOpus45: true },
    { allTools: { DELETE: { name: "RemoveFile" }, RECORD_SCREEN: { name: "CaptureScreen" } } },
  ), {
    preferFocusedChecks: true,
    requireExtendedValidation: true,
    deleteFileToolName: "RemoveFile",
    screenRecorderToolName: "CaptureScreen",
  })
})

test("the cloud testing wrapper forwards every option to the shared Slate prompt", () => {
  const cases = [
    { props: { env: { artifactsFolder: "/tmp/run-artifacts/" }, modelInfo: {}, toolInfo: { allTools: {} } } },
    {
      props: { env: { artifactsFolder: "/tmp/run-artifacts/" }, featureFlags: { enableDebugSubagent: true }, modelInfo: {}, toolInfo: { allTools: { DELETE: { name: "RemoveFile" } } } },
      additionalInstructions: ["Verify the callback path."],
      disableDemoCreation: true,
      computerUseSubagentName: "computerUse",
      omitTestingWorkflow: true,
    },
  ]

  for (const options of cases) {
    assert.equal(renderContent(TestingInstructions2(options)), renderContent(TestingInstructions(options)))
  }
})

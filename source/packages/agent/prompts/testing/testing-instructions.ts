/** Slate's testing workflow: define observable success, run relevant checks, inspect evidence and correct failures. */

import { Fragment, jsx, jsxs, type PromptNode } from "../../../prompt-jsx/index.ts"
import { resolvePromptArtifactsDir } from "../prompt-sections.ts"
import { AgentsMdInstructions } from "./agents-md-instructions.ts"
import { adaptInteropTestingPromptProfile } from "../../../../adapters/interop/agent/testing-prompt-profile-adapter.ts"

export interface TestingPromptProps {
  readonly env?: { readonly artifactsFolder?: string | undefined } | undefined
  readonly featureFlags?: { readonly enableDebugSubagent?: boolean | undefined } | undefined
  readonly modelInfo?: unknown
  readonly toolInfo?: unknown
}

export interface TestingInstructionsOptions {
  readonly props: TestingPromptProps
  readonly additionalInstructions?: string[] | undefined
  readonly disableDemoCreation?: boolean | undefined
  readonly computerUseSubagentName?: string | undefined
  readonly useDebugSubagent?: boolean | undefined
  readonly omitTestingWorkflow?: boolean | undefined
  readonly [key: string]: unknown
}

function SuccessCriteriaSection({ step }: { readonly step: number }) {
  return jsxs("section", {
    title: "define_success_state",
    children: [
      jsxs("h3", { children: ["Step ", step, ": Describe the expected result"] }),
      jsx("p", { children: "Before editing, decide what observable result would show that the request is complete. Use the same starting conditions before and after the change when comparing a bug fix." }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "For a defect, capture the failing behavior first, then repeat the same steps after the fix." }),
          jsx("li", { children: "For a feature, exercise its main path and the important boundary cases." }),
          jsx("li", { children: "For a visual change, inspect the rendered page or screen at the sizes the change affects." }),
          jsx("li", { children: "For performance work, compare measurements made with the same setup." }),
        ],
      }),
      jsx("p", { children: "A build or a related feature working does not prove that the changed path works. If evidence remains incomplete, state what could not be verified." }),
    ],
  })
}

function TestPlanSection({ step, computerUseSubagentName, profile, trimmed }: {
  readonly step: number
  readonly computerUseSubagentName: string
  readonly profile: ReturnType<typeof adaptInteropTestingPromptProfile>
  readonly trimmed: boolean
}) {
  return jsxs("section", {
    title: "form_test_plan",
    children: [
      jsxs("h3", { children: ["Step ", step, ": Choose verification steps"] }),
      jsx("p", { children: "Trace how the changed code is reached, then choose checks that exercise that path. Include any setup, flags or user interaction needed to make the behavior run." }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Run focused automated checks that cover the changed behavior; expand the scope only when the risk or project instructions call for it." }),
          jsx("li", { children: "Use manual interaction when automated checks cannot show the complete experience, especially for non-trivial UI work or an explicit user request." }),
          jsx("li", { children: "Keep test fixtures and temporary diagnostics scoped to the task, and remove temporary instrumentation after validating the fix." }),
          profile.preferFocusedChecks && jsx("li", { children: "Prefer the smallest high-signal test targets. Do not run a large repository-wide suite unless requested or needed to answer a concrete risk." }),
          !trimmed && jsxs("li", { children: ["For desktop or browser checks, use the `", computerUseSubagentName, "` helper to operate the UI; use terminal commands for terminal-only checks."] }),
        ],
      }),
    ],
  })
}

function ImplementationSection({ useDebugSubagent }: { readonly useDebugSubagent: boolean }) {
  return jsxs("section", {
    title: "perform_implementation",
    children: [
      jsx("h3", { children: "Implement the change" }),
      jsx("p", { children: "Follow the task instructions and repository guidance. Keep the patch focused, reuse existing patterns, and make progress in pieces that can be checked." }),
      useDebugSubagent && jsx("p", { children: "For a reproducible bug with an unclear cause, use the debugging helper to collect evidence and test likely causes before choosing a fix." }),
    ],
  })
}

function TestWorkSection({ step, planStep, profile, additionalInstructions, trimmed }: {
  readonly step: number
  readonly planStep: number
  readonly profile: ReturnType<typeof adaptInteropTestingPromptProfile>
  readonly additionalInstructions: readonly string[]
  readonly trimmed: boolean
}) {
  return jsxs("section", {
    title: "test_your_work",
    children: [
      jsxs("h3", { children: ["Step ", step, ": Run the checks"] }),
      jsx("p", { children: `Execute the plan from Step ${planStep}. Adapt it when implementation reveals a better way to exercise the behavior.` }),
      profile.requireExtendedValidation && jsx("p", { children: "Take enough time to cover the main flow and the cases that could change the result." }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "If a check fails or leaves the result unclear, find the cause, make the necessary change and run the relevant check again." }),
          jsx("li", { children: "Respect an explicit request to skip testing. Otherwise run the checks that give useful evidence for this change." }),
          jsx("li", { children: "Do not add a broad test framework or unrelated environment changes just to produce evidence." }),
          !trimmed && jsx("li", { children: "When the user requested a specific manual scenario, include evidence from that scenario rather than a substitute demo." }),
          additionalInstructions.map(instruction => jsx("li", { children: instruction })),
        ],
      }),
    ],
  })
}

function ShortTestingGuidance({ additionalInstructions }: { readonly additionalInstructions: readonly string[] }) {
  return jsxs("section", {
    title: "testing_directives",
    children: [
      jsx("h3", { children: "Verification" }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Run useful checks when the user has not asked you to skip them, and summarize the evidence accurately." }),
          jsx("li", { children: "Follow the requested test procedure. If a check cannot be run, explain the concrete blocker." }),
          jsx("li", { children: "Use process identifiers for cleanup; do not stop unrelated applications or services." }),
          additionalInstructions.map(instruction => jsx("li", { children: instruction })),
        ],
      }),
    ],
  })
}

function ValidateResultsSection({ step, computerUseSubagentName, trimmed }: {
  readonly step: number
  readonly computerUseSubagentName: string
  readonly trimmed: boolean
}) {
  return jsxs("section", {
    title: "validate_testing",
    children: [
      jsxs("h3", { children: ["Step ", step, ": Review the evidence"] }),
      jsx("p", { children: trimmed
        ? "Check test output and logs against the requested result. Repeat a check if it did not exercise the changed path."
        : `Compare the observed result with the success criteria. Review terminal output, logs and any screen evidence from the ${computerUseSubagentName} helper. A passing build alone is not end-to-end proof.` }),
      !trimmed && jsxs("ul", {
        children: [
          jsx("li", { children: "Check for regressions and details that the first pass may have missed." }),
          jsx("li", { children: "If evidence is missing, adjust the test and gather it before making a completion claim." }),
          jsx("li", { children: "Keep the final report clear about which checks passed and which remain unverified." }),
        ],
      }),
    ],
  })
}

function DebuggingSection({ step, computerUseSubagentName, deleteFileToolName }: {
  readonly step: number
  readonly computerUseSubagentName: string
  readonly deleteFileToolName: string
}) {
  return jsxs("section", {
    title: "debugging_with_subagent",
    children: [
      jsxs("h3", { children: ["Step ", step, ": Diagnose and retry"] }),
      jsx("p", { children: "When a reproducible defect has an unclear cause, ask the debugging helper to investigate with the relevant code and observed symptoms." }),
      jsxs("ol", {
        children: [
          jsx("li", { children: "Record a small set of plausible causes and choose evidence that can distinguish them." }),
          jsxs("li", { children: ["Reproduce the behavior with the `", computerUseSubagentName, "` helper or focused commands, then review the resulting output."] }),
          jsx("li", { children: "Change the likely cause, repeat the reproduction and compare the result." }),
          jsx("li", { children: `Remove temporary diagnostics with ${deleteFileToolName} or the appropriate file operation after the verification passes.` }),
        ],
      }),
    ],
  })
}

function IterativeDebuggingSection({ step, deleteFileToolName }: { readonly step: number; readonly deleteFileToolName: string }) {
  return jsxs("section", {
    title: "iterative_debugging",
    children: [
      jsxs("h3", { children: ["Step ", step, ": Correct and verify failures"] }),
      jsx("p", { children: "Use a failed check to narrow the cause. Gather the smallest useful log or runtime observation, change one likely cause, then rerun the same check." }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Keep diagnostic output temporary and avoid recording credentials or personal data." }),
          jsx("li", { children: "Compare the failing and passing observations before concluding that the issue is fixed." }),
          jsx("li", { children: `Delete temporary logs with ${deleteFileToolName} after the successful verification.` }),
        ],
      }),
    ],
  })
}

function CleanupSection() {
  return jsxs("section", {
    title: "post_testing_cleanup",
    children: [
      jsx("h3", { children: "Leave the workspace in a useful state" }),
      jsx("p", { children: "Remove temporary debug code and test data that this run created. Keep existing user data and unrelated processes intact." }),
      jsx("p", { children: "Leave a development server running when the user may want to inspect it. Stop only processes started for a check when cleanup is needed." }),
    ],
  })
}

function WalkthroughArtifactsSection({ computerUseSubagentName, artifactsDir, screenRecorderToolName }: {
  readonly computerUseSubagentName: string
  readonly artifactsDir: string
  readonly screenRecorderToolName?: string
}) {
  const directory = artifactsDir.replace(/[\\/]+$/, "")
  return jsxs("section", {
    title: "walkthrough_artifacts",
    children: [
      jsx("h3", { children: "Show the working result" }),
      jsx("p", { children: "After the checks pass, include a small set of screenshots or recordings that make the requested change easy to verify. Include any manual scenario the user asked you to perform." }),
      jsxs("ul", {
        children: [
          jsx("li", { children: "Capture the relevant final state or a successful end-to-end flow. Do not upload failed attempts, setup-only screens or synthetic demonstrations." }),
          jsxs("li", { children: ["Use the `", computerUseSubagentName, "` helper for UI interactions and keep each recording focused on one successful scenario."] }),
          screenRecorderToolName !== undefined && jsx("li", { children: `Use ${screenRecorderToolName} to start and stop a recording; save only a successful, user-facing capture.` }),
          jsx("li", { children: `Save selected artifacts under ${directory}, give them descriptive names and link them in the final report using the supported attachment syntax.` }),
        ],
      }),
    ],
  })
}

export function TestingInstructions(options: TestingInstructionsOptions) {
  const {
    props,
    additionalInstructions = [],
    disableDemoCreation = false,
    computerUseSubagentName = "computerUse",
    useDebugSubagent = props.featureFlags?.enableDebugSubagent === true,
    omitTestingWorkflow = false,
  } = options
  const profile = adaptInteropTestingPromptProfile(props.modelInfo, props.toolInfo)
  const stepNumbers = omitTestingWorkflow
    ? { formTestPlan: 1, validateTesting: 2, debugging: 3 }
    : { successCriteria: 1, formTestPlan: 2, testYourWork: 4, validateTesting: 5, debugging: 6 }
  return jsxs(Fragment, {
    children: [
      jsx(AgentsMdInstructions as unknown as (props: Record<string, unknown>) => PromptNode, {}),
      jsxs("section", {
        title: "testing",
        children: [
          jsx("h2", { children: "Verify the requested behavior" }),
          !omitTestingWorkflow && jsxs(Fragment, {
            children: [
              jsx("p", { children: "Do not infer success from reading code. Decide what result would prove the change works, run the changed path, and inspect the evidence." }),
              jsxs("ol", {
                children: [
                  jsx("li", { children: "Set observable success criteria." }),
                  jsx("li", { children: "Choose focused automated or manual checks." }),
                  jsx("li", { children: "Implement the change in reviewable pieces." }),
                  jsx("li", { children: "Run the checks and examine their output." }),
                  jsx("li", { children: "Fix failures and repeat the relevant checks." }),
                ],
              }),
            ],
          }),
          omitTestingWorkflow && jsx("p", { children: "Run relevant checks and provide direct evidence of the result." }),
          !omitTestingWorkflow && jsx(SuccessCriteriaSection as unknown as (props: Record<string, unknown>) => PromptNode, { step: stepNumbers.successCriteria }),
          jsx(TestPlanSection as unknown as (props: Record<string, unknown>) => PromptNode, {
            step: stepNumbers.formTestPlan,
            computerUseSubagentName,
            profile,
            trimmed: omitTestingWorkflow,
          }),
          !omitTestingWorkflow && jsx(ImplementationSection as unknown as (props: Record<string, unknown>) => PromptNode, { useDebugSubagent }),
          !omitTestingWorkflow && jsx(TestWorkSection as unknown as (props: Record<string, unknown>) => PromptNode, {
            step: stepNumbers.testYourWork,
            planStep: stepNumbers.formTestPlan,
            profile,
            additionalInstructions,
          }),
          omitTestingWorkflow && jsx(ShortTestingGuidance as unknown as (props: Record<string, unknown>) => PromptNode, { additionalInstructions }),
          jsx(ValidateResultsSection as unknown as (props: Record<string, unknown>) => PromptNode, {
            step: stepNumbers.validateTesting,
            computerUseSubagentName,
            trimmed: omitTestingWorkflow,
          }),
          useDebugSubagent
            ? jsx(DebuggingSection as unknown as (props: Record<string, unknown>) => PromptNode, {
              step: stepNumbers.debugging,
              computerUseSubagentName,
              deleteFileToolName: profile.deleteFileToolName,
            })
            : !omitTestingWorkflow && jsx(IterativeDebuggingSection as unknown as (props: Record<string, unknown>) => PromptNode, {
              step: stepNumbers.debugging,
              deleteFileToolName: profile.deleteFileToolName,
            }),
          jsx(CleanupSection as unknown as (props: Record<string, unknown>) => PromptNode, {}),
        ],
      }),
      !disableDemoCreation && jsx(WalkthroughArtifactsSection as unknown as (props: Record<string, unknown>) => PromptNode, {
        computerUseSubagentName,
        artifactsDir: resolvePromptArtifactsDir(props),
        ...(profile.screenRecorderToolName === undefined ? {} : { screenRecorderToolName: profile.screenRecorderToolName }),
      }),
      jsx("p", { children: "If the UI runner is unavailable, use the strongest automated checks the environment supports and state the limit clearly." }),
    ],
  })
}

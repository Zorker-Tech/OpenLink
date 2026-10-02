import { test } from "node:test"
import assert from "node:assert/strict"

import { readSlateModelExperimentEnvOverride, resolveSlateModelExperimentState, SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION } from "../../source/shared/node/experiments/slate-model-experiment.ts"
import { SLATE_DEFAULT_MODEL_ID, SLATE_DEFAULT_MODEL_SELECTION } from "../../source/shared/agents/agent-model.ts"
import { MAX_MODEL_ID_LENGTH, MAX_PARAMETERS, resolveSlateDefaultModelConfig, ROUTED_MODEL_IDS } from "../../source/shared/node/experiments/slate-model-config.ts"
import { imageContentType, readCappedImageBytes } from "../../source/shared/node/http-image.ts"
import { LISTENER_INTEGRATIONS } from "../../source/shared/listener-integrations.ts"
import { markdownToPreviewText } from "../../source/shared/media/markdown-preview.ts"
import { isHttpExternalUrl, parseAllowedExternalUrl } from "../../source/shared/external-url-policy.ts"
import { decideBoxHandBack } from "../../source/shared/forever-box.ts"
import { isValidVncLivenessReport, VNC_LIVENESS_CHANNEL, VNC_LIVENESS_MIN_IMPACTFUL_INPUTS, VNC_LIVENESS_WINDOW_MS } from "../../source/shared/vnc-liveness.ts"
import { isCoordinatorMainMethod, COORDINATOR_MAIN_METHOD_TABLE } from "../../source/shared/rpc/coordinator-main.ts"
import { renderMcpOAuthErrorPage, renderMcpOAuthSuccessPage } from "../../source/shared/mcp-oauth-callback-page.ts"
import { BINARY_CONTROL_BYTE_RATIO, BINARY_SNIFF_BYTE_WINDOW, isTextPreviewableName, looksLikeBinary } from "../../source/shared/media/attachment-preview.ts"
import {
  clampWorkflowBody,
  clampWorkflowDescription,
  clampWorkflowName,
  collectMentionedWorkflows,
  renderWorkflowsSystemPrompt,
  slugifyWorkflowName,
  WORKFLOW_FILENAME,
  WORKFLOW_MAX_NAME_LENGTH,
} from "../../source/shared/workflow-model.ts"

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

test("an experiment arm is read from the environment or from the group a user is in", () => {
  assert.equal(readSlateModelExperimentEnvOverride({ SLATE_MODEL_EXPERIMENT_OVERRIDE: "control" } as NodeJS.ProcessEnv)?.arm, "control")
  assert.equal(readSlateModelExperimentEnvOverride({ SLATE_MODEL_EXPERIMENT_OVERRIDE: "test" } as NodeJS.ProcessEnv)?.arm, "treatment")
  assert.equal(readSlateModelExperimentEnvOverride({} as NodeJS.ProcessEnv), undefined)
  // The environment wins over the group, and a user in no group is not in the experiment at all.
  assert.equal(resolveSlateModelExperimentState({ envOverride: { active: true, arm: "control" }, groupName: "x", enabled: true })?.arm, "control")
  assert.equal(resolveSlateModelExperimentState({ groupName: null, enabled: true }), undefined)
  assert.equal(resolveSlateModelExperimentState({ groupName: "x", enabled: false })?.arm, "control")
  assert.equal(resolveSlateModelExperimentState({ groupName: "x", enabled: true })?.arm, "treatment")
  assert.equal(SLATE_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION.modelId.length > 0, true)
})

test("the model an agent runs on by default is one the platform names", () => {
  assert.equal(SLATE_DEFAULT_MODEL_SELECTION.modelId, SLATE_DEFAULT_MODEL_ID)
  assert.equal(SLATE_DEFAULT_MODEL_SELECTION.parameters.length > 0, true)
})

test("a model configuration is checked before it is used", () => {
  const selection = { modelId: "some-model", maxMode: true, parameters: [{ id: "effort", value: "high" }] }
  assert.deepEqual(resolveSlateDefaultModelConfig({ raw: selection, hasHydratedExperimentUser: true }).selection?.modelId, "some-model")
  // Nothing is read before the identity behind the configuration is known.
  assert.equal(resolveSlateDefaultModelConfig({ raw: selection, hasHydratedExperimentUser: false }).rejection, "identity_unhydrated")
  assert.equal(resolveSlateDefaultModelConfig({ raw: "nope", hasHydratedExperimentUser: true }).rejection, "malformed")
  assert.equal(resolveSlateDefaultModelConfig({ raw: { modelId: "x", maxMode: "yes", parameters: [] }, hasHydratedExperimentUser: true }).rejection, "malformed")
  assert.equal(resolveSlateDefaultModelConfig({ raw: { modelId: "x".repeat(MAX_MODEL_ID_LENGTH + 1), maxMode: true, parameters: [] }, hasHydratedExperimentUser: true }).rejection, "invalid_model_id")
  assert.equal(resolveSlateDefaultModelConfig({ raw: { modelId: "x", maxMode: true, parameters: Array.from({ length: MAX_PARAMETERS + 1 }, () => ({ id: "a", value: "b" })) }, hasHydratedExperimentUser: true }).rejection, "parameters_out_of_bounds")
  // A model the platform routes by itself may not carry parameters.
  const routed = [...ROUTED_MODEL_IDS][0] as string
  assert.equal(resolveSlateDefaultModelConfig({ raw: { modelId: routed, maxMode: true, parameters: [{ id: "a", value: "b" }] }, hasHydratedExperimentUser: true }).rejection, "routed_model_parameters")
  // An empty id is no configuration rather than a broken one.
  assert.equal(resolveSlateDefaultModelConfig({ raw: { modelId: "", maxMode: true, parameters: [] }, hasHydratedExperimentUser: true }).selection, undefined)
  assert.equal(resolveSlateDefaultModelConfig({ raw: { modelId: "", maxMode: true, parameters: [] }, hasHydratedExperimentUser: true }).rejection, undefined)
})

// ---------------------------------------------------------------------------------------------
// Images, previews and what may be opened
// ---------------------------------------------------------------------------------------------

test("an image is read only when the response says it is one, and only up to a limit", async () => {
  const headers = new Headers({ "content-type": "image/png" })
  assert.equal(imageContentType({ headers }), "image/png")
  assert.equal(imageContentType({ headers: new Headers({ "content-type": "text/html" }) }), null)

  const body = (chunks: readonly string[]) =>
    new Response(chunks.join("")).body as ReadableStream<Uint8Array>
  const read = await readCappedImageBytes({ headers, body: body(["abc"]) }, 10)
  assert.equal(read?.toString(), "abc")
  // A response that declares more than the limit, or that sends more, is refused rather than read.
  assert.equal(await readCappedImageBytes({ headers: new Headers({ "content-length": "100" }), body: body(["abc"]) }, 10), null)
  assert.equal(await readCappedImageBytes({ headers, body: body(["abcdefghijk"]) }, 10), null)
  assert.equal(await readCappedImageBytes({ headers, body: null as unknown as ReadableStream<Uint8Array> }, 10), null)
})

test("the platforms an automation can listen to are the ones the platform offers", () => {
  assert.deepEqual(LISTENER_INTEGRATIONS.map(integration => integration.platform), ["github", "slack"])
  assert.equal(LISTENER_INTEGRATIONS.every(integration => integration.displayName.length > 0 && integration.blurb.length > 0), true)
})

test("a markdown document's preview is its text", () => {
  const preview = markdownToPreviewText("# Title\n\nSome **bold** and _italic_ text with a [link](https://example.com).\n\n- item\n")
  assert.match(preview, /Title/)
  assert.match(preview, /Some bold and italic text with a link\./)
  assert.equal(preview.includes("**"), false)
  assert.equal(preview.includes("https://example.com"), false)
})

test("only the links a browser can be handed safely are opened", () => {
  assert.equal(parseAllowedExternalUrl("https://example.com") !== null, true)
  assert.equal(parseAllowedExternalUrl("mailto:a@example.com") !== null, true)
  assert.equal(parseAllowedExternalUrl("obsidian://open?vault=v") !== null, true)
  // Something a document could use to run anything else on the machine is not opened.
  assert.equal(parseAllowedExternalUrl("javascript:alert(1)"), null)
  assert.equal(parseAllowedExternalUrl("file:///etc/passwd"), null)
  assert.equal(parseAllowedExternalUrl("not a url"), null)
  assert.equal(isHttpExternalUrl("https://example.com"), true)
  assert.equal(isHttpExternalUrl("mailto:a@example.com"), false)
})

test("an attachment is previewed as text only when it is one", () => {
  assert.equal(isTextPreviewableName("notes.txt"), true)
  assert.equal(isTextPreviewableName("script.ts"), true)
  assert.equal(isTextPreviewableName("archive.zip"), false)
  assert.equal(isTextPreviewableName("photo.png"), false)
  // Bytes that look like a binary are not shown as text, whatever the name says.
  assert.equal(looksLikeBinary(new TextEncoder().encode("hello")), false)
  assert.equal(looksLikeBinary(new Uint8Array(Array.from({ length: 100 }, () => 0))), true)
  assert.equal(BINARY_SNIFF_BYTE_WINDOW > 0, true)
  assert.equal(BINARY_CONTROL_BYTE_RATIO > 0 && BINARY_CONTROL_BYTE_RATIO < 1, true)
})

// ---------------------------------------------------------------------------------------------
// Boxes, desktops and connections
// ---------------------------------------------------------------------------------------------

test("a box comes back only when the user decided something", () => {
  assert.deepEqual(decideBoxHandBack({ requestId: "req-1" }, "dismissed"), {
    kind: "resume",
    requestId: "req-1",
    trigger: "dismissed",
    resolution: "dismissed",
  })
  // Giving it back deliberately is the other way it comes back, and anything else is no decision at all.
  const handedBack = decideBoxHandBack({ requestId: "req-1" }, "handed_back")
  assert.equal(handedBack.kind === "resume" && handedBack.resolution, "handed_back")
  // Nothing was handed over, so there is nothing to resume.
  assert.deepEqual(decideBoxHandBack(undefined, "dismissed"), { kind: "none" })
  assert.deepEqual(decideBoxHandBack(null, "handed_back"), { kind: "none" })
})

test("a remote desktop that stopped answering is reported as stalled", () => {
  assert.equal(VNC_LIVENESS_CHANNEL, "slate:vnc-liveness")
  assert.equal(VNC_LIVENESS_WINDOW_MS, 10_000)
  assert.equal(VNC_LIVENESS_MIN_IMPACTFUL_INPUTS, 3)
  // A report is a bounded count of what happened, and one that is not is not a report.
  assert.equal(isValidVncLivenessReport({ phase: "post_connect", stallMs: 30_000, keys: 3, clicks: 1, moves: 20, inBytes: 0 }), true)
  assert.equal(isValidVncLivenessReport({ phase: "post_connect", stallMs: 30_000, keys: -1, clicks: 1, moves: 20, inBytes: 0 }), false)
  assert.equal(isValidVncLivenessReport({ phase: "after" }), false)
  assert.equal(isValidVncLivenessReport(null), false)
})

test("a connection answers the methods it declares, and nothing else", () => {
  assert.equal(isCoordinatorMainMethod("getHostStatus"), true)
  assert.equal(isCoordinatorMainMethod("toString"), false)
  assert.equal(Object.keys(COORDINATOR_MAIN_METHOD_TABLE).length > 10, true)
})

test("the page after an MCP authentication is escaped rather than injected", () => {
  const success = renderMcpOAuthSuccessPage({ serverName: "<script>alert(1)</script>" })
  assert.equal(success.includes("<script>alert(1)</script>"), false)
  assert.match(success, /&lt;script&gt;/)
  assert.match(renderMcpOAuthErrorPage({ serverName: "mine" }), /mine/)
})

// ---------------------------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------------------------

test("a workflow's name, description and body are bounded", () => {
  assert.equal(WORKFLOW_FILENAME, "SKILL.md")
  assert.equal(clampWorkflowName("x".repeat(WORKFLOW_MAX_NAME_LENGTH + 10)).length, WORKFLOW_MAX_NAME_LENGTH)
  assert.equal(clampWorkflowName("a\nb"), "a b")
  assert.equal(clampWorkflowDescription("  spaced  "), "spaced")
  assert.equal(clampWorkflowBody("a\nb\n").trim(), "a\nb")
  assert.equal(slugifyWorkflowName("My Workflow!"), "my-workflow")
  // A name with nothing a slug can hold still produces a usable folder name.
  assert.equal(slugifyWorkflowName("!!!"), "workflow")
})

test("a workflow is found in a prompt by its reference or its handle, and not inside a word", () => {
  const workflows = [
    { id: "deploy", name: "Deploy" },
    { id: "test", name: "Test" },
  ]
  assert.deepEqual(collectMentionedWorkflows("please [deploy](slate-workflow:deploy) now", workflows).map(workflow => workflow.id), ["deploy"])
  assert.deepEqual(collectMentionedWorkflows("run @deploy please", workflows).map(workflow => workflow.id), ["deploy"])
  // A handle inside a word is not a mention, and an unknown workflow is not one either.
  assert.deepEqual(collectMentionedWorkflows("mail@deploy.example", workflows), [])
  assert.deepEqual(collectMentionedWorkflows("run @nope", workflows), [])
})

test("the workflows prompt says where they live and how they are referenced", () => {
  assert.equal(renderWorkflowsSystemPrompt(undefined), "")
  const prompt = renderWorkflowsSystemPrompt("/home/user/.slate/skills")
  assert.match(prompt, /GLOBAL, shared library/)
  assert.match(prompt, /\/home\/user\/\.slate\/skills/)
  assert.match(prompt, /slate-workflow:<id>/)
})

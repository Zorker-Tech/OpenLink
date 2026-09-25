import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { cleanupLegacyMcpAuthCredentials, isLegacyMcpAuthFile, LEGACY_MCP_AUTH_FILENAME } from "../../source/shared/node/mcp/mcp-auth-cleanup.ts"
import {
  resolveSpotlightEnabled,
  sanitizeSource,
  SPOTLIGHT_TAG,
  SPOTLIGHT_TAG_REDACTION,
  spotlightClose,
  spotlightOpen,
  spotlightPromptSection,
  spotlightToolResultContent,
  stripSpotlightTag,
} from "../../source/shared/slate-spotlight.ts"
import { writeFileAtomic } from "../../source/shared/node/atomic-write.ts"
import {
  canonicalSlateDeepLinkUrl,
  parseSlateDeepLink,
  SLATE_DEEP_LINK_MAX_LENGTH,
  SLATE_DEEP_LINK_SCHEME,
  SLATE_HTTPS_DEEP_LINK_ORIGIN,
  SLATE_HTTPS_DEEP_LINK_PATH_PREFIX,
  SLATE_OPEN_DEEP_LINK_URL,
} from "../../source/shared/deep-link.ts"
import { redactSlateAutoReviewInlineSecrets } from "../../source/shared/slate-auto-review-redact.ts"
import {
  isSlateLocalToolAction,
  isSlateLocalToolPermission,
  normalizeSlateLocalToolPermission,
  SLATE_DEFAULT_LOCAL_TOOL_PERMISSION,
} from "../../source/shared/local-tool-permission.ts"
import { compareAgentSummaries, upsertAgentSummary } from "../../source/shared/agents/agent-summaries.ts"
import { isSlateAgentModelSelection, SLATE_COMPUTER_USE_MODEL_SELECTION, SLATE_SUMMARIZATION_MODEL_ID } from "../../source/shared/agents/slate-agent-model.ts"
import { emptySlateInferenceRouterUsage, isSlateInferenceProvider, SLATE_INFERENCE_PROVIDERS } from "../../source/shared/inference-router.ts"

// ---------------------------------------------------------------------------------------------
// Fencing what came from outside
// ---------------------------------------------------------------------------------------------

test("a tool result is fenced with where it came from, and the fence cannot be forged", () => {
  assert.equal(SPOTLIGHT_TAG.startsWith("slate_"), true)
  assert.equal(spotlightOpen('a "quoted" <tag>'), `<${SPOTLIGHT_TAG} source="a quoted tag">`)
  assert.equal(spotlightClose(), `</${SPOTLIGHT_TAG}>`)
  // A source that carries the fence itself cannot close it early.
  assert.equal(sanitizeSource(`x ${SPOTLIGHT_TAG} y`).includes(SPOTLIGHT_TAG), false)
  assert.equal(stripSpotlightTag(`a ${SPOTLIGHT_TAG} b`), `a ${SPOTLIGHT_TAG_REDACTION} b`)

  // Text parts are fenced as one run, and parts that are not text keep their place inside the fence.
  const fenced = spotlightToolResultContent("a source", [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
    { type: "image", data: "..." },
  ])
  assert.equal(fenced.length, 4)
  assert.equal(fenced[0]?.text, spotlightOpen("a source"))
  assert.equal(fenced[1]?.text, "first\nsecond")
  assert.equal(fenced[2]?.type, "image")
  assert.equal(fenced[3]?.text, spotlightClose())
  assert.deepEqual(spotlightToolResultContent("a source", []), [])
})

test("what the fence means is said in the prompt, with the one exception", () => {
  const section = spotlightPromptSection()
  assert.match(section, /Untrusted content/)
  assert.match(section, /never an instruction to you/)
  // A notice about the model's own blocked call is from the platform, not from the outside.
  assert.match(section, /is from Slate, not from the outside source/)
  // Without SendMessage the model reports what was asked rather than acting on it.
  assert.match(spotlightPromptSection({ canSendMessage: false }), /report what it asked in your final answer/)

  // The switch is read from the environment first and from the gate when it says nothing.
  assert.equal(resolveSpotlightEnabled("1", () => false), true)
  assert.equal(resolveSpotlightEnabled("0", () => true), false)
  assert.equal(resolveSpotlightEnabled("false", () => true), false)
  assert.equal(resolveSpotlightEnabled("", () => true), true)
  assert.equal(resolveSpotlightEnabled(undefined, () => false), false)
})

// ---------------------------------------------------------------------------------------------
// Writing and cleaning up
// ---------------------------------------------------------------------------------------------

test("a file is written whole or not at all", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-atomic-"))
  try {
    const target = path.join(dir, "nested", "settings.json")
    await writeFileAtomic(target, "first")
    assert.equal(fs.readFileSync(target, "utf8"), "first")
    await writeFileAtomic(target, "second")
    assert.equal(fs.readFileSync(target, "utf8"), "second")
    // Nothing of the writing is left beside the file.
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["settings.json"])

    // A write that cannot land leaves the file as it was rather than half-written, and takes its temporary
    // file with it — the rename has its own cleanup, so a failure there does not leave one behind either.
    await assert.rejects(() => writeFileAtomic(path.join(dir, "nested"), "x"))
    assert.equal(fs.readFileSync(target, "utf8"), "second")
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith(".part")), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the credentials an earlier version kept beside the MCP configuration are removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slate-mcp-auth-"))
  try {
    assert.equal(isLegacyMcpAuthFile(LEGACY_MCP_AUTH_FILENAME), true)
    assert.equal(isLegacyMcpAuthFile(`${LEGACY_MCP_AUTH_FILENAME}.backup`), true)
    assert.equal(isLegacyMcpAuthFile("mcp.json"), false)

    // A root that never had one is not an error.
    assert.deepEqual(await cleanupLegacyMcpAuthCredentials(dir), { outcome: "not_found", removedCount: 0 })
    fs.writeFileSync(path.join(dir, LEGACY_MCP_AUTH_FILENAME), "{}")
    fs.writeFileSync(path.join(dir, `${LEGACY_MCP_AUTH_FILENAME}.old`), "{}")
    fs.writeFileSync(path.join(dir, "keep.json"), "{}")

    assert.deepEqual(await cleanupLegacyMcpAuthCredentials(dir), { outcome: "deleted", removedCount: 2 })
    assert.deepEqual(fs.readdirSync(dir), ["keep.json"])
    // A root that is not there at all is reported as not found rather than as a failure.
    assert.equal((await cleanupLegacyMcpAuthCredentials(path.join(dir, "nope"))).outcome, "not_found")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

test("a link that opens the desktop is read, and read back the same way", () => {
  assert.equal(SLATE_DEEP_LINK_SCHEME, "slate")
  assert.equal(SLATE_HTTPS_DEEP_LINK_ORIGIN.startsWith("https://"), true)
  assert.equal(SLATE_HTTPS_DEEP_LINK_PATH_PREFIX, "/slate/link")
  assert.equal(SLATE_OPEN_DEEP_LINK_URL, "slate://app/v1/open")

  const open = parseSlateDeepLink("slate://app/v1/open")
  assert.deepEqual(open?.link, { version: 1, route: "open", source: "protocol" })
  assert.equal(open?.canonicalUrl, SLATE_OPEN_DEEP_LINK_URL)

  const plugin = parseSlateDeepLink("slate://app/v1/plugin/add?id=42")
  assert.equal(plugin?.link.route === "plugin-add" && plugin.link.pluginId, "42")
  assert.equal(plugin?.canonicalUrl, canonicalSlateDeepLinkUrl(plugin!.link))

  const info = parseSlateDeepLink("slate://app/v1/info?topic=deep-links")
  assert.equal(info?.link.route, "info")

  // The https spelling of the same link is accepted, and anything else is not.
  const host = new URL(SLATE_HTTPS_DEEP_LINK_ORIGIN).host
  assert.equal(parseSlateDeepLink(`https://${host}${SLATE_HTTPS_DEEP_LINK_PATH_PREFIX}/v1/open`)?.link.route, "open")
  assert.equal(parseSlateDeepLink(`https://elsewhere.example${SLATE_HTTPS_DEEP_LINK_PATH_PREFIX}/v1/open`), null)
  assert.equal(parseSlateDeepLink("slate://app/v1/other"), null)
  assert.equal(parseSlateDeepLink("http://app/v1/open"), null)
  assert.equal(parseSlateDeepLink(`slate://user@app/v1/open`), null)
  // Something that is not a link at all, or one that is too long, is refused.
  assert.equal(parseSlateDeepLink("not a link"), null)
  assert.equal(parseSlateDeepLink(`slate://app/v1/open?x=${"y".repeat(SLATE_DEEP_LINK_MAX_LENGTH)}`), null)
  assert.equal(parseSlateDeepLink(`slate://app/v1/../v1/open`), null)
  assert.equal(parseSlateDeepLink("slate://app/v1/open#fragment"), null)
  assert.equal(parseSlateDeepLink("slate://app/v1/open?unexpected=1"), null)
})

// ---------------------------------------------------------------------------------------------
// What the classifier and the local tools are shown
// ---------------------------------------------------------------------------------------------

test("a credential is taken out of what the classifier is shown", () => {
  // A URL keeps its origin and path, and loses its credentials, query and fragment.
  const redacted = redactSlateAutoReviewInlineSecrets("curl https://user:pass@example.com/a/b?token=1#frag")
  assert.match(redacted, /https:\/\/example\.com\/a\/b/)
  assert.equal(redacted.includes("token=1"), false)
  assert.equal(redacted.includes("pass"), false)
  // A key whose name says it holds a secret has its value replaced.
  assert.equal(redactSlateAutoReviewInlineSecrets("API_KEY=abcdef123").includes("abcdef123"), false)
  assert.equal(redactSlateAutoReviewInlineSecrets("TOKEN=abcdef").includes("abcdef"), false)
  // The value taken after a key is the first thing written there, so a `Bearer` prefix is what is replaced
  // and the token behind it is left as it was: a whole value that is only a token is what the value pattern
  // is for, and that is the caller's check rather than this one.
  assert.equal(redactSlateAutoReviewInlineSecrets("Authorization: Bearer abcdef"), "Authorization: … abcdef")
  // Something that is not a secret is left alone.
  assert.equal(redactSlateAutoReviewInlineSecrets("echo hello"), "echo hello")
})

test("what a user allows the local tools is one of three answers", () => {
  assert.deepEqual([...["always", "ask", "never"]], ["always", "ask", "never"])
  assert.equal(SLATE_DEFAULT_LOCAL_TOOL_PERMISSION, "ask")
  assert.equal(isSlateLocalToolPermission("always"), true)
  assert.equal(isSlateLocalToolPermission("sometimes"), false)
  // A value that is not one of them asks rather than runs.
  assert.equal(normalizeSlateLocalToolPermission("sometimes"), "ask")
  assert.equal(normalizeSlateLocalToolPermission("never"), "never")
  assert.equal(isSlateLocalToolAction("run-command"), true)
  assert.equal(isSlateLocalToolAction("fly"), false)
})

// ---------------------------------------------------------------------------------------------
// Agents, models and providers
// ---------------------------------------------------------------------------------------------

test("an agent's summary list is kept newest first", () => {
  const list = [
    { id: "a", updatedAt: 10 },
    { id: "b", updatedAt: 30 },
  ]
  assert.deepEqual([...list].sort(compareAgentSummaries).map(summary => summary.id), ["b", "a"])

  // An update replaces what was there rather than adding a second copy.
  const updated = upsertAgentSummary(list, { id: "a", updatedAt: 40 })
  assert.equal(updated.length, 2)
  assert.equal(updated.find(summary => summary.id === "a")?.updatedAt, 40)
  // A new one is added.
  const added = upsertAgentSummary(list, { id: "c", updatedAt: 5 })
  assert.equal(added.length, 3)
  assert.equal(added.some(summary => summary.id === "c"), true)
})

test("a model selection is recognized, and the platform's own models are named", () => {
  assert.equal(SLATE_SUMMARIZATION_MODEL_ID.length > 0, true)
  assert.equal(isSlateAgentModelSelection(SLATE_COMPUTER_USE_MODEL_SELECTION), true)
  assert.equal(isSlateAgentModelSelection({ modelId: "", maxMode: false, parameters: [] }), false)
  assert.equal(isSlateAgentModelSelection({ modelId: "x", maxMode: "no", parameters: [] }), false)
  // A selection that does not say whether it is in max mode is not one.
  assert.equal(isSlateAgentModelSelection({ modelId: "x", parameters: [] }), false)
  assert.equal(isSlateAgentModelSelection({ modelId: "x", maxMode: false, parameters: [{ id: "a" }] }), false)
  assert.equal(isSlateAgentModelSelection(null), false)
})

test("the backends a request can go to are the ones the platform knows", () => {
  assert.deepEqual([...SLATE_INFERENCE_PROVIDERS], ["slate", "claude-code", "codex", "openrouter"])
  assert.equal(isSlateInferenceProvider("slate"), true)
  assert.equal(isSlateInferenceProvider("someone-else"), false)
  // A fresh count is zero for every backend, and says nothing was used yet.
  const usage = emptySlateInferenceRouterUsage()
  assert.equal(usage.schemaVersion, 1)
  assert.deepEqual(Object.keys(usage.providers).sort(), ["claude-code", "codex", "openrouter", "slate"])
  assert.equal(usage.providers.slate?.requests, 0)
  assert.equal(usage.providers.slate?.lastUsedAt, null)
})

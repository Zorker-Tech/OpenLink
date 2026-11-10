import { test } from "node:test"
import assert from "node:assert/strict"

import {
  ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX,
  CLIENT_PERSISTENCE_MAX_VALUE_BYTES,
  clientPersistenceFileNameFor,
  decodeClientPersistenceFileName,
  encodeClientPersistenceFileName,
} from "../../source/shared/client-persistence-store.ts"
import { discoveryBelongsToProcessWindow, processCommandHasExpectedIdentity, LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX, LOCAL_EXEC_IDENTITY_ENV_KEY, processIdentitiesMatch } from "../../source/shared/local-exec-process-identity.ts"
import { SLATE_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE } from "../../source/shared/local-tool-permission-machinery.ts"
import { decodeMcpAccountLabelArgument, encodeMcpAccountLabelForListing, normalizeMcpAccountLabel, DEFAULT_MCP_ACCOUNT_KEY } from "../../source/shared/mcp.ts"
import { connectorsPreviewText, sendMessagePreviewText, SLATE_AGENT_FALLBACK_PREVIEW, slateAgentPreviewText } from "../../source/shared/send-message-preview.ts"
import { SUPPORTED_DASHBOARD_ACTIONS } from "../../source/shared/usage.ts"

// ---------------------------------------------------------------------------------------------
// The storage a client keeps its own state in
// ---------------------------------------------------------------------------------------------

test("a client's stored keys are the ones the platform owns", () => {
  assert.equal(ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX, "slate.")
  assert.equal(CLIENT_PERSISTENCE_MAX_VALUE_BYTES, 8 * 1024 * 1024)
  // A key of the platform's own becomes a file name, and the file name reads back as the key.
  const key = `${ALLOWED_CLIENT_PERSISTENCE_KEY_PREFIX}draft-inputs`
  const fileName = encodeClientPersistenceFileName(key)
  assert.equal(fileName.includes("/"), false)
  assert.equal(decodeClientPersistenceFileName(fileName), key)
  assert.equal(clientPersistenceFileNameFor(key), fileName)
  // A key the platform does not own is not filed at all.
  assert.equal(clientPersistenceFileNameFor("someone-elses-key"), null)
  assert.equal(decodeClientPersistenceFileName("not-a-name-of-ours"), null)
})

// ---------------------------------------------------------------------------------------------
// One local-exec process from another
// ---------------------------------------------------------------------------------------------

test("a process is the one that was expected only when its generation matches", () => {
  assert.equal(LOCAL_EXEC_IDENTITY_ENV_KEY, "SLATE_LOCAL_EXEC_GENERATION_TOKEN")
  assert.equal(LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX, "--slate-local-exec-generation=")
  const identity = { pid: 42, startEpochMs: 1_000, command: "node daemon.js", entryRealpath: "/opt/daemon.js", generationToken: "gen-1" }
  assert.equal(processIdentitiesMatch(identity, { ...identity }), true)
  // A process that was replaced, and one that merely looks like it, are not the same process.
  assert.equal(processIdentitiesMatch(identity, { ...identity, generationToken: "gen-2" }), false)
  assert.equal(processIdentitiesMatch(identity, { ...identity, pid: 43 }), false)
  assert.equal(processIdentitiesMatch(identity, { ...identity, startEpochMs: 2_000 }), false)

  // A command carries the generation only when both the entry point and the token are exact arguments.
  const command = `node ${identity.entryRealpath} ${LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX}${identity.generationToken}`
  assert.equal(processCommandHasExpectedIdentity(command, identity.entryRealpath, identity.generationToken), true)
  assert.equal(processCommandHasExpectedIdentity(command, identity.entryRealpath, "gen-2"), false)
  assert.equal(processCommandHasExpectedIdentity(`node other.js`, identity.entryRealpath, identity.generationToken), false)
  const punctuationPath = "/opt/app.(prod)/daemon.js"
  assert.equal(processCommandHasExpectedIdentity(`node ${punctuationPath} ${LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX}gen-3`, punctuationPath, "gen-3"), true)
  assert.equal(processCommandHasExpectedIdentity(`node prefix${punctuationPath}suffix ${LOCAL_EXEC_IDENTITY_ARGUMENT_PREFIX}gen-3`, punctuationPath, "gen-3"), false)
})

test("daemon discovery timestamps stay inside the publication window", () => {
  assert.equal(discoveryBelongsToProcessWindow(100, 100, 100), true)
  assert.equal(discoveryBelongsToProcessWindow(99, 100, 200), false)
  assert.equal(discoveryBelongsToProcessWindow(60_101, 100, 60_200), false)
  assert.equal(discoveryBelongsToProcessWindow(101, 100, 100), false)
  assert.equal(discoveryBelongsToProcessWindow(Number.NaN, 100, 200), false)
})

// ---------------------------------------------------------------------------------------------
// What the user is asked and told
// ---------------------------------------------------------------------------------------------

test("a request that cannot be described is not run rather than asked about vaguely", () => {
  assert.match(SLATE_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE, /Slate could not describe that request/)
  assert.match(SLATE_LOCAL_TOOLS_UNDESCRIBABLE_MESSAGE, /Use your own computer instead/)
})

test("a message is previewed by what sent it and what it says", () => {
  assert.equal(slateAgentPreviewText("a task"), "Slate agent: a task")
  assert.equal(slateAgentPreviewText(undefined), SLATE_AGENT_FALLBACK_PREVIEW)
  assert.equal(slateAgentPreviewText("  "), SLATE_AGENT_FALLBACK_PREVIEW)
  assert.equal(connectorsPreviewText(["github", "slack"]).length > 0, true)

  assert.equal(sendMessagePreviewText({ type: "text", content: "hello there" }), "hello there")
  assert.equal(sendMessagePreviewText({ type: "slate-agent", title: "a task" }), "Slate agent: a task")
  assert.equal(sendMessagePreviewText({ type: "slate-agent" }), SLATE_AGENT_FALLBACK_PREVIEW)
  assert.equal(sendMessagePreviewText({ type: "attachment", url: "https://example.com/a.png" }).length > 0, true)
})

test("a server's account label is shown as it is and passed in a form that survives", () => {
  assert.equal(DEFAULT_MCP_ACCOUNT_KEY, "default")
  assert.equal(normalizeMcpAccountLabel("  Work  "), "work")
  // A label with characters that a listing cannot carry is encoded, and decoded back to the same label.
  const hostile = "my:account (work)";
  const encoded = encodeMcpAccountLabelForListing(hostile)
  // What a listing cannot carry is replaced, and what the user typed is recovered from the argument.
  assert.notEqual(encoded, hostile)
  assert.equal(decodeMcpAccountLabelArgument(encoded), hostile)
  // A listing quotes the label, so a label with spaces in it survives the listing as one argument.
  assert.equal(encodeMcpAccountLabelForListing("work"), '"work"')
  assert.equal(decodeMcpAccountLabelArgument('"work"'), "work")
  assert.equal(decodeMcpAccountLabelArgument('"my account"'), "my account")
})

test("the dashboard actions a caller may ask for are the ones the platform supports", () => {
  assert.deepEqual([...SUPPORTED_DASHBOARD_ACTIONS], ["requestLimitIncrease"])
})

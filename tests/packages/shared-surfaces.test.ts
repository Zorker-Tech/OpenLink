import { test } from "node:test"
import assert from "node:assert/strict"

import { isManagedSubagentConversationId } from "../../source/shared/agents/subagents.ts"
import { CONNECT_CODE_RESOURCE_EXHAUSTED, getConnectRetryAfterMs, isDeadlineExceededConnectError, isInvalidArgumentConnectError, isRateLimitConnectError, isTransientConnectError } from "../../source/adapters/interop/connect/connect-error-adapter.ts"
import { isMessageAddress } from "../../source/shared/message-reference.ts"
import { isMcpServerId, parseInt32McpServerId, validateMcpServerId } from "../../source/shared/node/mcp/mcp-server-id.ts"
import { EXTENSION_FROM_IMAGE_MIME, IMAGE_MIME_FROM_EXTENSION, extensionOf } from "../../source/shared/media/media-extensions.ts"
import { pinExperimentsDiagnosticsReporter, PRE_PIN_BUFFER_CAP, reportExperimentsDiagnostic } from "../../source/shared/node/experiments/experiments-diagnostics.ts"
import { findMissingRequiredCatalogFields, humanizeVariableName, pluginVariablesSchemaToFields } from "../../source/shared/node/mcp/mcp-plugin-variables.ts"
import { isSlateClientPersistenceSlice, SLATE_CLIENT_PERSISTENCE_SLICES } from "../../source/shared/observability/telemetry.ts"
import { isSlateUpdateTrack } from "../../source/shared/update.ts"
import { DEFAULT_SLATE_BOX_RUNTIME, isBoxRuntime } from "../../source/shared/box-runtime.ts"
import { buildSlatePluginDeepLink, DEFAULT_SLATE_THEME_PREFERENCE, isSlateDeepLinkPluginId, isSlateThemePreference } from "../../source/shared/desktop.ts"
import { attachmentExtension } from "../../source/shared/media/attachment-open-policy.ts"
import { transcriptReplicaKey, ORDERED_REPLICAS_V1, ROSTER_REPLICA_KEY } from "../../source/shared/ordering.ts"
import { CLIENT_PERSISTENCE_CHANNELS } from "../../source/shared/persistence.ts"
import { IDLE_TEACH_RECORDING_STATUS, SLATE_TEACH_MAX_DURATION_MS } from "../../source/shared/agents/teach-recording.ts"
import { getSlateVariant, isSlatePackaged } from "../../source/shared/node/slate-variant.ts"
import { isValidAttachmentUrl } from "../../source/shared/transport-types.ts"
import { SLATE_GATEWAY } from "../../source/shared/gateway-wire.ts"
import { installInvariantReporter, invariantMessagesStripped, SlateInvariantViolation } from "../../source/shared/invariant.ts"
import { buildSlateRequestLineageHeaders, sanitizeHeaderValue } from "../../source/shared/observability/request-lineage.ts"
import { slateWebauthnProxyMirroredEnablement, slateWebauthnSignerShips } from "../../source/shared/webauthn-proxy-availability.ts"
import { buildNotificationContent, diffAgentNotificationTransitions, shouldNotify, SlateOsNotificationDecider, toNotificationSnapshot } from "../../source/shared/os-notification.ts"
import { LOCAL_EXEC_DAEMON_CONNECTION_FILENAME, SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS } from "../../source/shared/local-exec-daemon.ts"

// ---------------------------------------------------------------------------------------------
// What a failed connection means
// ---------------------------------------------------------------------------------------------

test("a failure is classified by what the caller should do about it", () => {
  const busy = { code: CONNECT_CODE_RESOURCE_EXHAUSTED, metadata: { get: () => "120" } }
  assert.equal(isRateLimitConnectError(busy), true)
  assert.equal(isTransientConnectError(busy), true)
  assert.equal(isInvalidArgumentConnectError({ code: 3 }), true)
  assert.equal(isDeadlineExceededConnectError({ code: 4 }), true)
  // Something that is not a connection failure at all is none of these.
  assert.equal(isRateLimitConnectError(new Error("nope")), false)
  assert.equal(isTransientConnectError({ code: 99 }), false)

  // What the service said about coming back is read from the failure's own metadata.
  assert.equal(getConnectRetryAfterMs(busy, 0), 120_000)
  assert.equal(getConnectRetryAfterMs({ code: 8 }, 0), undefined)
  assert.equal(getConnectRetryAfterMs(new Error("nope"), 0), undefined)
})

test("a message address is recognized as one of the forms a surface spells", () => {
  // A turn's message, optionally an assistant message of it, and a message by index or by name.
  assert.equal(isMessageAddress("t1u"), true)
  assert.equal(isMessageAddress("t12ua4"), true)
  assert.equal(isMessageAddress("t1s1"), true)
  assert.equal(isMessageAddress("t1a1"), true)
  assert.equal(isMessageAddress("tbs1"), true)
  // A bare index is not an address, and neither is a form the surface never writes.
  assert.equal(isMessageAddress("t1"), false)
  assert.equal(isMessageAddress("t12u3a4"), false)
  assert.equal(isMessageAddress("t3b2s1"), false)
  assert.equal(isMessageAddress("message-1"), false)
  assert.equal(isMessageAddress(""), false)
})

test("a server's id is a positive decimal that fits where it is held", () => {
  assert.equal(isMcpServerId(" 12 "), true)
  assert.equal(isMcpServerId("0"), false)
  assert.equal(isMcpServerId("-1"), false)
  assert.equal(isMcpServerId("1.5"), false)
  assert.equal(validateMcpServerId(" 42 "), "42")
  assert.throws(() => validateMcpServerId("nope"), /must be a positive decimal string/)
  assert.equal(parseInt32McpServerId("42"), 42)
  assert.throws(() => parseInt32McpServerId("2147483648"), /outside the supported range/)
})

// ---------------------------------------------------------------------------------------------
// Names, extensions and forms
// ---------------------------------------------------------------------------------------------

test("an extension is read from a name, and the media types go both ways for images", () => {
  assert.equal(extensionOf("photo.PNG"), ".png")
  assert.equal(extensionOf("/a/b/photo.jpeg"), ".jpeg")
  assert.equal(extensionOf("C:\\a\\b\\photo.gif"), ".gif")
  assert.equal(extensionOf("no-extension"), "")
  assert.equal(extensionOf(".hidden"), "")

  for (const [extension, mime] of Object.entries(IMAGE_MIME_FROM_EXTENSION)) {
    if (mime === "image/x-icon") continue
    assert.equal(EXTENSION_FROM_IMAGE_MIME[mime] !== undefined, true, mime)
    assert.equal(extension, extensionOf(`file${extension}`))
  }
})

test("an attachment is opened only by the extension its name ends with", () => {
  assert.equal(attachmentExtension("/a/b/photo.PNG"), "png")
  assert.equal(attachmentExtension("photo"), null)
  assert.equal(attachmentExtension("photo."), null)
  assert.equal(attachmentExtension(".hidden"), null)
})

test("a plugin's variables become the form a user fills in", () => {
  assert.equal(humanizeVariableName("api_url"), "API URL")
  assert.equal(humanizeVariableName("my_token"), "My Token")

  const fields = pluginVariablesSchemaToFields({
    type: "object",
    required: ["API_URL"],
    properties: {
      API_URL: { type: "string", title: "The API", description: "Where the API is" },
      ACCESS_TOKEN: { type: "string", default: "abc" },
      PLAIN: { type: "string", writeOnly: true },
    },
  })
  assert.deepEqual(fields.map(field => field.key), ["API_URL", "ACCESS_TOKEN", "PLAIN"])
  assert.equal(fields[0]?.label, "The API")
  assert.equal(fields[0]?.hint, "Where the API is")
  assert.equal(fields[0]?.isRequired, true)
  assert.equal(fields[0]?.isSecret, false)
  // A name that says it holds a secret is treated as one, and a default is carried over.
  assert.equal(fields[1]?.isSecret, true)
  assert.equal(fields[1]?.defaultValue, "abc")
  assert.equal(fields[2]?.isSecret, true)

  // A schema that is not an object of properties has no fields to ask for.
  assert.deepEqual(pluginVariablesSchemaToFields(null), [])
  assert.deepEqual(pluginVariablesSchemaToFields({ type: "object" }), [])

  // What is still missing is the required fields that are empty and have no default.
  assert.deepEqual(findMissingRequiredCatalogFields(fields, {}).map(field => field.key), ["API_URL"])
  assert.deepEqual(findMissingRequiredCatalogFields(fields, { API_URL: "https://api" }), [])
})

test("a variable's name is read as words, and its schema decides what the form asks for", () => {
  assert.equal(humanizeVariableName(""), "")
  assert.equal(humanizeVariableName("_"), "")
  assert.equal(humanizeVariableName("my__var"), "My Var", "an empty word between underscores is not a word")
  assert.equal(humanizeVariableName("apiKey"), "Apikey", "only underscores split words")
  assert.equal(humanizeVariableName("myVar"), "Myvar", "the rest of a word is folded to lower case")
  assert.equal(humanizeVariableName("url"), "URL")
  assert.equal(humanizeVariableName("URL"), "URL")
  assert.equal(humanizeVariableName("x_y_z"), "X Y Z")

  const fields = pluginVariablesSchemaToFields({
    properties: {
      password_field: { format: "password" },
      write_only: { writeOnly: true },
      not_quite: { writeOnly: 1 },
      MY_TOKEN: {},
      myToken: {},
      plain: { title: "", description: "", default: "" },
      padded: { title: "  T  ", description: "  D  " },
      empty: [],
    },
    required: [1, "plain", null],
  })
  assert.deepEqual(fields.map(field => [field.key, field.isSecret, field.isRequired]), [
    ["password_field", true, false],
    ["write_only", true, false],
    ["not_quite", false, false],
    ["MY_TOKEN", true, false],
    ["myToken", false, false],
    ["plain", false, true],
    ["padded", false, false],
    ["empty", false, false],
  ], "the schema's order is kept, and only the boolean true is write-only")
  assert.equal(fields[6]?.label, "  T  ", "a title is used as it came")
  assert.equal(fields[6]?.hint, "  D  ", "a description is used as it came")
  assert.equal(fields[5]?.label, "", "an empty title is a title, not a missing one")
  assert.equal(fields[6]?.defaultValue, undefined, "a property without a default has none")
  assert.equal(fields[5]?.hint, "", "an empty description is a hint, not a missing one")
  assert.equal(fields[5]?.defaultValue, "", "an empty default is still a default")
  assert.deepEqual(pluginVariablesSchemaToFields({ properties: "x" }), [])
  assert.deepEqual(pluginVariablesSchemaToFields({ properties: { a: "text" } }).map(field => field.key), ["a"])

  const required = [
    { key: "a", label: "A", placeholder: "a", isRequired: true, isSecret: false },
    { key: "b", label: "B", placeholder: "b", isRequired: true, isSecret: false, defaultValue: "  " },
    { key: "c", label: "C", placeholder: "c", isRequired: true, isSecret: false, defaultValue: "d" },
    { key: "d", label: "D", placeholder: "d", isRequired: false, isSecret: false },
  ]
  assert.deepEqual(findMissingRequiredCatalogFields(required, {}).map(field => field.key), ["a", "b"], "a blank default is no default")
  assert.deepEqual(findMissingRequiredCatalogFields(required, { a: "  " }).map(field => field.key), ["a", "b"], "a blank entry is no entry")
  assert.deepEqual(findMissingRequiredCatalogFields(required, { a: "x" }).map(field => field.key), ["b"])
})

test("the names the platform's own reports use are a fixed set", () => {
  assert.equal(isSlateClientPersistenceSlice("send-journal"), true)
  assert.equal(isSlateClientPersistenceSlice("something-else"), false)
  assert.equal(SLATE_CLIENT_PERSISTENCE_SLICES.includes("other"), true)
  assert.equal(isSlateUpdateTrack("nightly"), true)
  assert.equal(isSlateUpdateTrack("beta"), false)
  assert.equal(DEFAULT_SLATE_BOX_RUNTIME, "remote")
  assert.equal(isBoxRuntime("local-docker"), true)
  assert.equal(isBoxRuntime("somewhere"), false)
  assert.equal(DEFAULT_SLATE_THEME_PREFERENCE, "system")
  assert.equal(isSlateThemePreference("dark"), true)
  assert.equal(isSlateThemePreference("solarized"), false)
})

test("a plugin is opened through the desktop's own link, with an id that is an id", () => {
  assert.equal(isSlateDeepLinkPluginId("12345"), true)
  assert.equal(isSlateDeepLinkPluginId("12a"), false)
  assert.equal(buildSlatePluginDeepLink("42"), "slate://app/v1/plugin/add?id=42")
  assert.equal(buildSlatePluginDeepLink("4 2").includes("4%202"), true)
})

test("an attachment is read from a file or an https address", () => {
  assert.equal(isValidAttachmentUrl("file:///tmp/a.png"), true)
  assert.equal(isValidAttachmentUrl("https://example.com/a.png"), true)
  assert.equal(isValidAttachmentUrl("http://example.com/a.png"), false)
  assert.equal(isValidAttachmentUrl("not a url"), false)
})

test("which build this is follows the environment it was started in", () => {
  const savedPackaged = process.env.SLATE_PACKAGED
  const savedLab = process.env.SLATE_LAB
  try {
    delete process.env.SLATE_PACKAGED
    delete process.env.SLATE_LAB
    assert.equal(isSlatePackaged(), false)
    assert.equal(getSlateVariant(), "slate-dev")
    process.env.SLATE_PACKAGED = "1"
    assert.equal(getSlateVariant(), "slate")
    process.env.SLATE_LAB = "1"
    assert.equal(getSlateVariant(), "slate-lab")
  } finally {
    if (savedPackaged === undefined) delete process.env.SLATE_PACKAGED
    else process.env.SLATE_PACKAGED = savedPackaged
    if (savedLab === undefined) delete process.env.SLATE_LAB
    else process.env.SLATE_LAB = savedLab
  }
})

test("the constants the client and the host agree on are the ones they promise", () => {
  assert.equal(isManagedSubagentConversationId("slate-subagent-1"), true)
  assert.equal(isManagedSubagentConversationId("agent-1"), false)
  assert.equal(isManagedSubagentConversationId("prefix-slate-subagent-1"), false)
  assert.equal(ROSTER_REPLICA_KEY, "roster")
  assert.equal(transcriptReplicaKey("agent-1"), "transcript:agent-1")
  assert.equal(ORDERED_REPLICAS_V1, "orderedReplicasV1")
  assert.deepEqual(CLIENT_PERSISTENCE_CHANNELS, {
    read: "slate:client-persistence-read",
    write: "slate:client-persistence-write",
    remove: "slate:client-persistence-remove",
    listKeys: "slate:client-persistence-list-keys",
    migrate: "slate:client-persistence-migrate",
  })
  assert.equal(SLATE_TEACH_MAX_DURATION_MS, 10 * 60 * 1_000)
  assert.equal(IDLE_TEACH_RECORDING_STATUS.state, "idle")
  assert.equal(IDLE_TEACH_RECORDING_STATUS.maxDurationMs, SLATE_TEACH_MAX_DURATION_MS)
  assert.equal(SLATE_GATEWAY.paths.api, "/api")
  assert.equal(SLATE_GATEWAY.authentication.scheme, "Bearer")
  assert.equal(SLATE_GATEWAY.headers.slimAvatars.startsWith("x-slate-"), true)
  assert.equal(LOCAL_EXEC_DAEMON_CONNECTION_FILENAME.endsWith(".json"), true)
  assert.equal(SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS, 90_000)
})

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

test("a diagnostic reported before anyone listens is kept until someone does", () => {
  const received: string[] = []
  // Nothing is listening yet, so the diagnostic is buffered.
  reportExperimentsDiagnostic({ kind: "first" })
  // Nothing was handed over, since nobody was listening yet.
  assert.equal(received.length, 0)
  // A reporter is pinned and handed what was buffered, and everything after it goes straight through.
  pinExperimentsDiagnosticsReporter(diagnostic => received.push(String(diagnostic.kind)))
  assert.deepEqual(received, ["first"])
  reportExperimentsDiagnostic({ kind: "second" })
  assert.deepEqual(received, ["first", "second"])
  // A reporter that is taken away leaves the diagnostics to be dropped rather than buffered again.
  pinExperimentsDiagnosticsReporter(null)
  reportExperimentsDiagnostic({ kind: "third" })
  assert.deepEqual(received, ["first", "second"])
})

test("the buffer before a reporter is pinned is bounded, and pinning a reporter clears it", () => {
  assert.equal(PRE_PIN_BUFFER_CAP, 64)
  const received: Array<[string, number | undefined]> = []
  // Pinning nothing throws away whatever was waiting rather than keeping it for the next reporter.
  reportExperimentsDiagnostic({ kind: "dropped", n: 1 })
  reportExperimentsDiagnostic({ kind: "dropped", n: 2 })
  pinExperimentsDiagnosticsReporter(null)
  reportExperimentsDiagnostic({ kind: "kept", n: 3 })
  pinExperimentsDiagnosticsReporter(diagnostic => received.push([String(diagnostic.kind), typeof diagnostic.n === "number" ? diagnostic.n : undefined]))
  assert.deepEqual(received, [["kept", 3]])
  pinExperimentsDiagnosticsReporter(null)

  // A full buffer drops what comes after it, and hands over what it kept, oldest first.
  for (let index = 0; index < PRE_PIN_BUFFER_CAP + 5; index += 1) reportExperimentsDiagnostic({ kind: "k" + index, n: index })
  const capped: number[] = []
  pinExperimentsDiagnosticsReporter(diagnostic => capped.push(diagnostic.n as number))
  assert.equal(capped.length, PRE_PIN_BUFFER_CAP, "the extra diagnostics are dropped, not kept")
  assert.deepEqual(capped.slice(0, 3), [0, 1, 2], "the oldest diagnostics are handed over first")
  assert.equal(capped.at(-1), PRE_PIN_BUFFER_CAP - 1)
  pinExperimentsDiagnosticsReporter(null)

  // A reporter that fails while it is being handed the backlog fails the pin.
  reportExperimentsDiagnostic({ kind: "throws" })
  assert.throws(() => pinExperimentsDiagnosticsReporter(() => { throw new Error("reporter is broken") }), /reporter is broken/)
  pinExperimentsDiagnosticsReporter(null)
})

test("an invariant violation is reported, and its message is not carried in a packaged build", () => {
  assert.equal(invariantMessagesStripped(), true)
  const violation = new SlateInvariantViolation("something impossible")
  assert.equal(violation.name, "SlateInvariantViolation")

  const reports: Array<{ name: string; frame: string | null }> = []
  const uninstall = installInvariantReporter(report => reports.push(report))
  // Installing a reporter twice is itself a violation, so the second installation is refused.
  // The refusal is itself an invariant violation, and in a packaged build its message is stripped.
  assert.throws(() => installInvariantReporter(() => {}), (error: Error) => error.name === "SlateInvariantViolation")
  uninstall()
  // After it is taken away the reporter is gone, and installing again is allowed.
  const second = installInvariantReporter(() => {})
  second()
})

test("the headers that say where a request came from are safe to send", () => {
  assert.equal(sanitizeHeaderValue("a\r\nb"), "ab")
  assert.deepEqual(buildSlateRequestLineageHeaders(undefined), {})
  assert.deepEqual(
    buildSlateRequestLineageHeaders({ parentRequestId: "p1", rootParentRequestId: "r1" }),
    { "x-parent-request-id": "p1", "x-root-parent-request-id": "r1" },
  )
  assert.deepEqual(
    buildSlateRequestLineageHeaders({ parentRequestId: "p1", rootParentRequestId: "r1", parentAgentToolCallId: "c1" }),
    { "x-parent-request-id": "p1", "x-root-parent-request-id": "r1", "x-parent-agent-tool-call-id": "c1" },
  )
})

test("a lineage header is stripped of line breaks, and only the tool call is optional", () => {
  assert.equal(sanitizeHeaderValue("a\rb"), "ab")
  assert.equal(sanitizeHeaderValue("a\r\nb\n"), "ab", "every line break goes, not just the first")
  assert.equal(sanitizeHeaderValue("a\tb"), "a\tb", "a tab is not a line break")
  assert.equal(sanitizeHeaderValue("a\u2028b"), "a\u2028b", "the line separator is not a carriage return or a newline")

  assert.deepEqual(buildSlateRequestLineageHeaders(null), {})
  assert.deepEqual(buildSlateRequestLineageHeaders(undefined), {})
  assert.deepEqual(Object.keys(buildSlateRequestLineageHeaders({ parentRequestId: "p", rootParentRequestId: "r" })), ["x-parent-request-id", "x-root-parent-request-id"])

  assert.deepEqual(
    buildSlateRequestLineageHeaders({ parentRequestId: "p1", rootParentRequestId: "r1", parentAgentToolCallId: "" }),
    { "x-parent-request-id": "p1", "x-root-parent-request-id": "r1", "x-parent-agent-tool-call-id": "" },
    "an empty tool call id is still a value",
  )
  assert.deepEqual(
    buildSlateRequestLineageHeaders({ parentRequestId: "p1", rootParentRequestId: "r1", parentAgentToolCallId: null as never }),
    { "x-parent-request-id": "p1", "x-root-parent-request-id": "r1" },
    "only undefined or null leaves the tool call header out",
  )
  assert.deepEqual(
    buildSlateRequestLineageHeaders({ parentRequestId: "p\r\n1", rootParentRequestId: "r\n1", parentAgentToolCallId: "c\r1" }),
    { "x-parent-request-id": "p1", "x-root-parent-request-id": "r1", "x-parent-agent-tool-call-id": "c1" },
    "every header value is sanitized",
  )
})

test("the WebAuthn proxy is only mirrored where the signer ships", () => {
  assert.equal(slateWebauthnSignerShips("darwin"), true)
  assert.equal(slateWebauthnSignerShips("win32"), true)
  assert.equal(slateWebauthnSignerShips("linux"), false)
  assert.equal(slateWebauthnProxyMirroredEnablement(true, "darwin"), true)
  assert.equal(slateWebauthnProxyMirroredEnablement(true, "linux"), false)
})

// ---------------------------------------------------------------------------------------------
// When the operating system is told an agent needs the user
// ---------------------------------------------------------------------------------------------

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    name: "The agent",
    isRunning: true,
    awaitingReason: null as string | null,
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    lastMessagePreview: null as string | null,
    ...overrides,
  }
}

test("an agent that starts waiting, or finishes a turn, is a transition", () => {
  const previous = new Map([["agent-1", snapshot()]])
  const waiting = diffAgentNotificationTransitions(previous, [snapshot({ awaitingReason: "a question" })])
  assert.deepEqual(waiting.map(item => item.kind), ["agent-needs-input"])
  assert.equal(waiting[0]?.reason, "a question")

  const done = diffAgentNotificationTransitions(previous, [snapshot({ isRunning: false, lastMessagePreview: "done" })])
  assert.deepEqual(done.map(item => item.kind), ["agent-done"])

  // Nothing changed, so nothing is said; an agent nobody had seen before is not a transition either.
  assert.deepEqual(diffAgentNotificationTransitions(previous, [snapshot()]), [])
  assert.deepEqual(diffAgentNotificationTransitions(new Map(), [snapshot({ awaitingReason: "x" })]), [])
})

test("a notification is sent only when it is worth sending", () => {
  const base = { isHidden: false, notifyEnabled: true, isWindowFocused: false, lastNotifiedAtMs: null, nowMs: 10_000, throttleWindowMs: 5_000 }
  assert.equal(shouldNotify(base), true)
  assert.equal(shouldNotify({ ...base, isWindowFocused: true }), false)
  assert.equal(shouldNotify({ ...base, isHidden: true }), false)
  assert.equal(shouldNotify({ ...base, notifyEnabled: false }), false)
  // The same agent cannot notify twice inside the window.
  assert.equal(shouldNotify({ ...base, lastNotifiedAtMs: 6_000 }), false)
  assert.equal(shouldNotify({ ...base, lastNotifiedAtMs: 4_000 }), true)
})

test("what is sent says which agent it is and what happened", () => {
  const waiting = buildNotificationContent({
    agentId: "a", agentName: "The agent", kind: "agent-needs-input", reason: "It needs a decision",
    notifyEnabled: true, isHiddenFromSidebar: false, lastMessagePreview: null,
  })
  assert.equal(waiting.title, "The agent needs you")
  assert.equal(waiting.body, "It needs a decision")

  const done = buildNotificationContent({
    agentId: "a", agentName: "The agent", kind: "agent-done", reason: null,
    notifyEnabled: true, isHiddenFromSidebar: false, lastMessagePreview: "I changed the file",
  })
  assert.equal(done.title, "The agent")
  assert.equal(done.body, "I changed the file")

  // A body is cut to what a notification holds, and an agent that never said its name is still named.
  const long = buildNotificationContent({
    agentId: "a", agentName: "", kind: "agent-done", reason: null,
    notifyEnabled: true, isHiddenFromSidebar: false, lastMessagePreview: "x".repeat(400),
  })
  assert.equal(long.title, "Your agent")
  assert.equal(long.body.length <= 140, true)
  assert.equal(long.body.endsWith("…"), true)
})

test("the decider reports each transition once, and not again", () => {
  const decider = new SlateOsNotificationDecider(5_000)
  const running = toNotificationSnapshot({ id: "a", name: "A", isRunning: true, awaitingUserResponse: null, notifyOnUpdatesEnabled: true })
  assert.deepEqual(decider.decide({ agents: [running], isWindowFocused: false, nowMs: 0 }), [])

  // Finishing a turn is reported, with the message it ended on.
  const finished = toNotificationSnapshot({ id: "a", name: "A", isRunning: false, awaitingUserResponse: null, notifyOnUpdatesEnabled: true, lastMessageId: "m1", lastMessagePreview: "done" })
  assert.deepEqual(decider.decide({ agents: [finished], isWindowFocused: false, nowMs: 10_000 }).map(item => item.kind), ["agent-done"])
  // The same finished turn is not news twice.
  assert.deepEqual(decider.decide({ agents: [finished], isWindowFocused: false, nowMs: 20_000 }), [])

  // A window the user is looking at is not notified, and neither is an agent the user muted.
  const waiting = toNotificationSnapshot({ id: "b", name: "B", isRunning: true, awaitingUserResponse: { reason: "a question" }, notifyOnUpdatesEnabled: false })
  decider.decide({ agents: [running], isWindowFocused: false, nowMs: 0 })
  assert.deepEqual(decider.decide({ agents: [waiting], isWindowFocused: true, nowMs: 30_000 }), [])
  assert.deepEqual(decider.decide({ agents: [waiting], isWindowFocused: false, nowMs: 40_000 }), [])

  // An agent that is forgotten starts over rather than being remembered as already notified.
  decider.forget("a")
  assert.deepEqual(decider.decide({ agents: [finished], isWindowFocused: false, nowMs: 50_000 }), [])
})

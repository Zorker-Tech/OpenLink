import { test } from "node:test"
import assert from "node:assert/strict"

import { ENV_NAME_PATTERN } from "../../source/shared/env-file.ts"
import {
  SLATE_FEEDBACK_ACCOUNT_SLOT_MAX_CHARS,
  SLATE_FEEDBACK_CONVERSATION_ID_MAX_CHARS,
  SLATE_FEEDBACK_MESSAGE_MAX_CHARS,
  SLATE_FEEDBACK_SENTRY_EVENT_ID_MAX_COUNT,
  SLATE_FEEDBACK_SENTRY_EVENT_ID_PATTERN,
} from "../../source/shared/feedback.ts"
import { SLATE_DISABLED_NOTIFICATION_CONFIG } from "../../source/shared/host-settings.ts"
import { SlateMcpConfigError } from "../../source/shared/node/mcp/mcp-config-error.ts"
import { DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES } from "../../source/shared/observability/structured-log-spill.ts"
import { parseRetryAfterHeaderMs } from "../../source/shared/retry-after.ts"
import { VNC_VIEWER_VISIBLE_CHANNEL } from "../../source/shared/vnc-viewer-visibility.ts"
import { SKILL_PUBLISH_REFUSAL_PREFIX, SlateSkillPublishError, SLATE_SKILL_PUBLISH_REFUSED, WORKFLOW_REFERENCE_NODE_TYPE } from "../../source/shared/workflows.ts"
import { WriteEpoch } from "../../source/shared/write-epoch.ts"
import { SLATE_PRODUCT_DISPLAY_NAME, SLATE_PRODUCT_HTTP_TOKEN } from "../../source/shared/product-name.ts"
import { isKnownPluginLogoUrl, rememberPluginLogoUrl } from "../../source/shared/node/marketplace/cursor-marketplace-logo-registry.ts"
import { mergeUnresolvedAccountServers } from "../../source/shared/node/mcp/account-display-cache.ts"
import { CATALOG_CACHE_TTL_MS, isLoopbackHostname, validateAuthorizationUrl } from "../../source/shared/node/mcp/mcp-catalog-cache.ts"
import { PrivacyMode, slateSentryPrivacyTierForMode } from "../../source/shared/observability/sentry-privacy-mode.ts"
import { DISABLE_SEND_ACCEPT_RETURN_ENV, HOST_ACCOUNT_SLOT, NONCE_DIGEST_MISMATCH } from "../../source/shared/send-acceptance.ts"
import { buildBoxSecretsEnv, validateBoxSecretKey, validateBoxSecrets } from "../../source/shared/box-secrets.ts"
import { AUTH_WATCH_POLL_INTERVAL_MS, AUTH_WATCH_POLL_TIMEOUT_MS, AUTH_WATCH_TIMEOUT_MS, authWatchKey } from "../../source/shared/node/mcp/mcp-auth-watch.ts"
import { isSlateAccessBlockReason, SLATE_ACCESS_BLOCK_REASONS, SLATE_ACCESS_CHECKING, SLATE_ACCESS_UNKNOWN } from "../../source/shared/slate-access.ts"
import { clampBlock, clampLine, decapitalize, slugifyName } from "../../source/shared/slate-text.ts"

// ---------------------------------------------------------------------------------------------
// The numbers and names the two sides of the platform agree on
// ---------------------------------------------------------------------------------------------

test("the constants the platform shares are the ones it promises", () => {
  assert.equal(ENV_NAME_PATTERN.test("MY_VAR"), true)
  assert.equal(ENV_NAME_PATTERN.test("1VAR"), false)
  assert.equal(SLATE_FEEDBACK_MESSAGE_MAX_CHARS, 10_000)
  assert.equal(SLATE_FEEDBACK_CONVERSATION_ID_MAX_CHARS, 512)
  assert.equal(SLATE_FEEDBACK_ACCOUNT_SLOT_MAX_CHARS, 512)
  assert.equal(SLATE_FEEDBACK_SENTRY_EVENT_ID_MAX_COUNT, 5)
  assert.equal(SLATE_FEEDBACK_SENTRY_EVENT_ID_PATTERN.test("a".repeat(32)), true)
  assert.equal(SLATE_FEEDBACK_SENTRY_EVENT_ID_PATTERN.test("a".repeat(31)), false)
  assert.equal(DESKTOP_STRUCTURED_LOG_SPILL_MAX_ENTRIES, 1_000)
  assert.equal(VNC_VIEWER_VISIBLE_CHANNEL.startsWith("slate:"), true)
  assert.equal(NONCE_DIGEST_MISMATCH, "send/nonce-digest-mismatch")
  assert.equal(HOST_ACCOUNT_SLOT, "host")
  assert.equal(DISABLE_SEND_ACCEPT_RETURN_ENV, "SLATE_DISABLE_SEND_ACCEPT_RETURN")
  assert.equal(AUTH_WATCH_POLL_INTERVAL_MS, 5_000)
  assert.equal(AUTH_WATCH_TIMEOUT_MS, 15 * 60 * 1_000)
  assert.equal(AUTH_WATCH_POLL_TIMEOUT_MS, 30_000)
  assert.equal(CATALOG_CACHE_TTL_MS, 30_000)
  assert.equal(WORKFLOW_REFERENCE_NODE_TYPE, "workflowReference")

  // Notifications that are off are off, with the bounds they would have had.
  assert.equal(SLATE_DISABLED_NOTIFICATION_CONFIG.isEnabled, false)
  assert.deepEqual(SLATE_DISABLED_NOTIFICATION_CONFIG.allowedApps, [])

  // The platform's own name, and the one-word spelling of it.
  assert.equal(SLATE_PRODUCT_DISPLAY_NAME, "Slate")
  assert.equal(SLATE_PRODUCT_HTTP_TOKEN, "Slate")
})

test("an error the platform raises says which error it is", () => {
  const mcpError = new SlateMcpConfigError("bad config")
  assert.equal(mcpError.name, "SlateMcpConfigError")
  assert.equal(mcpError.message, "bad config")

  const publishError = new SlateSkillPublishError("the skill is not yours")
  assert.equal(publishError.name, "SlateSkillPublishError")
  assert.equal(publishError.message, `${SKILL_PUBLISH_REFUSAL_PREFIX}the skill is not yours`)
  // The refusal is recognizable in a message, which is what the prefix is for.
  assert.equal(publishError.message.startsWith(SLATE_SKILL_PUBLISH_REFUSED), true)
})

// ---------------------------------------------------------------------------------------------
// Waiting, and knowing when what was read is out of date
// ---------------------------------------------------------------------------------------------

test("how long to wait is read from either spelling a server may use", () => {
  const now = Date.parse("2026-01-01T00:00:00Z")
  assert.equal(parseRetryAfterHeaderMs("120", now), 120_000)
  assert.equal(parseRetryAfterHeaderMs("0", now), 0)
  // A moment that has passed is no wait at all, rather than a negative one.
  assert.equal(parseRetryAfterHeaderMs("-5", now), 0)
  assert.equal(parseRetryAfterHeaderMs("Thu, 01 Jan 2026 00:01:00 GMT", now), 60_000)
  assert.equal(parseRetryAfterHeaderMs("Thu, 01 Jan 2025 00:00:00 GMT", now), 0)
  // A header that says neither is nothing rather than a guess.
  assert.equal(parseRetryAfterHeaderMs("soon", now), undefined)
  assert.equal(parseRetryAfterHeaderMs("", now), undefined)
  assert.equal(parseRetryAfterHeaderMs(null, now), undefined)
  assert.equal(parseRetryAfterHeaderMs(undefined, now), undefined)
})

test("a reader is told when what it read is out of date", () => {
  const epoch = new WriteEpoch()
  const atStart = epoch.snapshot()
  assert.equal(epoch.isStale(atStart), false)

  // A write that is still in flight counts as a change, so nobody reads a half-written view — including a
  // reader that started while the write was half-done.
  const finishWrite = epoch.begin()
  assert.equal(epoch.isStale(atStart), true)
  assert.equal(epoch.isStale(epoch.snapshot()), true)
  finishWrite()
  assert.equal(epoch.isStale(atStart), true)
  assert.notEqual(epoch.snapshot(), atStart)

  // A write moves the epoch twice — once when it begins and once when it settles — and a writer that is
  // asked to settle twice only settles once.
  const beforeWrite = epoch.snapshot()
  const settleOnce = epoch.begin()
  settleOnce()
  settleOnce()
  assert.equal(epoch.snapshot() - beforeWrite, 2)
  // A reader that took its snapshot after the write is not told it is stale.
  const afterWrite = epoch.snapshot()
  assert.equal(epoch.isStale(afterWrite), false)

  // A reset makes everything in flight irrelevant at once.
  epoch.begin()
  epoch.reset()
  assert.equal(epoch.isStale(epoch.snapshot()), false)
})

// ---------------------------------------------------------------------------------------------
// Secrets, access and text
// ---------------------------------------------------------------------------------------------

test("a secret's name is checked against what the box already owns", () => {
  assert.equal(validateBoxSecretKey("MY_TOKEN"), null)
  assert.match(String(validateBoxSecretKey("not a name")), /is not a valid environment variable name/)
  assert.match(String(validateBoxSecretKey("PATH")), /is reserved by the box runtime/)
  assert.match(String(validateBoxSecretKey("SLATE_SOMETHING")), /Names starting with SLATE_ are reserved/)
  assert.match(String(validateBoxSecretKey("__SLATE_PRIVATE")), /Names starting with __SLATE are reserved/)
  assert.match(String(validateBoxSecretKey("LD_PRELOAD")), /Names starting with LD_ are reserved/)
  // A name that mentions the sandbox itself is reserved however it is spelled.
  assert.match(String(validateBoxSecretKey("MY_SLATE_SANDBOX_VALUE")), /is reserved by the box runtime/)
})

test("the set of secrets is bounded, and the box is told their names", () => {
  assert.equal(validateBoxSecrets({ A: "1", B: "2" }), null)
  assert.match(String(validateBoxSecrets({ "not a name": "x" })), /not a valid environment variable name/)
  assert.match(String(validateBoxSecrets({ A: "x".repeat(32 * 1024 + 1) })), /is too large/)
  // The set as a whole is bounded, however reasonable each value is on its own.
  assert.match(String(validateBoxSecrets({ ["A".repeat(60_000)]: "x", ["B".repeat(40_000)]: "y" })), /combined size/)

  const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`V${index}`, "x"]))
  assert.match(String(validateBoxSecrets(tooMany)), /Too many secrets/)

  // The environment carries the names in a stable order, and the list of names beside them so the box can
  // redact them from what it reports.
  assert.deepEqual(buildBoxSecretsEnv({ B: "2", A: "1" }), {
    A: "1",
    B: "2",
    CLOUD_AGENT_INJECTED_SECRET_NAMES: "A,B",
  })
  assert.deepEqual(buildBoxSecretsEnv({}), {})
})

test("access is reported as a state, and a block as one of the reasons a caller knows", () => {
  assert.deepEqual(SLATE_ACCESS_CHECKING, { state: "checking", reason: "unspecified" })
  assert.deepEqual(SLATE_ACCESS_UNKNOWN, { state: "unknown", reason: "unspecified" })
  assert.equal(SLATE_ACCESS_BLOCK_REASONS.has("paywallIndividual"), true)
  assert.equal(isSlateAccessBlockReason("teamAccessRequired"), true)
  assert.equal(isSlateAccessBlockReason("somethingElse"), false)
  assert.equal(isSlateAccessBlockReason(42), false)
})

test("text is turned into what a surface can show", () => {
  assert.equal(clampLine("  a   b \n c  ", 100), "a b c")
  assert.equal(clampLine("abcdef", 3), "abc")
  // A block keeps its own line breaks, and is only cut.
  assert.equal(clampBlock("a\nb\n", 100), "a\nb")
  assert.equal(clampBlock("abcdef", 3), "abc")
  assert.equal(decapitalize("Some phrase"), "some phrase")
  assert.equal(decapitalize(""), "")
  assert.equal(slugifyName("My Skill!", "skill"), "my-skill")
  // A name with nothing a slug can hold falls back to the prefix and the moment.
  assert.equal(slugifyName("!!!", "skill", 1_700_000_000_000), "skill-1700000000000")
  assert.equal(slugifyName("x".repeat(80), "skill").length, 48)
})

// ---------------------------------------------------------------------------------------------
// Reports, logos and account views
// ---------------------------------------------------------------------------------------------

test("a crash report is told how much of itself it may send", () => {
  assert.equal(slateSentryPrivacyTierForMode(PrivacyMode.USAGE_DATA_TRAINING_ALLOWED), "full")
  assert.equal(slateSentryPrivacyTierForMode(PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED), "full")
  assert.equal(slateSentryPrivacyTierForMode(PrivacyMode.NO_TRAINING), "scrubbed")
  assert.equal(slateSentryPrivacyTierForMode(PrivacyMode.NO_STORAGE), "fatal-metadata")
  assert.equal(slateSentryPrivacyTierForMode(undefined), "fatal-metadata")
})

test("a logo is known once it has been shown", () => {
  assert.equal(isKnownPluginLogoUrl("https://example.com/logo.png"), false)
  rememberPluginLogoUrl("https://example.com/logo.png")
  assert.equal(isKnownPluginLogoUrl("https://example.com/logo.png"), true)
  assert.equal(isKnownPluginLogoUrl("https://example.com/other.png"), false)
})

test("a server the refresh could not resolve is carried over rather than dropped", () => {
  const cached = { servers: [{ id: "a" }, { id: "b" }] }
  const display = { servers: [{ id: "a" }], unresolvedServerIds: ["b"] }
  assert.deepEqual(mergeUnresolvedAccountServers(display, cached), { servers: [{ id: "a" }, { id: "b" }], unresolvedServerIds: ["b"] })

  // A server the refresh did resolve replaces what was cached, and one that is neither resolved nor
  // unresolved is gone.
  const replaced = { servers: [{ id: "a" }, { id: "c" }], unresolvedServerIds: ["b"] }
  assert.deepEqual(mergeUnresolvedAccountServers(replaced, cached), {
    servers: [{ id: "a" }, { id: "b" }, { id: "c" }],
    unresolvedServerIds: ["b"],
  })

  // Nothing cached, or nothing unresolved, leaves the display as it is.
  assert.deepEqual(mergeUnresolvedAccountServers(display, null), display)
  const allResolved = { servers: [{ id: "a" }, { id: "b" }] }
  assert.deepEqual(mergeUnresolvedAccountServers(allResolved, cached), allResolved)
})

test("an address a user is sent to authenticate at is one they can trust", () => {
  assert.equal(validateAuthorizationUrl("https://auth.example/authorize"), "https://auth.example/authorize")
  // Plain http is only accepted when both ends are on this machine.
  assert.equal(validateAuthorizationUrl("http://localhost:8080/authorize", "http://127.0.0.1:9000/mcp"), "http://localhost:8080/authorize")
  assert.equal(validateAuthorizationUrl("http://localhost:8080/authorize", "https://mcp.example/sse"), undefined)
  assert.equal(validateAuthorizationUrl("http://auth.example/authorize", "http://localhost:9000/mcp"), undefined)
  assert.equal(validateAuthorizationUrl("not a url"), undefined)
  assert.equal(isLoopbackHostname("localhost"), true)
  assert.equal(isLoopbackHostname("127.0.0.1"), true)
  assert.equal(isLoopbackHostname("example.com"), false)
})

test("a watch for a server's authentication is identified by the server and the account", () => {
  assert.equal(authWatchKey("server-1", "account-1"), "server-1::account-1")
  assert.notEqual(authWatchKey("server-1", "account-1"), authWatchKey("server-2", "account-1"))
})

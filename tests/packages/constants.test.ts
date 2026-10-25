import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AGENT_STORE_RESERVED_PATH_PREFIX,
  AGENT_STORE_USER_MOUNT_NAME,
  isAgentStoreId,
  isAgentStoreShareMountKey,
  isAgentStoreSourceId,
  isCloudAgentStoreId,
  isValidBareUuid,
  parseTeamAgentStoreSourceId,
  parseUserAgentStoreSourceId,
  SLATE_AGENT_STORE_FILES_DIR_ENV,
} from "../../source/packages/constants/agent-store-ids.ts"
import {
  ASK_QUESTION_AUTO_ANSWER_MARKER,
  ASK_QUESTION_AUTO_ANSWER_REASON,
  ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX,
  createAskQuestionAutoAnswerIdentity,
  formatAskQuestionAutoAnswerReason,
  isAskQuestionAutoAnswerReason,
  parseAskQuestionAutoAnswerIdentity,
} from "../../source/packages/constants/ask-question.ts"
import { BOX_WORKSPACE_DEFAULT_IGNORE_PATTERNS, WORKSPACE_IGNORE_FILE_NAME } from "../../source/packages/constants/box-archive.ts"
import {
  BOX_FORK_NOVNC_PORT,
  BOX_IMAGE_TAG_LATEST,
  BOX_PRIMARY_NOVNC_PORT,
  BOX_SPECIAL_TREATMENT_NOVNC_PATH,
  buildBoxNoVncUrl,
  isBoxSpecialTreatmentNoVncUrl,
} from "../../source/packages/constants/box-endpoints.ts"
import {
  BOX_HOST_ENTRY,
  BOX_SUPERVISOR_COMMAND_PART_PATH,
  buildBoxSupervisorCommand,
  HOST_UPGRADE_MAX_DEFER_MS,
  isHostUpgradeAvailable,
  serializeBoxSupervisorCommand,
} from "../../source/packages/constants/box-supervisor.ts"
import { CLOUD_AGENT_ARTIFACTS_DIR, ENV_SETUP_MANAGED_SKILL_PATH } from "../../source/packages/constants/cloud-agent-paths.ts"
import {
  DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS,
  MAX_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS,
  MIN_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS,
} from "../../source/packages/constants/environment-setup.ts"
import { GIT_DIFF_CHARS_PER_TOKEN, GIT_DIFF_TRUNCATION_NOTICE, MAX_GIT_DIFF_CHAR_LENGTH } from "../../source/packages/constants/git-diff.ts"
import {
  GOOGLE_WORKSPACE_MCP_HOSTS,
  MCP_OAUTH_DESKTOP_RETURN_URL,
  MCP_OAUTH_EXTENSION_ID,
  MCP_OAUTH_LOOPBACK_CALLBACK_URL,
  MCP_OAUTH_PROVIDER_POLICIES,
  MCP_OAUTH_RETURN_PATH,
} from "../../source/packages/constants/mcp-oauth.ts"
import {
  AGENT_STORE_PERMISSIONS,
  ENVIRONMENT_PERMISSIONS,
  KEYRING_PERMISSIONS,
  ORGANIZATION_PERMISSIONS,
  TEAM_PERMISSIONS,
} from "../../source/packages/constants/permissions.ts"
import { isRootProjectDetails } from "../../source/packages/constants/project-conversation.ts"
import { isProjectSendMessageEnabled } from "../../source/packages/constants/project-send-message.ts"
import {
  deriveRepoLabelValueFromUrl,
  isKnownGitHostingDomain,
  parseRepoNameFromUrl,
  parseSelfHostedRepoScope,
} from "../../source/packages/constants/repo-label.ts"
import { DEV_SMART_MODE_CLASSIFIER_DELAY_MS, DEV_SMART_MODE_CLASSIFIER_DELAY_SECONDS } from "../../source/packages/constants/smart-mode-classifier.ts"
import { STRUCTURED_LOG_FUTURE_TIMESTAMP_MAX_SKEW_MS, STRUCTURED_LOG_REPLAY_MAX_AGE_MS } from "../../source/packages/constants/structured-log.ts"
import { SYSTEM_NOTIFICATION_CLOSE_TAG, SYSTEM_NOTIFICATION_OPEN_TAG } from "../../source/packages/constants/system-notification.ts"
import { USAGE_PANEL_COPY } from "../../source/packages/constants/usage-copy.ts"

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

test("a source id says whose store it is, or nothing at all", () => {
  assert.deepEqual(parseUserAgentStoreSourceId(`u42`), { userId: 42 })
  assert.deepEqual(parseUserAgentStoreSourceId(`t7-u42`), { userId: 42, teamId: 7 })

  for (const invalid of ["u0", "u-1", "u1.5", "t0-u1", "t-u1", "u", "", "U42", "u42x", "x42"]) {
    assert.equal(parseUserAgentStoreSourceId(invalid), undefined, `${invalid} is not a source id`)
  }
  assert.deepEqual(parseTeamAgentStoreSourceId("t7"), { teamId: 7 })
  assert.equal(parseTeamAgentStoreSourceId("t0"), undefined)
  assert.equal(parseTeamAgentStoreSourceId("u7"), undefined)
})

test("store ids are validated by shape before they are used", () => {
  assert.equal(isValidBareUuid(UUID), true)
  assert.equal(isValidBareUuid("not-a-uuid"), false)
  assert.equal(isAgentStoreId(`store-${UUID}`), true)
  assert.equal(isAgentStoreId(UUID), false)
  assert.equal(isCloudAgentStoreId(`bc-team-${UUID}`), true)
  assert.equal(isCloudAgentStoreId(`bc-${UUID}`), true)
  assert.equal(isCloudAgentStoreId(UUID), false)
  assert.equal(isAgentStoreSourceId(UUID), true)
  assert.equal(isAgentStoreSourceId(`bc-${UUID}`), true)
  assert.equal(isAgentStoreSourceId(`store-${UUID}`), false)
  assert.equal(isAgentStoreShareMountKey(`store-${"a".repeat(24)}`), true)
  assert.equal(isAgentStoreShareMountKey(`store-${"a".repeat(23)}`), false)

  assert.equal(AGENT_STORE_USER_MOUNT_NAME, "user")
  assert.equal(AGENT_STORE_RESERVED_PATH_PREFIX.startsWith("."), true)
  assert.equal(SLATE_AGENT_STORE_FILES_DIR_ENV, "SLATE_AGENT_STORE_FILES_DIR")
})

test("an automatic answer is distinguishable from a user's", () => {
  const identity = createAskQuestionAutoAnswerIdentity()
  assert.equal(identity.kind, "timeout")
  assert.equal(identity.marker, ASK_QUESTION_AUTO_ANSWER_MARKER)

  const reason = formatAskQuestionAutoAnswerReason(identity)
  assert.equal(reason.startsWith(`${ASK_QUESTION_AUTO_ANSWER_MARKER}:timeout|`), true)
  assert.equal(reason.includes(ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX), true)
  assert.equal(ASK_QUESTION_AUTO_ANSWER_REASON, reason)

  assert.deepEqual(parseAskQuestionAutoAnswerIdentity(reason), { marker: ASK_QUESTION_AUTO_ANSWER_MARKER, kind: "timeout" })
  assert.deepEqual(parseAskQuestionAutoAnswerIdentity(` ${reason} `), { marker: ASK_QUESTION_AUTO_ANSWER_MARKER, kind: "timeout" })
  assert.equal(parseAskQuestionAutoAnswerIdentity(`${ASK_QUESTION_AUTO_ANSWER_MARKER}:other|x`)?.kind, "other")
  assert.equal(parseAskQuestionAutoAnswerIdentity("I typed this myself"), undefined)
  assert.equal(parseAskQuestionAutoAnswerIdentity(null), undefined)
  assert.equal(parseAskQuestionAutoAnswerIdentity(undefined), undefined)

  assert.equal(isAskQuestionAutoAnswerReason(reason), true)
  assert.equal(
    isAskQuestionAutoAnswerReason(`${ASK_QUESTION_AUTO_ANSWER_REASON_PREFIX}, so I moved on`),
    true,
    "an unmarked transcript from before the marker still reads as automatic",
  )
  assert.equal(isAskQuestionAutoAnswerReason("no"), false)
})

test("the diff budget follows from the token estimate and says when it was cut", () => {
  assert.equal(MAX_GIT_DIFF_CHAR_LENGTH, 10_000 * GIT_DIFF_CHARS_PER_TOKEN)
  assert.match(GIT_DIFF_TRUNCATION_NOTICE, /truncated due to size/)
})

test("provider policies are complete enough to start a sign-in", () => {
  assert.equal(MCP_OAUTH_PROVIDER_POLICIES.size, 6)
  assert.equal(GOOGLE_WORKSPACE_MCP_HOSTS.size, 6)
  for (const [hostname, policy] of MCP_OAUTH_PROVIDER_POLICIES) {
    assert.equal(policy.provider, "google-workspace", hostname)
    assert.equal(policy.clientRegistration, "static", `${hostname} needs a registered client`)
    assert.equal(policy.authorizationParams.access_type, "offline", `${hostname} wants a refresh token`)
    assert.equal(policy.authorizationParams.prompt, "consent")
    assert.ok(policy.scopes.length > 0, `${hostname} declares scopes`)
    assert.ok(policy.scopes.every(scope => scope.startsWith("https://www.googleapis.com/auth/")), hostname)
  }
  assert.equal(MCP_OAUTH_DESKTOP_RETURN_URL, `slate://${MCP_OAUTH_EXTENSION_ID}${MCP_OAUTH_RETURN_PATH}`)
  assert.equal(MCP_OAUTH_LOOPBACK_CALLBACK_URL.startsWith("http://localhost:"), true)
})

test("the permission vocabulary is namespaced, unique, and lists match their objects", () => {
  const groups: [readonly string[], readonly string[]][] = [
    [TEAM_PERMISSIONS, ["team."]],
    [ORGANIZATION_PERMISSIONS, ["organization."]],
    [AGENT_STORE_PERMISSIONS, ["agent_store."]],
    [KEYRING_PERMISSIONS, ["keyring."]],
    [ENVIRONMENT_PERMISSIONS, ["environment."]],
  ]
  for (const [values, prefixes] of groups) {
    assert.equal(values.length, new Set(values).size, "no duplicates within a group")
    for (const value of values) {
      assert.ok(prefixes.some(prefix => value.startsWith(prefix)), `${value} is namespaced`)
      assert.match(value, /^[a-z_]+(\.[a-z_]+)+$/, `${value} is shaped like a capability`)
    }
  }
  assert.ok(TEAM_PERMISSIONS.includes("team.mcp_servers.manage"))
  assert.ok(ORGANIZATION_PERMISSIONS.includes("organization.identity_providers.manage"))
  assert.ok(ENVIRONMENT_PERMISSIONS.includes("environment.use"))
})

test("only the root project conversation is the project", () => {
  assert.equal(isRootProjectDetails({}), true)
  assert.equal(isRootProjectDetails({ subagent: { id: 1 } }), false)
  assert.equal(isRootProjectDetails({ sideChat: {} }), false)
  assert.equal(isRootProjectDetails(null), false)
  assert.equal(isRootProjectDetails(undefined), false)

  assert.equal(isProjectSendMessageEnabled({ isRootProjectConversation: true }), true)
  assert.equal(isProjectSendMessageEnabled({ isRootProjectConversation: false }), false)
  assert.equal(isProjectSendMessageEnabled({}), false)
})

test("repository labels come out of every form a user can paste", () => {
  assert.equal(isKnownGitHostingDomain("github.com"), true)
  assert.equal(isKnownGitHostingDomain("GitHub.com"), true)
  assert.equal(isKnownGitHostingDomain("gitlab.example.com"), false)
  assert.equal(isKnownGitHostingDomain("git.internal.corp"), false)

  assert.equal(parseRepoNameFromUrl("https://github.com/slate/app.git"), "slate/app")
  assert.equal(parseRepoNameFromUrl("https://gitlab.com/group/sub/project"), "group/sub/project")
  assert.equal(parseRepoNameFromUrl("github.com/slate/app"), "slate/app")
  assert.equal(
    deriveRepoLabelValueFromUrl("git@github.com:slate/app.git"),
    "slate/app",
    "an scp-style remote is rewritten before it is parsed",
  )
  assert.equal(parseRepoNameFromUrl("https://github.com/onlyowner"), undefined)
  assert.equal(parseRepoNameFromUrl("   "), undefined)
  assert.equal(parseRepoNameFromUrl(undefined), undefined)
  assert.equal(parseRepoNameFromUrl("not a url at all"), undefined)

  assert.equal(parseSelfHostedRepoScope("https://git.internal.corp/team/app.git"), "git.internal.corp/team/app")
  assert.equal(parseSelfHostedRepoScope("git.internal.corp/team/app"), "git.internal.corp/team/app")
  assert.equal(parseSelfHostedRepoScope("https://github.com/slate/app"), undefined, "a known host is not self-hosted")
  assert.equal(parseSelfHostedRepoScope("plain/path"), undefined)

  assert.equal(deriveRepoLabelValueFromUrl("git@git.internal.corp:team/app.git"), "git.internal.corp/team/app")
  assert.equal(deriveRepoLabelValueFromUrl("https://github.com/slate/app"), "slate/app")
  assert.equal(deriveRepoLabelValueFromUrl(""), undefined)
})

test("a box's desktop URL carries the token and the resume window", () => {
  const url = buildBoxNoVncUrl("https://box.example", "network-token")
  assert.equal(url.startsWith("https://box.example/vnc.html?network_token=network-token&resume_lower_s=900"), true)
  assert.equal(url.includes("path=websockify%3Fnetwork_token%3Dnetwork-token"), true)

  const withToken = buildBoxNoVncUrl("https://box.example", "network-token", "session-token")
  assert.equal(withToken.includes("path=websockify%3Ftoken%3Dsession-token%26"), true)

  const special = buildBoxNoVncUrl("https://box.example", "network-token", undefined, true)
  assert.equal(special.includes(`/${BOX_SPECIAL_TREATMENT_NOVNC_PATH}`), true)
  assert.equal(isBoxSpecialTreatmentNoVncUrl(special), true)
  assert.equal(isBoxSpecialTreatmentNoVncUrl(url), false)
  assert.equal(isBoxSpecialTreatmentNoVncUrl("not a url"), false)

  assert.equal(BOX_IMAGE_TAG_LATEST, "slate-box-latest")
  assert.equal(BOX_PRIMARY_NOVNC_PORT, 6080)
  assert.equal(BOX_FORK_NOVNC_PORT, 6081)
})

test("a supervisor command carries only what its kind allows", () => {
  const restart = buildBoxSupervisorCommand({ id: "c1", kind: "restart", nowMs: 1_000, version: "9.9.9", reason: "user" })
  assert.deepEqual(restart, { id: "c1", kind: "restart", issuedAtMs: 1_000, reason: "user" }, "a restart cannot carry a version")

  const upgrade = buildBoxSupervisorCommand({
    id: "c2",
    kind: "upgrade",
    nowMs: 2_000,
    mode: "staged",
    version: "1.2.3",
    bundlePath: "/tmp/bundle.tgz",
    forceNow: true,
  })
  assert.deepEqual(upgrade, {
    id: "c2",
    kind: "upgrade",
    issuedAtMs: 2_000,
    mode: "staged",
    version: "1.2.3",
    bundlePath: "/tmp/bundle.tgz",
    forceNow: true,
  })
  const notForced = buildBoxSupervisorCommand({ id: "c3", kind: "upgrade", nowMs: 3_000 })
  assert.equal("forceNow" in notForced, false)
  assert.equal(JSON.parse(serializeBoxSupervisorCommand(upgrade)).version, "1.2.3")

  assert.equal(isHostUpgradeAvailable("1.0.0", "1.0.1"), true)
  assert.equal(isHostUpgradeAvailable("1.0.0", "1.0.0"), false)
  assert.equal(isHostUpgradeAvailable("1.0.0", null), false)
  assert.equal(isHostUpgradeAvailable("1.0.0", ""), false)
  assert.equal(HOST_UPGRADE_MAX_DEFER_MS, 6 * 60 * 60 * 1_000)
  assert.equal(BOX_SUPERVISOR_COMMAND_PART_PATH.endsWith(".json.part"), true)
  assert.equal(BOX_HOST_ENTRY.endsWith("/host-main.cjs"), true)
})

test("what a box archives excludes regenerable output", () => {
  assert.equal(WORKSPACE_IGNORE_FILE_NAME, ".slateignore")
  for (const pattern of ["node_modules/", "dist/", "target/", ".venv/", "coverage/"]) {
    assert.ok((BOX_WORKSPACE_DEFAULT_IGNORE_PATTERNS as readonly string[]).includes(pattern), pattern)
  }
  assert.equal(new Set(BOX_WORKSPACE_DEFAULT_IGNORE_PATTERNS).size, BOX_WORKSPACE_DEFAULT_IGNORE_PATTERNS.length)
})

test("environment and log windows are bounded and ordered", () => {
  assert.ok(MIN_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS < DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS)
  assert.ok(DEFAULT_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS < MAX_ENVIRONMENT_SETUP_MAX_RESUME_AGE_MS)
  assert.equal(STRUCTURED_LOG_REPLAY_MAX_AGE_MS, 17 * 60 * 60 * 1_000)
  assert.equal(STRUCTURED_LOG_FUTURE_TIMESTAMP_MAX_SKEW_MS, 2 * 60 * 60 * 1_000)
  assert.equal(DEV_SMART_MODE_CLASSIFIER_DELAY_MS, 10_000, "the development pause is ten seconds")
  assert.equal(DEV_SMART_MODE_CLASSIFIER_DELAY_SECONDS, DEV_SMART_MODE_CLASSIFIER_DELAY_MS / 1_000)
})

test("notification tags delimit a notification without colliding with prose", () => {
  assert.equal(SYSTEM_NOTIFICATION_OPEN_TAG, "<system_notification>")
  assert.equal(SYSTEM_NOTIFICATION_CLOSE_TAG, "</system_notification>")
})

test("the platform's own strings carry no other product's name", () => {
  const ours = JSON.stringify([
    USAGE_PANEL_COPY,
    ENV_SETUP_MANAGED_SKILL_PATH,
    CLOUD_AGENT_ARTIFACTS_DIR,
    MCP_OAUTH_DESKTOP_RETURN_URL,
    BOX_IMAGE_TAG_LATEST,
    WORKSPACE_IGNORE_FILE_NAME,
    ...BOX_WORKSPACE_DEFAULT_IGNORE_PATTERNS,
  ])
  for (const foreign of ["Cursor", "cursor", "Grok", "grok", "anysphere", "Anysphere", "Bugbot", "bugbot"]) {
    assert.equal(ours.includes(foreign), false, `${foreign} must not appear in our own strings`)
  }
  assert.equal(USAGE_PANEL_COPY.includedTitle.length > 0, true)
  assert.equal(USAGE_PANEL_COPY.otherDescription.length > 0, true)
})

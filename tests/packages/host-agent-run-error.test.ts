import { test } from "node:test"
import assert from "node:assert/strict"

import {
  MAX_TRAY_ACTIONS,
  PROVIDER_OVERLOAD_ERROR_DETAIL,
  PROVIDER_OVERLOAD_ERROR_TITLE,
  SLATE_INCLUDED_LIMIT_REASON,
  SLATE_WEBSITE_ORIGIN,
  SUPPORTED_DASHBOARD_ACTION_VERBS,
  checkoutDeepControlUrl,
  describeAgentRunError,
  findBackendConnectError,
  formatAgentRunError,
  formatSlateUsageResetIn,
  getBackendErrorDetailMessage,
  mapErrorDetailButtons,
  withRelativeSlateIncludedLimitReset,
  type BackendDetail,
  type ErrorButton,
} from "../../source/host/transcript/agent-run-error.ts"

class ConnectError extends Error {
  constructor(readonly details: BackendDetail, extra: Record<string, unknown> = {}) {
    super("connect failed")
    Object.assign(this, extra)
  }
  findDetails() {
    return [{ details: this.details }]
  }
}
const noDetails = () => {
  const error = new Error("no details") as Error & { findDetails: () => unknown[] }
  error.findDetails = () => []
  return error
}
const NOW = Date.UTC(2025, 0, 1, 0, 0, 0)
const after = (ms: number) => new Date(NOW + ms)

test("the words a reader sees for provider trouble are fixed", () => {
  assert.equal(PROVIDER_OVERLOAD_ERROR_TITLE, "Model provider is overloaded")
  assert.equal(PROVIDER_OVERLOAD_ERROR_DETAIL.startsWith("The model provider is under heavy load"), true)
  assert.equal(SLATE_INCLUDED_LIMIT_REASON, "slate_included_limit")
  assert.equal(MAX_TRAY_ACTIONS, 3)
  assert.equal(SLATE_WEBSITE_ORIGIN, "https://slate.invalid")
  assert.deepEqual([...SUPPORTED_DASHBOARD_ACTION_VERBS], ["requestLimitIncrease"])
})

test("a backend error is found through causes and aggregate errors", () => {
  const detailed = new ConnectError({ title: "Rate limited", detail: "Slow down" })
  assert.equal(findBackendConnectError(new Error("outer", { cause: detailed })), detailed)
  const aggregate = new Error("aggregate") as Error & { errors: unknown[] }
  aggregate.errors = [new Error("child"), detailed]
  assert.equal(findBackendConnectError(aggregate), detailed)
  const cycle = new Error("cycle")
  cycle.cause = cycle
  assert.equal(findBackendConnectError(cycle), null)
  assert.equal(findBackendConnectError(new Error("plain")), null)
  assert.equal(findBackendConnectError(null), null)
  assert.equal(findBackendConnectError("text"), null)
})

test("an error without details is the fallback only when details are not required", () => {
  const empty = noDetails()
  assert.equal(findBackendConnectError(empty), null)
  assert.equal(findBackendConnectError(empty, false), empty)
  assert.equal(findBackendConnectError(new Error("plain"), false), null)
})

test("a title and a detail are joined, or one of them is used", () => {
  assert.equal(getBackendErrorDetailMessage(new ConnectError({ title: "Title" })), "Title")
  assert.equal(getBackendErrorDetailMessage(new ConnectError({ detail: "Detail" })), "Detail")
  assert.equal(getBackendErrorDetailMessage(new ConnectError({ title: "  Title  ", detail: "  Detail  " })), "Title\n\nDetail")
  assert.equal(getBackendErrorDetailMessage(new ConnectError({ title: "Same", detail: "Same" })), "Same")
  assert.equal(getBackendErrorDetailMessage(new ConnectError({})), null)
  assert.equal(getBackendErrorDetailMessage(new Error("none")), null)
})

test("a run error shows the backend detail when there is one and its message otherwise", () => {
  assert.equal(formatAgentRunError(new Error("the run failed")), "the run failed")
  assert.equal(formatAgentRunError(new ConnectError({ title: "Backend", detail: "Said so" })), "Backend\n\nSaid so")
})

test("a reset is said in whole units", () => {
  assert.equal(formatSlateUsageResetIn("not a date", NOW), null)
  assert.equal(formatSlateUsageResetIn(after(-1), NOW), "less than a minute")
  assert.equal(formatSlateUsageResetIn(after(0), NOW), "less than a minute")
  assert.equal(formatSlateUsageResetIn(after(30_000), NOW), "1 minute")
  assert.equal(formatSlateUsageResetIn(after(60_000), NOW), "1 minute")
  assert.equal(formatSlateUsageResetIn(after(90_000), NOW), "2 minutes")
  assert.equal(formatSlateUsageResetIn(after(3_600_000), NOW), "1 hour")
  assert.equal(formatSlateUsageResetIn(after(3_600_001), NOW), "2 hours")
  assert.equal(formatSlateUsageResetIn(after(86_400_000), NOW), "1 day")
  assert.equal(formatSlateUsageResetIn(after(86_400_001), NOW), "2 days")
  assert.equal(formatSlateUsageResetIn(after(2 * 86_400_000), NOW), "2 days")
  assert.equal(formatSlateUsageResetIn(after(45_000), NOW), "1 minute")
  assert.equal(formatSlateUsageResetIn(after(120_000), NOW), "2 minutes")
  assert.equal(formatSlateUsageResetIn(after(7_200_000), NOW), "2 hours")
})

test("an included-limit reset is replaced in the text", () => {
  const resetAt = new Date(NOW + 90_000).toISOString()
  assert.equal(withRelativeSlateIncludedLimitReset("It resets at 2025-01-01T00:01:30Z. Try later.", resetAt, NOW), "It resets in 2 minutes. Try later.")
  assert.equal(withRelativeSlateIncludedLimitReset("It resets in 4 minutes, or so.", resetAt, NOW), "It resets in 2 minutes.")
  assert.equal(withRelativeSlateIncludedLimitReset("Nothing to change", resetAt, NOW), "Nothing to change")
  assert.equal(withRelativeSlateIncludedLimitReset("No reset known", null, NOW), "No reset known")
  assert.equal(withRelativeSlateIncludedLimitReset("Bad reset", "nonsense", NOW), "Bad reset")
})

test("a checkout url names the tier and the trial", () => {
  assert.equal(checkoutDeepControlUrl({}), SLATE_WEBSITE_ORIGIN + "/api/auth/checkoutDeepControl?tier=pro")
  assert.equal(checkoutDeepControlUrl({ membershipToUpgradeTo: "pro_plus" }), SLATE_WEBSITE_ORIGIN + "/api/auth/checkoutDeepControl?tier=pro_plus")
  assert.equal(checkoutDeepControlUrl({ membershipToUpgradeTo: "ultra", allowTrial: true }), SLATE_WEBSITE_ORIGIN + "/api/auth/checkoutDeepControl?tier=ultra&allowTrial=true")
  assert.equal(checkoutDeepControlUrl({ membershipToUpgradeTo: "pro", allowTrial: false }), SLATE_WEBSITE_ORIGIN + "/api/auth/checkoutDeepControl?tier=pro&allowTrial=false")
  assert.equal(checkoutDeepControlUrl({ membershipToUpgradeTo: "other" }), SLATE_WEBSITE_ORIGIN + "/api/auth/checkoutDeepControl?tier=pro")
})

test("backend buttons become tray actions, within their bounds", () => {
  const buttons: ErrorButton[] = [
    { label: "Open", action: { case: "url", value: { url: "https://example.test/page" } } },
    { label: "Bad", action: { case: "url", value: { url: "file:///etc/passwd" } } },
    { label: "", action: { case: "url", value: { url: "https://example.test/unlabeled" } } },
    { label: "Upgrade", action: { case: "upgrade", value: { membershipToUpgradeTo: "ultra", allowTrial: true } } },
    { label: "Choose", action: { case: "upgradeChoice", value: {} } },
    { label: "Switch", action: { case: "switchModel", value: {} } },
    { label: "Switch", action: { case: "switchModel", value: {} } },
    { label: "Ask", action: { case: "dashboardAction", value: { action: "requestLimitIncrease", args: { a: 1 }, successMessage: "Sent" } } },
    { label: "Nope", action: { case: "dashboardAction", value: { action: "deleteAccount" } } },
  ]
  assert.deepEqual(mapErrorDetailButtons(buttons), [
    { kind: "open-url", label: "Open", url: "https://example.test/page" },
    { kind: "open-url", label: "Upgrade", url: SLATE_WEBSITE_ORIGIN + "/api/auth/checkoutDeepControl?tier=ultra&allowTrial=true" },
    { kind: "open-url", label: "Choose", url: SLATE_WEBSITE_ORIGIN + "/pricing" },
  ])
  assert.deepEqual(mapErrorDetailButtons(null), [])
  assert.deepEqual(mapErrorDetailButtons([]), [])
  const many: ErrorButton[] = Array.from({ length: 5 }, (_, index) => ({ label: "Button " + index, action: { case: "upgradeChoice", value: {} } }))
  assert.equal(mapErrorDetailButtons(many).length, MAX_TRAY_ACTIONS)
  const dashboard = mapErrorDetailButtons([{ label: "Ask", action: { case: "dashboardAction", value: { action: "requestLimitIncrease", args: { a: 1 }, successMessage: "Sent" } } }])
  assert.deepEqual(dashboard, [{ kind: "dashboard-action", label: "Ask", action: "requestLimitIncrease", args: { a: 1 }, successMessage: "Sent" }])
  assert.deepEqual(mapErrorDetailButtons([{ label: "Nope", action: { case: "dashboardAction", value: { action: "deleteAccount" } } }]), [])
  const withoutLabel = mapErrorDetailButtons([{ label: "", action: { case: "dashboardAction", value: { action: "requestLimitIncrease" } } }])
  assert.deepEqual(withoutLabel, [])
})

test("a run error is described for the reader", () => {
  assert.deepEqual(describeAgentRunError("a string failure"), { detail: "a string failure" })
  assert.deepEqual(describeAgentRunError(new Error("plain failure")), { detail: "plain failure" })
  assert.deepEqual(describeAgentRunError(new ConnectError({ title: "Titled" })), { title: "Titled", detail: "Titled" })
  assert.deepEqual(describeAgentRunError(new ConnectError({ title: "Titled", detail: "Detailed" })), { title: "Titled", detail: "Detailed" })
  const included = new ConnectError({
    title: "Usage limit",
    detail: "Your included usage is used up. It resets at 2030-01-01T00:00:00Z.",
    additionalInfo: { rateLimitReason: SLATE_INCLUDED_LIMIT_REASON, nextResetAt: new Date(Date.now() + 90_000).toISOString() },
    buttons: [{ label: "Upgrade", action: { case: "upgradeChoice", value: {} } }],
  })
  assert.deepEqual(describeAgentRunError(included), {
    title: "Usage limit",
    detail: "Your included usage is used up. It resets in 2 minutes.",
    actions: [{ kind: "open-url", label: "Upgrade", url: SLATE_WEBSITE_ORIGIN + "/pricing" }],
  })
  assert.deepEqual(describeAgentRunError(new ConnectError({ detail: "Detail only" })), { detail: "Detail only" })
})

test("an unknown reset leaves text that talks about a reset alone", () => {
  assert.equal(
    withRelativeSlateIncludedLimitReset("It resets at 2030-01-01T00:00:00Z. Try later.", "nonsense", NOW),
    "It resets at 2030-01-01T00:00:00Z. Try later.",
  )
  assert.equal(
    withRelativeSlateIncludedLimitReset("It resets in 4 minutes, or so.", "nonsense", NOW),
    "It resets in 4 minutes, or so.",
  )
})

test("only one switch-model action is offered", () => {
  const switches: ErrorButton[] = [
    { label: "First", action: { case: "switchModel", value: {} } },
    { label: "Second", action: { case: "switchModel", value: {} } },
  ]
  assert.deepEqual(mapErrorDetailButtons(switches), [{ kind: "switch-model" }])
})

test("a dashboard action gets its own copy of the args", () => {
  const args = { limit: 5 }
  const mapped = mapErrorDetailButtons([
    { label: "Ask", action: { case: "dashboardAction", value: { action: "requestLimitIncrease", args } } },
  ])
  assert.deepEqual(mapped, [{ kind: "dashboard-action", label: "Ask", action: "requestLimitIncrease", args: { limit: 5 }, successMessage: null }])
  args.limit = 9
  assert.deepEqual((mapped[0] as { args: { limit: number } }).args, { limit: 5 })
})


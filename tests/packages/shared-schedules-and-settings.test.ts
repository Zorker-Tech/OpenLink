import { test } from "node:test"
import assert from "node:assert/strict"

import { audioMimeFromPath, extensionFromImageMime, imageMimeFromPath, servableImageMimeFromPath, videoMimeFromPath } from "../../source/shared/media/image-mime.ts"
import {
  ATTACHMENT_BYTE_LIMIT,
  AttachmentTooLargeError,
  attachmentByteLimitForName,
  formatAttachmentTooLargeNotice,
  formatMegabytes,
  nameLooksLikeVideo,
  VIDEO_BYTE_LIMIT,
} from "../../source/shared/media/attachment-limits.ts"
import { MutableGateProperty } from "../../source/shared/node/experiments/gate-property.ts"
import { findSystemErrno } from "../../source/shared/system-errno.ts"
import {
  availableUpdateTracks,
  coerceToEnabledTrack,
  isSlateUpdateTrack,
  NIGHTLY_UPDATE_TRACK_DISABLED,
  resolveEffectiveTrack,
  resolveReleaseTrackGate,
  selectableUpdateTracks,
  SLATE_UPDATE_TRACKS,
  toManagedUpdateTrack,
} from "../../source/shared/update-track.ts"
import { authenticatedAccountKey } from "../../source/shared/auth.ts"
import { isBoxVncMethod, BOX_VNC_METHOD_TABLE } from "../../source/shared/rpc/vnc.ts"
import { BoxSettingsField } from "../../source/shared/host-settings-field.ts"
import { introductionFailedTrayKey, SLATE_ONBOARDING_KICKSTART_PROMPT } from "../../source/shared/agents/onboarding.ts"
import { connectorAuthTelemetry } from "../../source/shared/observability/connector-auth-telemetry.ts"
import { boundedConnectorTag, OTHER_CONNECTOR_TAG, UNKNOWN_CONNECTOR_TAG } from "../../source/adapters/interop/mcp/connector-auth-tag-adapter.ts"
import { isSameBoxMigrationOperation, parseBoxMigrationOperationId } from "../../source/shared/box-migration.ts"
import { hasNonPublicHostnameSuffix } from "../../source/shared/link-preview-policy.ts"
import {
  buildMcpCustomInstructionsSystemPromptSection,
  clampMcpCustomInstruction,
  formatMcpCustomInstructionToolNote,
  getDefaultMcpCustomInstruction,
  MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  resolveMcpCustomInstruction,
  selectConnectedMcpCustomInstructions,
} from "../../source/shared/mcp-custom-instructions.ts"
import {
  automationAnchor,
  compileCronMatcher,
  computeNextRunAt,
  describeSchedule,
  normalizeSchedule,
  parseEveryIntervalMs,
  parseCron,
} from "../../source/shared/automation-schedule.ts"
import { DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS, normalizeSlateAutoReviewInstructions, SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES } from "../../source/shared/slate-auto-review-instructions.ts"
import { AVATAR_SOURCE_MAX_BYTES, avatarSourceSizeError } from "../../source/shared/media/avatar-image.ts"
import { DISK_SAVER_TASK, SLATE_DISK_SAVER_KICKSTART_PROMPT } from "../../source/shared/agents/disk-saver.ts"

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

test("a file's media type is read from its extension", () => {
  assert.equal(imageMimeFromPath("photo.PNG"), "image/png")
  assert.equal(imageMimeFromPath("notes.txt"), undefined)
  assert.equal(videoMimeFromPath("clip.mov"), "video/quicktime")
  assert.equal(audioMimeFromPath("song.mp3"), "audio/mpeg")
  // A type the client can render itself is served as itself.
  assert.equal(servableImageMimeFromPath("photo.heic"), "image/heic")
  assert.equal(extensionFromImageMime("IMAGE/PNG"), ".png")
})

test("a video is given more room than anything else, and says which limit it broke", () => {
  assert.equal(ATTACHMENT_BYTE_LIMIT, 25 * 1024 * 1024)
  assert.equal(VIDEO_BYTE_LIMIT, 200 * 1024 * 1024)
  assert.equal(nameLooksLikeVideo("clip.mp4"), true)
  assert.equal(nameLooksLikeVideo("photo.png"), false)
  assert.equal(attachmentByteLimitForName("clip.mp4"), VIDEO_BYTE_LIMIT)
  assert.equal(attachmentByteLimitForName("photo.png"), ATTACHMENT_BYTE_LIMIT)
  assert.equal(formatMegabytes(25 * 1024 * 1024), "25 MB")
  assert.match(formatAttachmentTooLargeNotice("clip.mp4"), /max 200 MB for video/)
  assert.match(formatAttachmentTooLargeNotice("photo.png"), /max 25 MB/)
  const error = new AttachmentTooLargeError(ATTACHMENT_BYTE_LIMIT)
  assert.equal(error.name, "AttachmentTooLargeError")
})

test("an avatar's source image is bounded, and the message says so", () => {
  assert.equal(AVATAR_SOURCE_MAX_BYTES, 25 * 1024 * 1024)
  assert.equal(avatarSourceSizeError(AVATAR_SOURCE_MAX_BYTES), null)
  assert.match(String(avatarSourceSizeError(AVATAR_SOURCE_MAX_BYTES + 1)), /smaller than 25 MB/)
})

// ---------------------------------------------------------------------------------------------
// Switches, accounts and error codes
// ---------------------------------------------------------------------------------------------

test("a gate tells its listeners when it changes, and one bad listener does not stop the rest", () => {
  const gate = new MutableGateProperty(false)
  const seen: boolean[] = []
  const unsubscribe = gate.subscribe(value => seen.push(value))
  assert.equal(gate.get(), false)

  // Setting the value it already has says nothing.
  gate.set(false)
  assert.deepEqual(seen, [])

  gate.set(true)
  assert.deepEqual(seen, [true])
  unsubscribe()
  gate.set(false)
  assert.deepEqual(seen, [true])

  // A listener that throws is reported, and the others are still told.
  const other: boolean[] = []
  gate.subscribe(() => {
    throw new Error("bad listener")
  })
  gate.subscribe(value => other.push(value))
  gate.set(true)
  assert.deepEqual(other, [true])
  gate.clearListeners()
  gate.set(false)
  assert.deepEqual(other, [true])
})

test("an authenticated account key prefers its id, then email, and is absent while signed out", () => {
  assert.equal(authenticatedAccountKey({ kind: "logged-in", authId: "auth-1", email: "a@example.com" }), "auth-1")
  assert.equal(authenticatedAccountKey({ kind: "logged-in", email: "a@example.com" }), "a@example.com")
  assert.equal(authenticatedAccountKey({ kind: "logged-in" }), null)
  assert.equal(authenticatedAccountKey({ kind: "logged-in", authId: "", email: "a@example.com" }), null)
  assert.equal(authenticatedAccountKey({ kind: "logged-in", authId: "  " }), "  ")
  assert.equal(authenticatedAccountKey({ kind: "logged-out", email: "a@example.com" }), null)
})

test("an operating system error code is found however deep the failure was wrapped", () => {
  assert.equal(findSystemErrno(Object.assign(new Error("missing"), { code: "ENOENT" })), "ENOENT")
  assert.equal(findSystemErrno(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "EACCES" }) })), "EACCES")
  // Something that is not a system code is not one, and a cycle does not loop forever.
  assert.equal(findSystemErrno(Object.assign(new Error("x"), { code: "SOMETHING" })), undefined)
  const cyclic = new Error("a")
  ;(cyclic as { cause?: unknown }).cause = cyclic
  assert.equal(findSystemErrno(cyclic), undefined)
  assert.equal(findSystemErrno(undefined), undefined)
})

test("an operating system error code is the nearest one that is shaped like one", () => {
  const inner = Object.assign(new Error("inner"), { code: "ENOENT" })
  assert.equal(findSystemErrno(new Error("outer", { cause: inner })), "ENOENT", "a wrapper without a code passes the question down")
  assert.equal(findSystemErrno(Object.assign(new Error("outer", { cause: inner }), { code: "EPERM" })), "EPERM", "the nearest code answers first")
  assert.equal(findSystemErrno(Object.assign(new Error("outer"), { code: "WRAPPED", cause: inner })), "ENOENT", "a code that is not shaped like one is skipped")
  assert.equal(findSystemErrno(Object.assign(new Error("x"), { code: "ENOENT2" })), undefined, "a digit is not part of the shape")
  assert.equal(findSystemErrno(Object.assign(new Error("x"), { code: "enoent" })), undefined, "the shape is upper case")
  assert.equal(findSystemErrno(Object.assign(new Error("x"), { code: "E" })), undefined, "the shape needs more than the E")
  assert.equal(findSystemErrno(Object.assign(new Error("x"), { code: "E_ACCES" })), "E_ACCES")
  assert.equal(findSystemErrno(Object.assign(new Error("x"), { code: 7 })), undefined, "only a string is a code")
  assert.equal(findSystemErrno({ cause: Object.assign(new Error("x"), { code: "EIO" }) }), "EIO", "a plain wrapper is walked like an error")
  assert.equal(findSystemErrno("EACCES"), undefined, "a bare string has no wrappers to walk")
  assert.equal(findSystemErrno(Object.assign(function fn() {}, { code: "EINVAL" })), undefined, "a function is not a wrapper")
  const loopWithCode = Object.assign(new Error("loop"), { code: "ELOOP" })
  ;(loopWithCode as { cause?: unknown }).cause = loopWithCode
  assert.equal(findSystemErrno(loopWithCode), "ELOOP", "the code is read before the walk notices the cycle")
})

test("a box answers the VNC methods it declares, and nothing else", () => {
  assert.deepEqual(Object.keys(BOX_VNC_METHOD_TABLE), ["readClipboard", "writeClipboard", "reportUserPresence"])
  assert.equal(isBoxVncMethod("readClipboard"), true)
  assert.equal(isBoxVncMethod("toString"), false)
})

test("a box migration is the same operation only when its id is", () => {
  const parsed = parseBoxMigrationOperationId("op-1")
  assert.deepEqual(parsed, { value: "op-1" })
  assert.equal(parseBoxMigrationOperationId(""), null)
  assert.equal(parseBoxMigrationOperationId(42), null)
  assert.equal(isSameBoxMigrationOperation(parsed, { value: "op-1" }), true)
  assert.equal(isSameBoxMigrationOperation(parsed, { value: "op-2" }), false)
  assert.equal(isSameBoxMigrationOperation(null, parsed), false)
})

// ---------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------

test("the tracks a user can pick are the ones that are offered", () => {
  // Nightly is not offered while it is disabled, and the internal track only when it is unlocked.
  assert.deepEqual(selectableUpdateTracks(false), ["stable"])
  assert.deepEqual(selectableUpdateTracks(true), ["stable", "dogfood"])
  assert.equal(coerceToEnabledTrack("nightly"), "stable")
  assert.equal(coerceToEnabledTrack("stable"), "stable")

  // A build that is on a track nobody can pick still shows where it is.
  assert.deepEqual(availableUpdateTracks({ unlockInternalTracks: false, effectiveTrack: "nightly" }), ["stable", "nightly"])
  assert.equal(toManagedUpdateTrack("nightly"), undefined)
  assert.equal(toManagedUpdateTrack("stable"), "stable")
  assert.deepEqual(resolveReleaseTrackGate({ releaseTrack: "nightly" }), { managedTrack: undefined, unlockInternalTracks: false })
  assert.equal(resolveEffectiveTrack({ userOverride: "dogfood" }), "dogfood")
  assert.equal(resolveEffectiveTrack({}), "stable")
})

test("a track is only managed when it is a track that survives coercion, and only the strict unlock flag unlocks", () => {
  assert.equal(NIGHTLY_UPDATE_TRACK_DISABLED, true)
  assert.deepEqual([...SLATE_UPDATE_TRACKS], ["stable", "nightly", "dogfood"])
  assert.equal(isSlateUpdateTrack("stable"), true)
  assert.equal(isSlateUpdateTrack(" dogfood "), false, "a stored value is trimmed before it is judged, not by the guard")
  assert.equal(isSlateUpdateTrack("toString"), false)
  assert.equal(isSlateUpdateTrack(null), false)
  assert.equal(isSlateUpdateTrack(7), false)

  assert.equal(toManagedUpdateTrack("  dogfood  "), "dogfood", "the stored value is trimmed")
  assert.equal(toManagedUpdateTrack("beta"), undefined)
  assert.equal(toManagedUpdateTrack(""), undefined)
  assert.equal(toManagedUpdateTrack(7), undefined, "only text is a stored track")
  assert.equal(toManagedUpdateTrack("nightly"), undefined, "a track that coerces away from itself is not managed")

  assert.deepEqual(resolveReleaseTrackGate({ releaseTrack: "  dogfood  ", unlockInternalTracks: true }), { managedTrack: "dogfood", unlockInternalTracks: true })
  assert.deepEqual(resolveReleaseTrackGate({ releaseTrack: "stable", unlockInternalTracks: "true" }), { managedTrack: "stable", unlockInternalTracks: false }, "only the boolean true unlocks")
  assert.deepEqual(resolveReleaseTrackGate({ releaseTrack: "stable", unlockInternalTracks: 1 }), { managedTrack: "stable", unlockInternalTracks: false })
  assert.deepEqual(resolveReleaseTrackGate({}), { managedTrack: undefined, unlockInternalTracks: false })

  assert.equal(resolveEffectiveTrack({ managedTrack: "dogfood", userOverride: "stable" }), "dogfood", "the managed track comes first")
  assert.equal(resolveEffectiveTrack({ userOverride: "stable", buildDefault: "dogfood" }), "stable", "the user's choice comes before the build's own")
  assert.equal(resolveEffectiveTrack({ buildDefault: "nightly" }), "stable", "the chosen track is coerced like any other")
  assert.equal(resolveEffectiveTrack({ managedTrack: "nightly", userOverride: "dogfood" }), "stable", "a coerced nightly does not fall through to the user's choice")
  assert.equal(resolveEffectiveTrack({ buildDefault: null }), "stable", "a null build default falls through to the stable one")
  assert.deepEqual(availableUpdateTracks({ unlockInternalTracks: true, effectiveTrack: "stable" }), ["stable", "dogfood"])
  assert.deepEqual(availableUpdateTracks({ unlockInternalTracks: false, effectiveTrack: "dogfood" }), ["stable", "dogfood"], "the track the build is on is shown even when it cannot be picked")
})

// ---------------------------------------------------------------------------------------------
// Connectors and link previews
// ---------------------------------------------------------------------------------------------

test("a connector is reported by a tag from a fixed set", () => {
  assert.equal(boundedConnectorTag("GitHub"), "github")
  assert.equal(boundedConnectorTag("my own server"), OTHER_CONNECTOR_TAG)
  assert.equal(boundedConnectorTag(undefined), UNKNOWN_CONNECTOR_TAG)
  assert.equal(boundedConnectorTag(""), UNKNOWN_CONNECTOR_TAG)

  const report = connectorAuthTelemetry({ phase: "callback", outcome: "failed", serverName: "github" }, "desktop")
  assert.equal(report.level, "warn")
  assert.equal(report.metadata.connector, "github")
  assert.equal(report.metadata.surface, "desktop")
  const ok = connectorAuthTelemetry({ phase: "start", outcome: "succeeded" }, "box")
  assert.equal(ok.level, "info")
  assert.equal(ok.metadata.connector, UNKNOWN_CONNECTOR_TAG)
})

test("a preview is not fetched from a host that is only reachable inside a network", () => {
  assert.equal(hasNonPublicHostnameSuffix("example.com"), false)
  assert.equal(hasNonPublicHostnameSuffix("printer.local"), true)
  assert.equal(hasNonPublicHostnameSuffix("service.cluster"), true)
  assert.equal(hasNonPublicHostnameSuffix("localhost"), true)
  assert.equal(hasNonPublicHostnameSuffix("notlocal"), false)
})

test("a connector's instructions are bounded, and only connected ones are listed", () => {
  assert.equal(clampMcpCustomInstruction("x".repeat(MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH + 10)).length, MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH)
  // A stored instruction is trimmed; an absent one falls back to the connector's own default.
  assert.equal(resolveMcpCustomInstruction("hex", "  use the data  "), "use the data")
  assert.match(resolveMcpCustomInstruction("hex", undefined), /CSV/)
  assert.equal(resolveMcpCustomInstruction("unknown", undefined), "")

  const entries = selectConnectedMcpCustomInstructions(["b", "a", "a", "none"], new Map([["a", "always a"], ["b", "always b"]]))
  assert.deepEqual(entries, [{ name: "a", instructions: "always a" }, { name: "b", instructions: "always b" }])

  const section = buildMcpCustomInstructionsSystemPromptSection(["a"], new Map([["a", "always a"]]))
  assert.match(String(section), /Connector custom instructions/)
  assert.match(String(section), /- a: always a/)
  assert.equal(buildMcpCustomInstructionsSystemPromptSection(["a"], new Map()), null)
  assert.match(formatMcpCustomInstructionToolNote("a", "always a"), /"a" connector/)
})

test("a connector's own instruction stands in only when nothing was stored, and the prompt section is exactly three lines and a list", () => {
  assert.equal(MCP_CUSTOM_INSTRUCTIONS_MAX_LENGTH, 500)
  assert.equal(clampMcpCustomInstruction("x".repeat(500)), "x".repeat(500))
  assert.equal(clampMcpCustomInstruction("x".repeat(501)), "x".repeat(500))
  assert.equal(clampMcpCustomInstruction("  padded  "), "  padded  ", "cutting is not trimming")

  assert.equal(getDefaultMcpCustomInstruction(" hex "), getDefaultMcpCustomInstruction("HEX"))
  assert.match(getDefaultMcpCustomInstruction("hex"), /CSV/)
  assert.equal(getDefaultMcpCustomInstruction("unknown"), "")

  assert.equal(resolveMcpCustomInstruction("hex", ""), "", "a stored empty instruction is a decision, not a missing one")
  assert.equal(resolveMcpCustomInstruction("hex", "   "), "")
  assert.equal(resolveMcpCustomInstruction(" hex ", undefined), getDefaultMcpCustomInstruction("hex"))

  assert.deepEqual(selectConnectedMcpCustomInstructions(["blank"], new Map([["blank", "   "]])), [], "an instruction that trims to nothing is no instruction")
  assert.deepEqual(
    selectConnectedMcpCustomInstructions(["hex"], new Map()),
    [{ name: "hex", instructions: getDefaultMcpCustomInstruction("hex") }],
    "a connector with a default is listed without a stored instruction",
  )

  const section = String(buildMcpCustomInstructionsSystemPromptSection(["b", "a"], new Map([["a", "always a"], ["b", "always b"]])))
  const lines = section.split("\n")
  assert.equal(lines.length, 4)
  assert.equal(lines[0], "## Connector custom instructions")
  const intro = lines[1] ?? ""
  assert.equal(intro.startsWith("Custom instructions are configured for some connected tools"), true)
  assert.equal(intro.length, 192, "the introduction is one sentence, unchanged")
  assert.deepEqual(lines.slice(2), ["- a: always a", "- b: always b"])
  assert.equal(section.length, 253)
  assert.equal(buildMcpCustomInstructionsSystemPromptSection(["a"], new Map()), null)

  assert.equal(formatMcpCustomInstructionToolNote("a", "  always a  "), 'Custom instructions for the "a" connector (always follow them when using this tool):\nalways a')
})

// ---------------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------------

test("a schedule is read as an interval or as a cron expression", () => {
  assert.equal(normalizeSchedule("  every   30  minutes "), "every 30 minutes")
  assert.equal(parseEveryIntervalMs("every 30 minutes"), null)
  assert.equal(parseEveryIntervalMs("@every 30 m"), 30 * 60_000)
  assert.equal(parseEveryIntervalMs("@every 0 m"), null)

  const matcher = parseCron("0 9 * * 1-5")
  assert.equal(matcher?.minute.has(0), true)
  assert.equal(matcher?.hour.has(9), true)
  assert.equal(matcher?.dayOfWeek.has(1), true)
  assert.equal(matcher?.dayOfWeek.has(6), false)
  assert.equal(matcher?.isDayOfWeekRestricted, true)
  assert.equal(matcher?.isDayOfMonthRestricted, false)
  // Sunday may be written as either 0 or 7.
  assert.equal(parseCron("0 0 * * 7")?.dayOfWeek.has(0), true)
  assert.equal(parseCron("not a cron"), null)
  assert.equal(parseCron("0 9 * *"), null)
  assert.equal(parseCron("0 99 * * *"), null)

  // A time zone may be named in front of the expression, and one that is not a zone is refused.
  assert.equal(compileCronMatcher("CRON_TZ=UTC 0 9 * * *")?.timeZone, "UTC")
  assert.equal(compileCronMatcher("CRON_TZ=Not/AZone 0 9 * * *"), null)
})

test("the next run is the next moment the schedule matches", () => {
  // Every hour on the hour, from a moment in between.
  const hourly = compileCronMatcher("0 * * * *")
  assert.notEqual(hourly, null)
  const from = Date.UTC(2026, 0, 1, 10, 30)
  const next = computeNextRunAt("0 * * * *", from)
  assert.equal(next, Date.UTC(2026, 0, 1, 11, 0))

  // An interval is counted from the moment it is asked about.
  assert.equal(computeNextRunAt("@every 15 m", from), from + 15 * 60_000)
  // A schedule that can never match is reported as such rather than searched forever, and one that cannot be
  // read at all is not run either.
  assert.equal(computeNextRunAt("0 0 30 2 *", from), null)
  assert.equal(computeNextRunAt("not a schedule", from), null)
})

test("a schedule is said in words a user can read", () => {
  assert.equal(describeSchedule("@every 1 h"), "Every hour")
  assert.equal(describeSchedule("@every 30 m"), "Every 30 minutes")
  assert.equal(describeSchedule("0 9 * * 1-5"), "Weekdays at 9:00 AM")
  assert.equal(describeSchedule("@daily"), "Every day at 12:00 AM")
  // A date that never comes is still described by its fields, while a shape that cannot be phrased is shown
  // as it was written.
  assert.equal(describeSchedule("0 0 30 2 *"), "Every February 30 at 12:00 AM")
  assert.equal(describeSchedule("1,2,3,4 5 * * *"), "1,2,3,4 5 * * *")
  assert.equal(describeSchedule("CRON_TZ=UTC 0 9 * * *").endsWith("(UTC)"), true)
})

test("an automation's next run is counted from when it last ran", () => {
  assert.equal(automationAnchor({ createdAt: 100, lastRunAt: 500 }), 500)
  assert.equal(automationAnchor({ createdAt: 100 }), 100)
})

// ---------------------------------------------------------------------------------------------
// Settings a user writes
// ---------------------------------------------------------------------------------------------

test("the instructions a user writes for the classifier are bounded and in their order", () => {
  assert.equal(SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES, 20)
  const normalized = normalizeSlateAutoReviewInstructions({
    allowInstructions: ["  run the tests  ", "run the tests", 42, "x".repeat(1_500)],
    blockInstructions: [],
  })
  assert.equal(normalized.isEnabled, true)
  assert.equal(normalized.allowInstructions.length, 2)
  assert.equal(normalized.allowInstructions[0], "run the tests")
  assert.equal(normalized.allowInstructions[1]?.length, 1_000)
  // A list longer than the cap is cut to the cap, in the order it was written.
  const many = normalizeSlateAutoReviewInstructions({ allowInstructions: Array.from({ length: 25 }, (_, index) => `rule ${index}`) })
  assert.equal(many.allowInstructions.length, SLATE_AUTO_REVIEW_INSTRUCTION_MAX_ENTRIES)
  assert.equal(many.allowInstructions[0], "rule 0")
  assert.equal(many.allowInstructions.at(-1), "rule 19")
  // A configuration that says nothing is enabled with empty lists, and only an explicit false turns it off.
  assert.deepEqual(normalizeSlateAutoReviewInstructions(undefined), DEFAULT_SLATE_AUTO_REVIEW_INSTRUCTIONS)
  assert.equal(normalizeSlateAutoReviewInstructions({ isEnabled: false }).isEnabled, false)
})

test("what a new agent and a disk-pressured agent are told is the platform's own wording", () => {
  assert.match(SLATE_ONBOARDING_KICKSTART_PROMPT, /very first turn/)
  assert.match(SLATE_ONBOARDING_KICKSTART_PROMPT, /SendMessage/)
  assert.equal(introductionFailedTrayKey("agent-1"), "introduction-failed:agent-1")
  assert.match(SLATE_DISK_SAVER_KICKSTART_PROMPT, /Slate itself/)
  assert.match(DISK_SAVER_TASK, /Delete or modify nothing until the user confirms/)
})

test("a settings field is kept in step between the host and the box", async () => {
  const written: Array<Partial<{ theme: string }>> = []
  let stored: { theme: string } = { theme: "system" }
  let readable = true
  const port = {
    isReadable: () => readable,
    read: async () => stored,
    write: async (update: Partial<{ theme: string }>) => {
      written.push(update)
      stored = { ...stored, ...update }
      return stored
    },
  }
  let mirrored: string | undefined
  const mirror = { read: () => mirrored, write: (value: string) => { mirrored = value }, clear: () => { mirrored = undefined } }

  const field = new BoxSettingsField(port, "theme", mirror)
  // What the host holds is what a reconcile answers when nothing is in flight.
  assert.equal(await field.reconcile(), "system")

  // A write goes to the box as well as to the copy, and the host's echo is what is reported back.
  assert.deepEqual(await field.apply("dark"), { status: "persisted", value: "dark" })
  assert.deepEqual(written, [{ theme: "dark" }])
  assert.equal(mirrored, "dark")

  // A host that cannot be written to is reported as unreachable rather than as saved.
  const unreachable = new BoxSettingsField({ isReadable: () => false, read: async () => ({ theme: "system" }), write: async () => null }, "theme", mirror)
  assert.deepEqual(await unreachable.apply("light"), { status: "unreachable" })

  // A box that holds nothing yet is given what the session already answered.
  stored = {} as { theme: string }
  const fresh = new BoxSettingsField(port, "theme", { ...mirror, read: () => "dark" })
  assert.equal(await fresh.reconcile(), null)
  fresh.abandonInFlight()
  readable = true
})

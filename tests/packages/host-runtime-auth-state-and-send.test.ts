/**
 * The host's runtime pieces, fourteenth group: the account this host acts as, what an agent may be told to change about
 * itself, and what an accepted send echoes back.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createRetryPolicy, type Clock } from "../../source/host/extensions/scheduling.ts";
import { createHostAuthService, EXPIRY_LEEWAY_MS, InferenceCredentialStore, SLATE_SHORTLIVED_CREDS_WAITING_MESSAGE, SlateCredentialsWaitingError } from "../../source/host/auth/auth-service.ts";
import { AVATAR_MAX_BYTES, createSlateAgentState, MEMORY_NOTE_PREFIX } from "../../source/host/memory/agent-state.ts";
import { CANONICAL_AVATAR_FILENAME } from "../../source/host/agents/agent-avatar.ts";
import { normalizeMemoryContent } from "../../source/host/runner/slate-memory.ts";
import { appendAddressedEcho, applySendRosterSideEffects, emitAcceptedSendEchoes, setSendAcceptanceCompletedSpanRecorder } from "../../source/host/transcript/send-acceptance.ts";
import { SlateSendNotPersistedError } from "../../source/host/transcript/send-not-persisted-error.ts";
import { getSlateProfilePath, readSlateProfileFile } from "../../source/host/agents/agent-profile.ts";
import { isSlateDefaultAgentName } from "../../source/shared/agents/agents.ts";

const fixedClock: Clock = { now: () => 1_000, monotonicNow: () => 1_000, schedule: () => ({ dispose() {} }) };
const retry = () => createRetryPolicy(fixedClock, { name: "credential", maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 });

describe("the account this host acts as", () => {
  it("keeps a credential only while it is valid, with room to renew before it runs out", () => {
    const store = new InferenceCredentialStore();
    assert.equal(store.getValidAccessToken(1_000), null);
    assert.equal(store.hasValidCredential(1_000), false);
    store.setCredential({ accessToken: "token-1", expiresAtMs: 100_000 });
    assert.equal(store.getValidAccessToken(1_000), "token-1");
    // Inside the leeway the credential is treated as spent, so the next call renews rather than fails.
    assert.equal(EXPIRY_LEEWAY_MS, 30_000);
    assert.equal(store.getValidAccessToken(100_000 - EXPIRY_LEEWAY_MS), null);
    assert.equal(store.getValidAccessToken(100_000 - EXPIRY_LEEWAY_MS - 1), "token-1");
    assert.equal(store.hasValidCredential(100_000 - EXPIRY_LEEWAY_MS - 1), true);
    // A credential without a token is not a credential: it is ignored, and what is already there is kept.
    store.setCredential({ accessToken: "", expiresAtMs: 1_000_000 });
    assert.equal(store.getValidAccessToken(1_000), "token-1");
    store.setCredential({ accessToken: "token-2", expiresAtMs: 1_000_000 });
    store.clear();
    assert.equal(store.getValidAccessToken(1_000), null);
  });

  it("hands out a token, reports what renewals did, and says which one was the first", async () => {
    const logs: string[] = [];
    const renewals: Array<Record<string, unknown>> = [];
    const service = createHostAuthService({
      retry: retry(),
      clock: fixedClock,
      log: (message) => { logs.push(message); },
      env: { SLATE_INFERENCE_RENEWAL_CREDENTIAL: "renewal-credential" },
      backendUrl: "https://backend.invalid",
      renewCredential: async (backendUrl, credential) => {
        renewals.push({ backendUrl, credential });
        return { accessToken: "renewed-token", expiresAtMs: Date.now() + 60 * 60_000 };
      },
      getMachineId: async () => "machine-1",
    });
    try {
      // The renewer is started with what it is reading and what that means for inference, and it renews with no
      // further prompting — the credential it was given is the one it renews with.
      assert.equal(logs[0], "inference-credential renewer started (backend self-renewal is the sole inference-credential source)");
      assert.equal(await service.getMachineId(), "machine-1");
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      assert.deepEqual(renewals.at(-1), { backendUrl: "https://backend.invalid", credential: "renewal-credential" });
      const first = service.getLastRenewalEvent();
      assert.equal(first?.outcome, "renewed");
      // The first credential the box received is named as such, because the platform waits on it differently.
      assert.equal(first?.isFirstCredential, true);
      assert.equal(service.peekAccessToken(), "renewed-token");
      assert.equal(await service.getAccessToken(), "renewed-token");
      // A listener hears what happens next, and stops hearing when it stops listening.
      const seen: Array<{ outcome: string; isFirstCredential: boolean }> = [];
      const unsubscribe = service.subscribeToRenewal((event) => { seen.push({ outcome: event.outcome, isFirstCredential: event.isFirstCredential }); });
      assert.equal(typeof unsubscribe, "function");
      unsubscribe();
      assert.deepEqual(seen, []);
    } finally {
      service.dispose();
    }
  });

  it("reports a renewal that failed, and refuses to hand out a token it does not have", async () => {
    const logs: string[] = [];
    const service = createHostAuthService({
      retry: retry(),
      clock: fixedClock,
      log: (message) => { logs.push(message); },
      env: { SLATE_INFERENCE_RENEWAL_CREDENTIAL: "renewal-credential" },
      renewCredential: async () => { throw new Error("the platform refused it"); },
    });
    try {
      const seen: Array<{ outcome: string; isFirstCredential: boolean }> = [];
      service.subscribeToRenewal((event) => { seen.push({ outcome: event.outcome, isFirstCredential: event.isFirstCredential }); });
      await service.getAccessToken().then(
        () => assert.fail("a token was handed out with nothing to hand out"),
        (error: SlateCredentialsWaitingError) => { assert.equal(error instanceof SlateCredentialsWaitingError, true); assert.equal(error.message, SLATE_SHORTLIVED_CREDS_WAITING_MESSAGE); },
      );
      assert.equal(seen.at(-1)?.outcome, "failed");
      assert.equal(seen.at(-1)?.isFirstCredential, false);
      assert.equal(logs.some((line) => line.startsWith("inference-credential renewal failed (streak 1): ")), true);
    } finally {
      service.dispose();
    }
  });

  it("reads a development token from the file the environment named", async () => {
    const logs: string[] = [];
    const reads: string[] = [];
    const service = createHostAuthService({
      retry: retry(),
      clock: fixedClock,
      log: (message) => { logs.push(message); },
      env: { SLATE_DEV_INFERENCE_TOKEN_FILE: "/dev/inference-token.json" },
      readDevCredential: async (path) => { reads.push(path); return { accessToken: "dev-token", expiresAtMs: Date.now() + 60 * 60_000 }; },
    });
    try {
      assert.equal(logs[0]?.startsWith("DEV inference-credential renewer started, reading short-lived tokens from /dev/inference-token.json"), true);
      // The file is what it renews from, so it is read as soon as the renewer wants a credential.
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      assert.deepEqual(reads, ["/dev/inference-token.json"]);
      assert.equal(await service.getAccessToken(), "dev-token");
    } finally {
      service.dispose();
    }
  });

  it("says plainly when nothing was delivered into the box to renew with", () => {
    const logs: string[] = [];
    const service = createHostAuthService({ retry: retry(), clock: fixedClock, log: (message) => { logs.push(message); }, env: {} });
    try {
      assert.equal(logs[0], "inference-credential renewer started, but no renewal credential was delivered into the box; inference is unavailable until the box is re-provisioned with one");
      assert.equal(service.peekAccessToken(), null);
    } finally {
      service.dispose();
    }
  });
});

describe("what an agent may be told to change about itself", () => {
  function harness() {
    const slateRoot = mkdtempSync(join(tmpdir(), "slate-state-"));
    const agentDir = join(slateRoot, "agents", "agent-1");
    mkdirSync(agentDir, { recursive: true });
    const facts: Array<{ content: string; kind: string; where: string }> = [];
    const memory = {
      // The store this stands in for normalizes what it is given, which is what makes two facts one fact.
      addMemory: (content: string, _at: number, kind: string) => {
        const normalized = normalizeMemoryContent(content);
        if (facts.some((fact) => fact.content === normalized && fact.kind === kind)) return null;
        facts.push({ content: normalized, kind, where: "agent" });
        return { content: normalized };
      },
      removeMemoryByContent: (content: string) => { const normalized = normalizeMemoryContent(content); const index = facts.findIndex((fact) => fact.content === normalized); if (index < 0) return false; facts.splice(index, 1); return true; },
    };
    const created: Array<{ spec: unknown }> = [];
    const automations = {
      upsert: (spec: unknown) => { created.push({ spec }); return { id: "routine-1", name: "Nightly", isEnabled: true, trigger: { type: "cron", schedule: "0 3 * * *" } as never }; },
      update: (id: string, spec: unknown) => (id === "routine-1" ? { id, name: "Nightly", isEnabled: true, trigger: { type: "slack", channel: "anywhere", match: { kind: "mention" } } as never } : null),
      setEnabled: (id: string, enabled: boolean) => (id === "routine-1" ? { id, name: "Nightly", enabled } : null),
      get: (id: string) => (id === "routine-1" ? { name: "Nightly" } : null),
      remove: (id: string) => id === "routine-1",
    };
    const workflows: Array<{ id?: string; spec: unknown }> = [];
    const projects = { joined: new Set<string>(), read: () => projects.joined as ReadonlySet<string>, join(slug: string) { projects.joined.add(slug); return true; }, leave(slug: string) { return projects.joined.delete(slug); } };
    const profiles: Array<Record<string, string>> = [];
    const settings: Array<Record<string, boolean>> = [];
    const avatarChanges: number[] = [];
    const state = createSlateAgentState({
      agentId: "agent-1",
      agentDir,
      slateRoot,
      memory,
      membership: projects,
      channels: { remove: (platform: string) => platform === "slack" },
      automations,
      workflows: { create: (spec) => { workflows.push({ spec }); return { id: "workflow-1", name: "Release notes" }; }, update: (id, spec) => (id === "workflow-1" ? { id, name: "Release notes" } : null), remove: (id) => id === "workflow-1" },
      readProfile: () => profiles.at(-1) ?? null,
      writeProfile: (profile) => { profiles.push(profile); },
      writeSettings: (value) => { settings.push(value); },
      now: () => 1_000,
      onAvatarChanged: () => { avatarChanges.push(1); },
    });
    return { state, slateRoot, agentDir, facts, projects, profiles, settings, avatarChanges, workflows, created };
  }

  it("remembers where it was told, and refuses a project it cannot reach", async () => {
    const { state, projects, facts } = harness();
    assert.equal((await state.writeMemory({ content: " likes tea ", tier: "profile" })).message, "Remembered in your memory (profile): likes tea");
    // A note is marked as one, so the agent can tell what it chose to write down from what the user said.
    await state.writeMemory({ content: "release day", tier: "note" });
    assert.equal(facts.some((fact) => fact.content === `${MEMORY_NOTE_PREFIX}release day`), true);
    assert.equal((await state.writeMemory({ content: "likes tea", tier: "profile" })).message.startsWith("nothing was saved to your memory"), true);
    assert.equal((await state.writeMemory({ content: "shared fact", tier: "log", scope: "user" })).message, "Remembered in shared user memory (log): shared fact");
    // A project scope needs a slug that exists and that the agent has joined.
    assert.equal((await state.writeMemory({ content: "x", tier: "log", scope: "project" })).message, "'project' (the slug) is required when scope is project.");
    assert.equal((await state.writeMemory({ content: "x", tier: "log", scope: "project", project: "../escape" })).message, '"../escape" is not a valid project slug — use a short kebab-case id.');
    assert.equal((await state.writeMemory({ content: "x", tier: "log", scope: "project", project: "slate" })).message, 'no project "slate" exists yet. Create or join it first (target "project").');
    await state.createProject({ slug: "slate", name: "Slate" });
    projects.joined.delete("slate");
    assert.equal((await state.writeMemory({ content: "x", tier: "log", scope: "project", project: "slate" })).message, 'you haven\'t joined project "slate" yet. Join it first (target "project", action "join").');
    projects.joined.add("slate");
    assert.equal((await state.writeMemory({ content: "project fact", tier: "log", scope: "project", project: "slate" })).message, 'Remembered in project "slate" memory (log): project fact');
    // Forgetting needs the exact wording, and says so when it does not match.
    assert.equal((await state.removeMemory({ content: "likes tea" })).message, "Forgot from your memory: likes tea");
    assert.equal((await state.removeMemory({ content: "likes tea" })).message, "no fact with exactly that text is recorded in your memory. Read or grep the folder for the exact wording first.");
  });

  it("saves, changes and deletes routines and workflows, and says when there is nothing to change", async () => {
    const { state } = harness();
    const saved = await state.createAutomation({ spec: { name: "Nightly" } });
    assert.equal(saved.message.startsWith('Saved routine "Nightly" (folder routine-1) — '), true);
    assert.equal((await state.updateAutomation({ id: "routine-1", spec: {} })).message.startsWith('Updated routine "Nightly"'), true);
    assert.equal((await state.updateAutomation({ id: "missing", spec: {} })).message, 'no routine with folder "missing" exists, or the new fields were invalid.');
    assert.equal((await state.setAutomationEnabled({ id: "routine-1", isEnabled: false })).message, 'Paused routine "Nightly" (folder routine-1).');
    assert.equal((await state.setAutomationEnabled({ id: "routine-1", isEnabled: true })).message, 'Resumed routine "Nightly" (folder routine-1).');
    assert.equal((await state.setAutomationEnabled({ id: "missing", isEnabled: true })).message, 'no routine with folder "missing" exists.');
    assert.equal((await state.deleteAutomation({ id: "routine-1" })).message, 'Deleted routine "Nightly" (folder routine-1).');
    assert.equal((await state.deleteAutomation({ id: "missing" })).message, 'no routine with folder "missing" exists.');
    assert.equal((await state.writeWorkflow({ name: "Release notes", body: "1. Do it" })).message, 'Saved workflow "Release notes" (id workflow-1).');
    assert.equal((await state.writeWorkflow({ id: "workflow-1", name: "Release notes", body: "2. Done" })).message, 'Updated workflow "Release notes" (id workflow-1).');
    assert.equal((await state.writeWorkflow({ id: "missing", name: "x", body: "y" })).message, 'no workflow with id "missing" exists, or the new fields were invalid. Cursor-managed skills cannot be edited.');
    assert.equal((await state.deleteWorkflow({ id: "workflow-1" })).message, "Deleted workflow workflow-1.");
    assert.equal((await state.deleteWorkflow({ id: "missing" })).message, 'no workflow with id "missing" exists, or it is a Cursor-managed skill, which cannot be deleted.');
    // A change that names nothing to change is refused rather than written.
    assert.equal((await state.updateProfile({})).message, "nothing to change — pass at least one of name or description.");
    assert.equal((await state.updateProfile({ name: "   " })).message, "a blank name is not allowed.");
    assert.equal((await state.updateProfile({ name: "  Slate  ", description: " keeps notes " })).message, "Updated your name, description.");
    assert.equal((await state.updateSettings({})).message, "nothing to change — pass at least one setting field.");
    assert.equal((await state.updateSettings({ hiddenFromSidebar: true })).message, "Updated your settings: hiddenFromSidebar.");
    assert.equal((await state.disconnectChannel({ platform: "slack" })).message.startsWith("Disconnected slack."), true);
    assert.equal((await state.disconnectChannel({ platform: "discord" })).message, "discord is not connected.");
  });

  it("creates a project as a join, and refuses a slug that is not one", async () => {
    const { state, slateRoot, projects } = harness();
    assert.equal((await state.createProject({ slug: "../escape", name: "x" })).message, '"../escape" is not a valid project slug — use a short kebab-case id.');
    assert.equal((await state.createProject({ slug: "notes", name: "   " })).message, "a project needs a non-empty name.");
    assert.equal((await state.createProject({ slug: "notes", name: "Notes", description: "where notes live" })).message, 'Created and joined project "Notes" (folder notes).');
    assert.equal(readFileSync(join(slateRoot, "projects", "notes", "project.md"), "utf8").includes("Notes"), true);
    // Creating a project that exists joins it and leaves its own file alone.
    writeFileSync(join(slateRoot, "projects", "notes", "project.md"), "unchanged", "utf8");
    assert.equal((await state.createProject({ slug: "notes", name: "Other" })).message, 'Joined existing project "notes" (create-is-join; project.md left as-is).');
    assert.equal(readFileSync(join(slateRoot, "projects", "notes", "project.md"), "utf8"), "unchanged");
    assert.equal((await state.joinProject({ slug: "nope" })).message, 'no project "nope" exists. Create it first (action "create").');
    assert.equal((await state.leaveProject({ slug: "notes" })).message, 'Left project "notes".');
    assert.equal((await state.leaveProject({ slug: "notes" })).message, 'could not leave project "notes".');
    assert.equal(projects.joined.has("notes"), false);
    assert.equal(readdirSync(join(slateRoot, "projects")).length > 0, true);
  });

  it("installs the picture it was given, and refuses one it cannot use", async () => {
    const { state, agentDir, avatarChanges } = harness();
    const png = join(agentDir, "picture.png");
    const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(png, Buffer.concat([Buffer.from(signature), Buffer.alloc(16)]));
    assert.equal((await state.setAvatar({ path: "  " })).message, "pass the path of an image file to install.");
    assert.equal((await state.setAvatar({ path: join(agentDir, "absent.png") })).message.includes("download or write the image somewhere first"), true);
    // The picture is stored under the name the platform looks for, and whatever was installed before is replaced.
    assert.equal((await state.setAvatar({ path: png })).message, `Updated your picture (${CANONICAL_AVATAR_FILENAME}). Source picture.png can be deleted if you no longer need it.`);
    assert.equal(readFileSync(join(agentDir, CANONICAL_AVATAR_FILENAME)).subarray(0, 4).toString("hex"), "89504e47");
    assert.equal(avatarChanges.length, 1);
    // A file that is not an image, and one larger than the platform keeps, are both refused.
    const text = join(agentDir, "notes.txt");
    writeFileSync(text, "not an image at all");
    assert.equal((await state.setAvatar({ path: text })).message, "that file is not a recognized image (png, jpg, webp, gif, or svg).");
    const huge = join(agentDir, "huge.png");
    writeFileSync(huge, Buffer.concat([Buffer.from(signature), Buffer.alloc(AVATAR_MAX_BYTES)]));
    assert.equal((await state.setAvatar({ path: huge })).message, "the image must be under 5 MB and non-empty.");
    assert.equal(AVATAR_MAX_BYTES, 5 * 1024 * 1024);
    assert.equal((await state.clearAvatar()).message, "Cleared your picture — back to the default.");
    assert.equal(readdirSync(agentDir).includes(CANONICAL_AVATAR_FILENAME), false);
    // With nothing installed there is nothing to clear.
    assert.equal((await state.clearAvatar()).message, "you already have the default picture.");
  });
});

describe("what an accepted send echoes back", () => {
  function transcriptManager(options: { durable?: boolean } = {}) {
    const appended: Array<{ entry: unknown; options: unknown }> = [];
    const persisted: unknown[] = [];
    const activity: unknown[] = [];
    const rosterEmits: Array<{ value: unknown; sessionId?: string }> = [];
    const agentUpdates: string[] = [];
    const clearedTrays: string[] = [];
    const sessionEntries: unknown[] = [];
    let awaiting: unknown = null;
    const session = {
      id: "conversation-1",
      dbPath: join(mkdtempSync(join(tmpdir(), "slate-send-")), "conversation-1.sqlite"),
      db: {
        getTranscriptEntries: () => sessionEntries,
        appendTranscriptEntry: (entry: unknown) => { sessionEntries.push(entry); persisted.push(entry); return options.durable ?? true; },
        getAwaitingUserResponse: () => awaiting,
        setAwaitingUserResponse: (value: unknown) => { awaiting = value; },
      },
    };
    const manager = {
      appendEntry: (entry: unknown, appendOptions: unknown) => { appended.push({ entry, options: appendOptions }); return entry; },
      sessionStore: { markSessionActivity: (target: unknown) => { activity.push(target); } },
      roster: {
        lastKnownAgentNames: new Map<string, string>(),
        emit: (value: unknown, sessionId?: string) => { rosterEmits.push({ value, ...(sessionId === undefined ? {} : { sessionId }) }); },
        emitAgentUpdate: async (sessionId: string) => { agentUpdates.push(sessionId); },
      },
      trayErrors: { clearForAgent: (agentId: string) => { clearedTrays.push(agentId); } },
    };
    return { manager, session, appended, persisted, activity, rosterEmits, agentUpdates, clearedTrays, sessionEntries, setAwaiting: (value: unknown) => { awaiting = value; } };
  }

  it("appends to the transcript on screen, and to the addressed store when it is not", () => {
    const onScreen = transcriptManager();
    const entry = { id: "entry-1", kind: "user-message" };
    const outcomes: boolean[] = [];
    const shown = appendAddressedEcho(onScreen.manager as never, onScreen.session, () => true, () => entry, { onPersistOutcome: (value) => { outcomes.push(value); } });
    // On screen the entry is written before it is emitted, and the caller is told how that went.
    assert.deepEqual(shown, { entry, isOnActiveTranscript: true });
    const options = onScreen.appended[0]?.options as { persistBeforeEmit?: boolean; deferEmit?: boolean; onPersistOutcome?: unknown };
    assert.deepEqual({ persistBeforeEmit: options.persistBeforeEmit, deferEmit: options.deferEmit, reportsOutcome: typeof options.onPersistOutcome === "function" }, { persistBeforeEmit: true, deferEmit: true, reportsOutcome: true });
    assert.equal(onScreen.persisted.length, 0);

    const offScreen = transcriptManager();
    const echoed = appendAddressedEcho(offScreen.manager as never, offScreen.session, () => false, () => entry, { onPersistOutcome: (value) => { outcomes.push(value); } });
    assert.deepEqual(echoed, { entry, isOnActiveTranscript: false });
    assert.deepEqual(offScreen.persisted, [entry]);
    assert.equal(outcomes.at(-1), true);
    // A message that reached the addressed store raises the user-activity signal for that conversation.
    assert.equal(offScreen.activity.length, 1);

    // A send that was not written down is reported rather than answered with an entry that is not there.
    const lost = transcriptManager({ durable: false });
    assert.throws(() => appendAddressedEcho(lost.manager as never, lost.session, () => false, () => entry, { onPersistOutcome: (value) => { outcomes.push(value); } }), SlateSendNotPersistedError);
    assert.equal(outcomes.at(-1), false);
  });

  it("seeds the agent's name from the first message, and clears what the send settled", () => {
    const harness = transcriptManager();
    const profilePath = getSlateProfilePath(join(harness.session.dbPath, ".."));
    mkdirSync(join(harness.session.dbPath, ".."), { recursive: true });
    assert.equal(isSlateDefaultAgentName("New Bot"), true);
    // With nothing said yet and the agent still on its default name, the first message names it.
    const refreshed = applySendRosterSideEffects(harness.manager as never, harness.session, "plan   the   release", () => []);
    assert.equal(refreshed, true);
    assert.equal(readSlateProfileFile(profilePath)?.name, "plan the release");
    assert.equal(harness.manager.roster.lastKnownAgentNames.get("conversation-1"), "plan the release");
    assert.deepEqual(harness.clearedTrays, ["conversation-1"]);
    // Once the agent has its own name, and once the transcript has something in it, nothing is seeded.
    writeFileSync(profilePath, JSON.stringify({ name: "Notes", description: "keeps notes" }), "utf8");
    assert.equal(applySendRosterSideEffects(harness.manager as never, harness.session, "another message", () => []), false);
    assert.equal(readSlateProfileFile(profilePath)?.name, "Notes");
    assert.equal(applySendRosterSideEffects(harness.manager as never, harness.session, "another message", () => [{ id: "entry-0", kind: "user-message" } as never]), false);
    // A send also answers what the conversation was waiting on.
    harness.setAwaiting({ kind: "question" });
    assert.equal(applySendRosterSideEffects(harness.manager as never, harness.session, "answer", () => [{ id: "entry-0", kind: "user-message" } as never]), true);
    assert.equal(harness.session.db.getAwaitingUserResponse(), null);
    // A prompt with nothing in it seeds the name the platform uses for a new conversation; the prompt itself arrives
    // trimmed, which is what the caller passes.
    const fresh = transcriptManager();
    mkdirSync(join(fresh.session.dbPath, ".."), { recursive: true });
    assert.equal(applySendRosterSideEffects(fresh.manager as never, fresh.session, "", () => []), true);
    assert.equal(fresh.manager.roster.lastKnownAgentNames.get("conversation-1"), "New conversation");
  });

  it("echoes what was accepted, and tells the roster about what the user cannot see", () => {
    const harness = transcriptManager();
    const entry = { id: "entry-1", kind: "user-message" };
    emitAcceptedSendEchoes({
      tm: harness.manager as never,
      session: harness.session,
      echoEntries: [{ entry, isOnActiveTranscript: true }],
      isAddressedChatOnScreen: () => true,
      directAddressedAcceptance: false,
      acceptedDurably: true,
      durableAppendStartEpochMs: Date.now(),
      durableAppendStartPerfMs: performance.now(),
      hostReceiptEpochMs: Date.now(),
      hostReceiptPerfMs: performance.now(),
    });
    assert.deepEqual(harness.rosterEmits, [{ value: { type: "appended", entry } }]);
    assert.deepEqual(harness.agentUpdates, []);

    // An entry that landed in a conversation the user has switched away from is announced for that conversation.
    const away = transcriptManager();
    emitAcceptedSendEchoes({
      tm: away.manager as never,
      session: away.session,
      echoEntries: [{ entry, isOnActiveTranscript: true }, { entry: { id: "entry-2", kind: "assistant-message" }, isOnActiveTranscript: false }],
      isAddressedChatOnScreen: () => false,
      directAddressedAcceptance: true,
      acceptedDurably: true,
      durableAppendStartEpochMs: Date.now(),
      durableAppendStartPerfMs: performance.now(),
      hostReceiptEpochMs: Date.now(),
      hostReceiptPerfMs: performance.now(),
    });
    assert.deepEqual(away.rosterEmits.map((emit) => emit.sessionId ?? "screen"), ["conversation-1", "conversation-1"]);
    assert.deepEqual(away.agentUpdates, ["conversation-1"]);

    // What was measured about the append and the acknowledgement is reported to the platform's own spans.
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    setSendAcceptanceCompletedSpanRecorder((span, definition) => {
      void span;
      spans.push({ name: "recorded", attributes: definition.attributes as Record<string, unknown> });
    });
    try {
      const traced = transcriptManager();
      emitAcceptedSendEchoes({
        tm: traced.manager as never,
        session: traced.session,
        echoEntries: [{ entry, isOnActiveTranscript: true }],
        isAddressedChatOnScreen: () => true,
        directAddressedAcceptance: false,
        clientNonce: "nonce-1",
        traceCtx: { withName: () => ({ setAttribute: () => {} }) },
        sendTrace: { span: { setAttribute: () => {} } },
        acceptedDurably: true,
        durableAppendStartEpochMs: Date.now(),
        durableAppendStartPerfMs: performance.now(),
        hostReceiptEpochMs: Date.now(),
        hostReceiptPerfMs: performance.now(),
      });
      assert.equal(spans.length, 2);
      assert.equal(spans[0]?.attributes["slate.client_nonce"], "nonce-1");
      assert.equal(spans[0]?.attributes["slate.durable"], true);
      assert.equal(spans[0]?.attributes["slate.conversation_id"], "conversation-1");
      assert.equal(typeof spans[0]?.attributes["slate.durable_append_ms"], "number");
      assert.equal(typeof spans[1]?.attributes["slate.ack_emit_host_ms"], "number");
      // A recorder that throws does not stop the send from being echoed.
      setSendAcceptanceCompletedSpanRecorder(() => { throw new Error("recorder failed"); });
      const surviving = transcriptManager();
      emitAcceptedSendEchoes({
        tm: surviving.manager as never,
        session: surviving.session,
        echoEntries: [{ entry, isOnActiveTranscript: true }],
        isAddressedChatOnScreen: () => true,
        directAddressedAcceptance: false,
        traceCtx: { withName: () => ({ setAttribute: () => {} }) },
        acceptedDurably: true,
        durableAppendStartEpochMs: Date.now(),
        durableAppendStartPerfMs: performance.now(),
        hostReceiptEpochMs: Date.now(),
        hostReceiptPerfMs: performance.now(),
      });
      assert.equal(surviving.rosterEmits.length, 1);
    } finally {
      setSendAcceptanceCompletedSpanRecorder(undefined);
    }
  });
});

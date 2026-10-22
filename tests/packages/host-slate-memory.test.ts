import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as memory from "../../source/host/runner/slate-memory.ts";

// ---------------------------------------------------------------------------------------------
// constants and switches
// ---------------------------------------------------------------------------------------------

describe("the memory constants and the switches around them", () => {
  it("publishes the budgets, limits and markers the rest of the host plans with", () => {
    assert.deepEqual([
      memory.MEMORY_RECENT_PROMPT_LIMIT,
      memory.MEMORY_RECENT_PROMPT_CHAR_BUDGET,
      memory.MEMORY_PROFILE_PROMPT_LIMIT,
      memory.MEMORY_UI_LIMIT,
      memory.MEMORY_MAX_CONTENT_LENGTH,
      memory.MEMORY_EXTRACTION_ARCHIVE_SCAN_LIMIT,
    ], [30, 4_000, 100, 1_000, 500, 500]);
    assert.deepEqual([
      memory.MEMORY_EXTRACTION_PROMPT_MARKER,
      memory.MEMORY_EPISODE_PROMPT_MARKER,
      memory.MEMORY_EPISODE_PREFIX,
      memory.MEMORY_NOTE_PREFIX,
      memory.MEMORY_EXTRACTION_NONE_SENTINEL,
    ], ["<<SLATE_MEMORY_EXTRACTION>>", "<<SLATE_MEMORY_EPISODE>>", "[episode] ", "[note] ", "NONE"]);
    assert.deepEqual([
      memory.DEFAULT_EPISODE_INTERVAL,
      memory.MEMORY_USER_PROFILE_PROMPT_LIMIT,
      memory.MEMORY_USER_RECENT_PROMPT_LIMIT,
      memory.MEMORY_PROJECT_PROFILE_PROMPT_LIMIT,
      memory.MEMORY_PROJECT_RECENT_PROMPT_LIMIT,
      memory.MEMORY_PROJECT_INJECTED_CAP,
      memory.MEMORY_DECAY_HALF_LIFE_DAYS,
      memory.DAY_MS,
    ], [6, 50, 15, 25, 10, 3, 30, 86_400_000]);
  });

  it("freezes memory unless the deployment opted out, and reads its interval only when it is a number", () => {
    assert.equal(memory.isMemoryFreezeEnabled({}), true);
    assert.equal(memory.isMemoryFreezeEnabled({ SLATE_DISABLE_MEMORY_FREEZE: "1" }), false);
    assert.equal(memory.isMemoryFreezeEnabled({ SLATE_DISABLE_MEMORY_FREEZE: "0" }), true);
    assert.equal(memory.getEpisodeInterval({}), memory.DEFAULT_EPISODE_INTERVAL);
    assert.equal(memory.getEpisodeInterval({ SLATE_MEMORY_EPISODE_INTERVAL: " 7 " }), 7);
    assert.equal(memory.getEpisodeInterval({ SLATE_MEMORY_EPISODE_INTERVAL: "0" }), memory.DEFAULT_EPISODE_INTERVAL);
    assert.equal(memory.getEpisodeInterval({ SLATE_MEMORY_EPISODE_INTERVAL: "-2" }), memory.DEFAULT_EPISODE_INTERVAL);
    assert.equal(memory.getEpisodeInterval({ SLATE_MEMORY_EPISODE_INTERVAL: "twelve" }), memory.DEFAULT_EPISODE_INTERVAL);
    assert.equal(memory.getEpisodeInterval({ SLATE_MEMORY_EPISODE_INTERVAL: "3.9" }), 3);
  });

  it("reuses a frozen memory only for the compaction it belongs to", () => {
    let liveCalls = 0;
    const live = () => { liveCalls += 1; return { render: "live", hasFacts: true }; };
    assert.deepEqual(memory.resolveFrozenMemoryPrompt({ snapshot: { render: "frozen", compactionEpoch: 4 }, compactionEpoch: 4, renderLive: live }), { render: "frozen" });
    assert.equal(liveCalls, 0, "a snapshot at this epoch is not re-rendered");
    assert.deepEqual(memory.resolveFrozenMemoryPrompt({ snapshot: { render: "frozen", compactionEpoch: 3 }, compactionEpoch: 4, renderLive: live }), { render: "live", snapshotToPersist: { render: "live", compactionEpoch: 4 } });
    assert.equal(liveCalls, 1);
    assert.deepEqual(memory.resolveFrozenMemoryPrompt({ compactionEpoch: 4, renderLive: () => ({ render: "", hasFacts: false }) }), { render: "" }, "an empty render is not worth freezing");
  });
});

// ---------------------------------------------------------------------------------------------
// facts: memorable, normalized, ranked, dated
// ---------------------------------------------------------------------------------------------

describe("a remembered fact", () => {
  it("is only worth extracting from an exchange that says something", () => {
    for (const greeting of ["", "   ", "hi", "HI!", "thanks", "Thank you.", "ok", "got it", "cool!", "bye", "np", "lol", "yes", "nope"]) {
      assert.equal(memory.isMemorableExchange(greeting), false, JSON.stringify(greeting));
    }
    assert.equal(memory.isMemorableExchange("hello, can you help?"), true, "a question is memorable");
    assert.equal(memory.isMemorableExchange("literal" + "x".repeat(40)), true, "a long message is memorable");
    assert.equal(memory.isMemorableExchange("we decided to move the launch to March"), true);
  });

  it("is stored as one trimmed line, at most the content limit long", () => {
    assert.equal(memory.normalizeMemoryContent("  the   user\nlikes\ttea  "), "the user likes tea");
    assert.equal(memory.normalizeMemoryContent("x".repeat(600)).length, memory.MEMORY_MAX_CONTENT_LENGTH);
    assert.equal(memory.memoryDedupeKey("The User Likes TEA"), memory.memoryDedupeKey("the user likes tea"));
  });

  it("counts episodes first and notes last, and ages in half-life windows", () => {
    assert.equal(memory.memoryImportance("[episode] a trip"), 1.5);
    assert.equal(memory.memoryImportance("[note] a small thing"), 0.5);
    assert.equal(memory.memoryImportance("a plain fact"), 1);
    assert.equal(memory.memoryImportance({ content: "[episode] record", createdAt: 1 }), 1.5);
    assert.equal(memory.formatMemoryDate(0), "unknown date");
    assert.equal(memory.formatMemoryDate(Number.NaN), "unknown date");
    assert.equal(memory.formatMemoryDate(1_600_000_000_000), "2020-09-13");
    assert.equal(memory.factLine({ content: "likes tea", createdAt: 1_600_000_000_000 }), "- (learned 2020-09-13) likes tea");
    assert.equal(memory.memoryRecallRank({ content: "x", createdAt: 0 }), 0, "an ordinary fact at the epoch ranks at zero");
    assert.equal(memory.memoryRecallRank({ content: "[episode] x", createdAt: 0 }), 0.5849625007211562, "an episode ranks at log2(1.5)");
  });
});

// ---------------------------------------------------------------------------------------------
// the prompts
// ---------------------------------------------------------------------------------------------

describe("the memory prompts", () => {
  it("renders the agent's own memory, with its folder and a bounded history", () => {
    assert.equal(memory.renderMemorySystemPrompt({ profile: [], recent: [] }), "");
    assert.match(memory.renderMemorySystemPrompt({ profile: [], recent: [] }, "/memory"), /No facts recorded yet\./);
    assert.match(memory.renderMemorySystemPrompt({ profile: [], recent: [] }, "/memory"), /Your memory lives in a folder at \/memory: profile\.md/);
    const rendered = memory.renderMemorySystemPrompt({ profile: [{ content: "likes tea", createdAt: 1_600_000_000_000, kind: "profile" }], recent: [{ content: "a recent fact", createdAt: 1_600_000_000_000 }] }, "/memory");
    assert.match(rendered, /About the user:\n- \(learned 2020-09-13\) likes tea/);
    assert.match(rendered, /Recently:\n- \(learned 2020-09-13\) a recent fact/);
    const flat = memory.renderMemorySystemPrompt([{ content: "kept", createdAt: 1_600_000_000_000, kind: "profile" }, { content: "logged", createdAt: 1_600_000_000_000 }], "/m");
    assert.match(flat, /About the user:\n- \(learned 2020-09-13\) kept/);
    assert.match(flat, /Recently:\n- \(learned 2020-09-13\) logged/);
  });

  it("stops a long history at the character budget and counts the rest", () => {
    const recent = Array.from({ length: 40 }, (_, index) => ({ content: "fact " + index + " " + "x".repeat(200), createdAt: 1_600_000_000_000 + index }));
    const withoutFolder = memory.renderMemorySystemPrompt({ profile: [], recent });
    assert.match(withoutFolder, /\(\d+ more log facts not shown\.\)/);
    const withFolder = memory.renderMemorySystemPrompt({ profile: [], recent }, "/memory");
    assert.match(withFolder, /\(\d+ more log facts on disk \u2014 grep the log\/ folder for them\.\)/);
  });

  it("asks for extraction with the categories, the supersede rule and the NONE sentinel", () => {
    const system = memory.buildExtractionSystemPrompt();
    assert.equal(system.startsWith(memory.MEMORY_EXTRACTION_PROMPT_MARKER + "\n"), true);
    assert.match(system, /"profile":/);
    assert.match(system, /"log":/);
    assert.match(system, /"note":/);
    assert.match(system, /output a line "remove: <the exact existing fact text>"/);
    assert.match(system, /Output exactly NONE \(and nothing else\)/);
    assert.equal(memory.buildExtractionUserPrompt("  hello  ", "  hi  ", ["one", "two"]), "Existing memory:\n- one\n- two\n\nLatest exchange:\nUser: hello\nAssistant: hi");
    assert.equal(memory.buildExtractionUserPrompt("", ""), "Existing memory:\n(empty)\n\nLatest exchange:\nUser: (no message)\nAssistant: (no message)");
  });

  it("asks an episode for one dated sentence", () => {
    const system = memory.buildEpisodeSystemPrompt();
    assert.match(system, /named Slate\./);
    assert.match(system, /ONE short journal-style sentence/);
    assert.match(system, /Output exactly NONE/);
    assert.equal(memory.buildEpisodeUserPrompt([{ ts: 1_600_000_000_000, user: "hello", agent: "hi" }, { ts: 1_600_000_000_000, user: "", agent: "only the answer" }]), "Recent turns, oldest first:\n\n(2020-09-13)\nUser: hello\nSlate: hi\n\n(2020-09-13)\nSlate: only the answer");
  });
});

// ---------------------------------------------------------------------------------------------
// reading a model's answer back into facts
// ---------------------------------------------------------------------------------------------

describe("an extraction answer", () => {
  it("reads tagged facts, bullets, removals and notes", () => {
    const parsed = memory.parseExtractedMemories("profile: the user's name is Ian\n- log: planning a Tokyo trip\n1. note: prefers short answers\nremove: an old fact");
    assert.deepEqual(parsed.additions, [
      { content: "the user's name is Ian", kind: "profile" },
      { content: "planning a Tokyo trip", kind: "log" },
      { content: "[note] prefers short answers", kind: "log" },
    ]);
    assert.deepEqual(parsed.removals, ["an old fact"]);
  });

  it("reads nothing from an empty answer, the sentinel, or facts it already knows", () => {
    assert.deepEqual(memory.parseExtractedMemories(""), { additions: [], removals: [] });
    assert.deepEqual(memory.parseExtractedMemories("  none "), { additions: [], removals: [] });
    assert.deepEqual(memory.parseExtractedMemories("Remove: NONE"), { additions: [], removals: [] });
    assert.deepEqual(memory.parseExtractedMemories("profile: THE USER LIKES TEA", ["the user likes tea"]), { additions: [], removals: [] }, "a known fact is not added twice");
    assert.deepEqual(memory.parseExtractedMemories("profile: x\nprofile: X"), { additions: [{ content: "x", kind: "profile" }], removals: [] }, "a repeated fact is added once");
    assert.deepEqual(memory.parseExtractedMemories("unknown line"), { additions: [{ content: "unknown line", kind: "log" }], removals: [] }, "an untagged line is read as a fact body and lands in the log tier");
    assert.equal(memory.parseExtractedMemories("profile: " + "y".repeat(600)).additions[0]?.content.length, memory.MEMORY_MAX_CONTENT_LENGTH, "the content limit applies");
    assert.equal(memory.parseExtractedMemories("profile: one").additions[0]?.kind, "profile");
  });

  it("collects the recall and only the most relevant archived facts", () => {
    const recall = { profile: [{ content: "shared fact", createdAt: 1 }], recent: [] };
    const archive = [{ content: "shared fact", createdAt: 2 }, { content: "a tokyo archive note", createdAt: 3 }, { content: "unrelated", createdAt: 4 }];
    assert.deepEqual(memory.gatherExtractionMemories(recall, archive, "tokyo"), ["shared fact", "a tokyo archive note"]);
    assert.deepEqual(memory.gatherExtractionMemories({ profile: [], recent: [] }, [], "tokyo"), []);
    const matchingDuplicate = memory.gatherExtractionMemories({ profile: [{ content: "shared tokyo fact", createdAt: 1 }], recent: [] }, [{ content: "shared tokyo fact", createdAt: 2 }, { content: "another tokyo note", createdAt: 3 }], "tokyo");
    assert.deepEqual(matchingDuplicate, ["shared tokyo fact", "another tokyo note"], "an archived fact the prompt already carries is not offered twice");
  });
});

describe("choosing the facts a query is about", () => {
  const memories = [
    { content: "planning a trip to Tokyo in October", createdAt: 10 },
    { content: "the user's name is Ian", createdAt: 20 },
    { content: "another tokyo note", createdAt: 15 },
    { content: "UPPERCASE TOKYO", createdAt: 25 },
    { content: "the project uses TypeScript", createdAt: 5 },
  ];

  it("ranks by shared words and takes both argument orders", () => {
    const first = memory.selectRelevantMemories("tokyo", memories, 2);
    assert.deepEqual(first.map(memoryRecord => memoryRecord.content), ["UPPERCASE TOKYO", "another tokyo note"], "ties go to the newest fact");
    assert.deepEqual(memory.selectRelevantMemories(memories, "tokyo", 2).map(memoryRecord => memoryRecord.content), ["UPPERCASE TOKYO", "another tokyo note"]);
    assert.deepEqual(memory.selectRelevantMemories("a", memories, 5), [], "words under four letters are not matched on");
    assert.deepEqual(memory.selectRelevantMemories("nothing here", memories, 5), []);
    assert.deepEqual(memory.selectRelevantMemories("tokyo", memories, 0), []);
    assert.deepEqual(memory.selectRelevantMemories("name", memories, 5).map(memoryRecord => memoryRecord.content), ["the user's name is Ian"], "a word over four letters matches");
    assert.deepEqual(memory.selectRelevantMemories("that this with them", memories, 5), [], "stopwords do not match");
  });
});

// ---------------------------------------------------------------------------------------------
// applying an extraction and reading executors
// ---------------------------------------------------------------------------------------------

describe("applying what the model asked for", () => {
  it("drops superseded facts and adds the new ones to a list", () => {
    const existing = [{ id: "a", content: "keep this", createdAt: 1, kind: "profile" }, { id: "b", content: "drop this", createdAt: 2, kind: "log" }];
    const next = memory.applyExtractedMemories(existing as never, { additions: [{ content: "new fact", kind: "log" }, { content: "KEEP THIS", kind: "profile" }], removals: ["DROP THIS", "not there"] }, 1234);
    assert.deepEqual(next, [
      { id: "a", content: "keep this", createdAt: 1, kind: "profile" },
      { id: "memory-1234-1", content: "new fact", createdAt: 1234, kind: "log" },
    ]);
  });

  it("answers what a store actually removed and added", () => {
    const removed: string[] = [];
    const added: Array<{ content: string; now: number; kind: string }> = [];
    const store = {
      removeMemoryByContent(content: string) { if (content !== "old") return false; removed.push(content); return true; },
      addMemory(content: string, now: number, kind: "profile" | "log") { added.push({ content, now, kind }); return { id: "made", content, createdAt: now, kind }; },
    };
    const outcome = memory.applyExtractedMemories(store as never, { additions: [{ content: "fresh", kind: "profile" }], removals: ["old", "gone"] }, 77, ["old", "gone"]);
    assert.deepEqual(removed, ["old"], "a fact the store could not remove is not reported as removed");
    assert.deepEqual(added, [{ content: "fresh", now: 77, kind: "profile" }]);
    assert.deepEqual(outcome, { added: [{ id: "made", content: "fresh", createdAt: 77, kind: "profile" }], removed: ["old"] });
  });

  it("reads an executor's text and raises its errors", async () => {
    const streamOf = (parts: Array<{ type: string; textDelta?: string; error?: unknown }>) => ({
      stream: () => ({ fullStream: (async function* () { for (const part of parts) yield part; })() }),
    });
    assert.equal(await memory.collectExecutorText(streamOf([{ type: "text-delta", textDelta: "a" }, { type: "text-delta", textDelta: "b" }, { type: "tool-call" }]) as never, {}), "ab");
    await assert.rejects(() => memory.collectExecutorText(streamOf([{ type: "error", error: new Error("boom") }]) as never, {}), { message: "boom" });
    await assert.rejects(() => memory.collectExecutorText(streamOf([{ type: "error", error: "boom" }]) as never, {}), { message: "boom" });
  });

  it("extracts through an executor or through a given execute function", async () => {
    const appended: unknown[][] = [];
    const executor = {
      appendMessages(messages: readonly unknown[]) { appended.push([...messages]); },
      clearMessages() {}, getMessages: () => [], getState: () => ({}),
      stream: () => ({ fullStream: (async function* () { yield { type: "text-delta", textDelta: "profile: likes tea" }; })() }),
    };
    const fromExecutor = await memory.extractMemories({ executor: executor as never, ctx: {}, userMessage: "I like tea", agentMessage: "noted", existingMemories: [] });
    assert.deepEqual(fromExecutor.additions, [{ content: "likes tea", kind: "profile" }]);
    assert.equal(appended.length, 1, "the prompt is sent through the executor");
    const fromExecute = await memory.extractMemories("about tea", async (system: string, user: string) => {
      assert.equal(system, memory.buildExtractionSystemPrompt());
      assert.match(user, /User: about tea/);
      return "log: a tea note";
    });
    assert.deepEqual(fromExecute.additions, [{ content: "a tea note", kind: "log" }]);
    assert.deepEqual(await memory.extractMemories("anything", async () => "NONE"), { additions: [], removals: [] });
  });

  it("writes an episode only when the answer names one", async () => {
    const withText = (text: string) => ({
      appendMessages() {}, clearMessages() {}, getMessages: () => [], getState: () => ({}),
      stream: () => ({ fullStream: (async function* () { if (text.length > 0) yield { type: "text-delta", textDelta: text }; })() }),
    });
    assert.equal(await memory.summarizeEpisode({ executor: withText("  a  narrative  ") as never, ctx: {}, turns: [{ ts: 1, user: "u", agent: "a" }] }), "a narrative");
    assert.equal(await memory.summarizeEpisode({ executor: withText("NONE") as never, ctx: {}, turns: [{ ts: 1, user: "u", agent: "a" }] }), null);
    assert.equal(await memory.summarizeEpisode({ executor: withText("") as never, ctx: {}, turns: [{ ts: 1, user: "u", agent: "a" }] }), null);
    assert.equal(await memory.summarizeEpisode({ executor: withText("ignored") as never, ctx: {}, turns: [] }), null);
  });
});

// ---------------------------------------------------------------------------------------------
// the shared and project tiers
// ---------------------------------------------------------------------------------------------

describe("the tiers shared across assistants and projects", () => {
  it("merges shards with the newest fact per text and the tier's limits", () => {
    const merged = memory.mergeUserMemoryShards([
      { via: "a", recall: { profile: [{ content: "same", createdAt: 1 }], recent: [{ content: "old", createdAt: 1 }] } },
      { via: "b", recall: { profile: [{ content: "Same", createdAt: 9 }], recent: [{ content: "[episode] an episode", createdAt: 2 }] } },
    ], { profileLimit: 5, recentLimit: 5 });
    assert.deepEqual(merged.profile, [{ content: "Same", createdAt: 9, via: "b" }]);
    assert.deepEqual(merged.recent.map(record => record.content), ["[episode] an episode", "old"], "an episode outranks a plain fact of the same age bracket");
    assert.deepEqual(memory.mergeUserMemoryShards([], { profileLimit: 1, recentLimit: 1 }), { profile: [], recent: [] });
    assert.deepEqual(memory.mergeUserMemoryShards([{ via: "a", recall: { profile: [{ content: "p1", createdAt: 1 }, { content: "p2", createdAt: 2 }], recent: [] } }], { profileLimit: -1, recentLimit: 1 }).profile, [], "a negative limit keeps nothing");
  });

  it("renders shared user memory only with a folder, bounded and tagged by source", () => {
    assert.equal(memory.renderUserMemorySystemPrompt({ profile: [], recent: [] }, {}), "");
    const empty = memory.renderUserMemorySystemPrompt({ profile: [], recent: [] }, { userMemoryDir: "/shared" });
    assert.match(empty, /No shared facts recorded yet\./);
    const filled = memory.renderUserMemorySystemPrompt({
      profile: [{ content: "likes tea", createdAt: 1_600_000_000_000, via: "assistant-a" }],
      recent: [{ content: "a recent fact", createdAt: 1_600_000_000_000, via: "  " }],
    }, { userMemoryDir: "/shared", ownShardDir: "/shared/own" });
    assert.match(filled, /Your own shard is at \/shared\/own/);
    assert.match(filled, /Shared facts are tagged \[via <assistant>\]/);
    assert.match(filled, /About the user \(shared\):\n- \(learned 2020-09-13\) \[via assistant-a\] likes tea/);
    assert.match(filled, /Recently \(shared\):\n- \(learned 2020-09-13\) a recent fact/);
  });

  it("orders project blocks by facts, freshness and slug, and says which are only joined", () => {
    const block = (slug: string, profile: unknown[], recent: unknown[]) => ({ slug, name: slug.toUpperCase(), recall: { profile, recent } });
    const withFact = (content: string, createdAt: number) => ({ content, createdAt, via: "a" });
    const selection = memory.selectProjectMemoryBlocks([
      block("alpha", [], []),
      block("beta", [withFact("b", 10)], []),
      block("gamma", [], [withFact("g", 20)]),
      block("delta", [withFact("d1", 5)], [withFact("d2", 7)]),
      block("epsilon", [withFact("e", 100)], []),
      block("alpha2", [withFact("a2", 50)], []),
    ] as never, 3);
    assert.deepEqual(selection.injected.map(project => project.slug), ["epsilon", "alpha2", "gamma"], "projects with facts first, then the freshest");
    assert.deepEqual(selection.alsoMemberOf.map(project => project.slug), ["beta", "delta", "alpha"]);
    assert.equal(memory.projectMemoryHasFacts({ injected: [block("a", [], [])] } as never), false);
    assert.equal(memory.projectMemoryHasFacts({ injected: [block("a", [withFact("x", 1)], [])] } as never), true);
    assert.deepEqual(memory.selectProjectMemoryBlocks([block("a", [], [])] as never, 0), { injected: [], alsoMemberOf: [{ slug: "a", name: "A" }] });
    assert.deepEqual(memory.selectProjectMemoryBlocks([block("a", [], [])] as never, Number.NaN).injected, []);
    const fractional = memory.selectProjectMemoryBlocks([block("a", [], []), block("b", [], []), block("c", [], [])] as never, 2.9);
    assert.deepEqual(fractional.injected.map(project => project.slug), ["a", "b"], "a fractional cap is floored");
  });

  it("renders project memory with the project's own shard and bounded facts", () => {
    const record = { content: "a project fact", createdAt: 1_600_000_000_000, via: "a" };
    const block = { slug: "proj", name: "Project", ownShardDir: "/projects/proj/shard", recall: { profile: [record], recent: [] } };
    assert.equal(memory.renderProjectMemorySystemPrompt({ injected: [], alsoMemberOf: [] }, {}), "");
    const rendered = memory.renderProjectMemorySystemPrompt({ injected: [block] as never, alsoMemberOf: [{ slug: "other", name: "Other" }] }, { projectsRootDir: "/projects" });
    assert.match(rendered, /Projects live under \/projects/);
    assert.match(rendered, /Project "Project" \(proj\) \u2014 your shard: \/projects\/proj\/shard:/);
    assert.match(rendered, /About this project \(shared\):\n- \(learned 2020-09-13\) \[via a\] a project fact/);
    assert.match(rendered, /Also a member of: Other \(other\) \u2014 grep those project folders for their memory\./);
    const empty = memory.renderProjectMemorySystemPrompt({ injected: [{ slug: "p", name: "P", recall: { profile: [], recent: [] } }] as never, alsoMemberOf: [] }, { projectsRootDir: "/projects" });
    assert.match(empty, /No shared facts recorded yet for this project\./);
  });
});

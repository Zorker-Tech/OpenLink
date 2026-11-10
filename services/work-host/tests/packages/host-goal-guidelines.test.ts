import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildGoalPursuitGuidelines } from "../../source/packages/agent-core/goal-guidelines.ts";

describe("what a goal pursued across turns is told", () => {
  it("says that stopping is not finishing, and that the objective does not shrink", () => {
    const guidelines = buildGoalPursuitGuidelines();
    assert.match(guidelines, /^Continuation behavior:/);
    assert.match(guidelines, /Ending this turn does not require shrinking the objective/);
    assert.match(guidelines, /do not redefine success around a smaller or easier task/);
  });

  it("says to work from the current state rather than from memory", () => {
    assert.match(buildGoalPursuitGuidelines(), /Use the current working tree and external state as authoritative/);
  });

  it("names the todo tool when the environment has one, and describes the plan without it", () => {
    const named = buildGoalPursuitGuidelines({ todoWriteToolName: "TodoWrite" });
    assert.match(named, /If TodoWrite is available/);
    const unnamed = buildGoalPursuitGuidelines();
    assert.equal(unnamed.includes("If TodoWrite is available"), false);
    assert.match(unnamed, /keep a concise plan tied to the real objective/);
  });

  it("names the goal tool when the environment has one, and still refuses a false completion without it", () => {
    const named = buildGoalPursuitGuidelines({ updateGoalToolName: "UpdateGoal" });
    assert.match(named, /call UpdateGoal with status "complete"/);
    assert.match(named, /Do not call UpdateGoal unless the goal is complete/);
    const unnamed = buildGoalPursuitGuidelines();
    assert.equal(unnamed.includes("UpdateGoal"), false);
    assert.match(unnamed, /Do not mark a goal complete merely because you are stopping work\.$/);
  });

  it("carries the completion audit, which asks for evidence rather than intent", () => {
    const guidelines = buildGoalPursuitGuidelines();
    assert.match(guidelines, /Completion audit:/);
    assert.match(guidelines, /treat completion as unproven and verify it against the actual current state/);
    assert.match(guidelines, /The audit must prove completion, not merely fail to find obvious remaining work\./);
  });

  it("is the same text whatever order the sections were written in, and ends with the goal guidance", () => {
    const guidelines = buildGoalPursuitGuidelines({ todoWriteToolName: "TodoWrite", updateGoalToolName: "UpdateGoal" });
    const order = ["Continuation behavior:", "Work from evidence:", "Progress visibility:", "Fidelity:", "Completion audit:"];
    const positions = order.map((heading) => guidelines.indexOf(heading));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "the sections are in order");
    assert.equal(guidelines.endsWith('Do not mark a goal complete merely because you are stopping work.'), true);
    assert.equal(guidelines.includes("  "), false, "no doubled spaces where the sections meet");
    // Every section but the first starts after a blank line, which is how the prompt is read.
    for (const heading of order.slice(1)) assert.equal(guidelines.includes(`\n\n${heading}`), true, heading);
  });
});

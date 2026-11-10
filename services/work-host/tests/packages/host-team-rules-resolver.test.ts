import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTeamRulesResolverFromLoad, type RulesAnswer } from "../../source/shared/team-rules.ts";

/** A load that answers with what it is told, and counts how many times it was asked. */
function loader<Answers extends readonly RulesAnswer<string>[]>(...answers: Answers) {
  const asked: string[] = [];
  let index = 0;
  return {
    asked,
    load: async (): Promise<RulesAnswer<string>> => {
      asked.push(`load ${asked.length + 1}`);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer ?? { outcome: "incomplete" };
    },
  };
}

/** Lets every queued promise and one timer run, so a load that could have started has. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1));

/** A resolver over a loader, with the failures it reports collected. */
function resolver(load: () => Promise<RulesAnswer<string>>, onFailures: unknown[] = []) {
  return createTeamRulesResolverFromLoad({ load, reportLoadFailure: (error) => onFailures.push(error) });
}

describe("the rules an organization set", () => {
  it("are answered from the load, once", async () => {
    const { load, asked } = loader({ outcome: "rules", rules: ["a", "b"] });
    const rules = resolver(load);
    assert.deepEqual(await rules.resolveRules(), ["a", "b"]);
    assert.deepEqual(await rules.resolveRules(), ["a", "b"]);
    assert.equal(asked.length, 1, "the answer is remembered");
  });

  it("are empty for a team that has none", async () => {
    const { load } = loader({ outcome: "no_team" });
    assert.deepEqual(await resolver(load).resolveRules(), []);
  });

  it("are unknown when the answer could not be read, which is not the same as none", async () => {
    const { load } = loader({ outcome: "incomplete" });
    assert.equal(await resolver(load).resolveRules(), undefined);
  });

  it("are shared by two callers asking at the same time", async () => {
    const { load, asked } = loader({ outcome: "rules", rules: ["a"] });
    const rules = resolver(load);
    const [first, second] = await Promise.all([rules.resolveRules(), rules.resolveRules()]);
    assert.deepEqual([first, second], [["a"], ["a"]]);
    assert.equal(asked.length, 1);
  });
});

describe("a load that fails", () => {
  it("is reported rather than thrown at whoever asked for rules", async () => {
    const failures: unknown[] = [];
    const rules = resolver(async () => {
      throw new Error("the network is down");
    }, failures);
    assert.equal(await rules.resolveRules(), undefined);
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as Error).message, "the network is down");
  });

  it("leaves what was already known alone", async () => {
    let answer: RulesAnswer<string> = { outcome: "rules", rules: ["kept"] };
    const failures: unknown[] = [];
    const rules = resolver(async () => {
      if (answer === undefined) throw new Error("no");
      return answer;
    }, failures);
    assert.deepEqual(await rules.resolveRules(), ["kept"]);
    answer = { outcome: "incomplete" };
    rules.refresh();
    await settle();
    assert.deepEqual(await rules.resolveRules(), ["kept"], "an incomplete answer does not empty what was known");
  });
});

describe("starting and refreshing", () => {
  it("starts a load without waiting for it", async () => {
    const { load, asked } = loader({ outcome: "rules", rules: ["a"] });
    const rules = resolver(load);
    rules.start();
    await settle();
    assert.equal(asked.length, 1);
    assert.deepEqual(await rules.resolveRules(), ["a"]);
    assert.equal(asked.length, 1, "and the answer is the one the start fetched");
  });

  it("refreshes by loading again after the load it follows has finished", async () => {
    const { load, asked } = loader({ outcome: "rules", rules: ["first"] }, { outcome: "rules", rules: ["second"] });
    const rules = resolver(load);
    rules.start();
    rules.refresh();
    await settle();
    assert.equal(asked.length, 2, "a refresh is a second load, not a second caller of the first");
    assert.deepEqual(await rules.resolveRules(), ["second"]);
  });

  it("refreshes even when nothing had started", async () => {
    const { load, asked } = loader({ outcome: "rules", rules: ["only"] });
    const rules = resolver(load);
    rules.refresh();
    await settle();
    assert.equal(asked.length, 1);
    assert.deepEqual(await rules.resolveRules(), ["only"]);
  });
});

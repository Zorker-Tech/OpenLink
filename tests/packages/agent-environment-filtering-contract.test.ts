import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentType } from "../../source/packages/agent/utils/agent-config.ts";
import { filterItemsForRunEnvironment } from "../../source/packages/agent/utils/environment-filtering.ts";

test("unscoped and bug-report runs receive the original item list", () => {
  const items = [
    { name: "everywhere" },
    { name: "cloud", environments: ["cloud"] },
    { name: "local", environments: ["local"] },
  ];
  assert.equal(filterItemsForRunEnvironment(items), items);
  assert.equal(filterItemsForRunEnvironment(items, AgentType.BUGBOT), items);
});

test("background runs include cloud-eligible items and honor explicit refusals", () => {
  const items = [
    { name: "everywhere" },
    { name: "cloud", environments: ["cloud"] },
    { name: "local", environments: ["local"] },
    { name: "refused", disabledEnvironments: ["cloud"] },
    { name: "both", environments: ["cloud"], disabledEnvironments: ["cloud"] },
  ];
  assert.deepEqual(
    filterItemsForRunEnvironment(items, AgentType.BACKGROUND).map((item) => item.name),
    ["everywhere", "cloud"],
  );
});

test("editor and command-line runs use the local environment rules", () => {
  const items = [
    { name: "everywhere" },
    { name: "cloud", environments: ["cloud"] },
    { name: "local", environments: ["local"] },
  ];
  for (const agentType of [AgentType.IDE, AgentType.CLI]) {
    assert.deepEqual(
      filterItemsForRunEnvironment(items, agentType).map((item) => item.name),
      ["everywhere", "local"],
    );
  }
});

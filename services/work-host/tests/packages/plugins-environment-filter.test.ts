import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterByEnvironment, type EnvironmentScopedItem } from "../../source/packages/plugins/environment-filter.ts";

const CLOUD = "cloud";
const LOCAL = "local";

describe("filtering items by the environment a run happens in", () => {
  it("keeps an item that asks for nothing everywhere", () => {
    const items = [{}, { environments: [] }, { disabledEnvironments: [] }];
    for (const target of [CLOUD, LOCAL, "anywhere"]) assert.deepEqual(filterByEnvironment(items, target), items);
  });

  it("keeps an item whose requested environments include the current one", () => {
    const cloudOnly = { environments: [CLOUD] };
    const localOnly = { environments: [LOCAL] };
    assert.deepEqual(filterByEnvironment([cloudOnly, localOnly], CLOUD), [cloudOnly]);
    assert.deepEqual(filterByEnvironment([cloudOnly, localOnly], LOCAL), [localOnly]);
  });

  it("drops an item that refuses the current environment, even when it also asks for it", () => {
    const both = { environments: [CLOUD], disabledEnvironments: [CLOUD] };
    const asking = { environments: [CLOUD] };
    assert.deepEqual(filterByEnvironment([both, asking], CLOUD), [asking]);
    assert.deepEqual(filterByEnvironment([both], LOCAL), [], "asking only for the cloud does not reach the local machine");
  });

  it("compares the environment exactly, with no case folding and no trimming", () => {
    const mixedCase = { environments: ["Cloud"] };
    const padded = { environments: [" cloud"] };
    assert.deepEqual(filterByEnvironment([mixedCase, padded], CLOUD), []);
    assert.deepEqual(filterByEnvironment([mixedCase], "Cloud"), [mixedCase]);
  });

  it("answers a new list of the very items it was given, in their order, and leaves the input alone", () => {
    const first = { environments: [CLOUD] };
    const second = { environments: [LOCAL] };
    const third = { environments: [CLOUD, LOCAL] };
    const items = [first, second, third];
    const kept = filterByEnvironment(items, CLOUD);
    assert.notEqual(kept, items);
    assert.deepEqual(kept, [first, third]);
    assert.equal(kept[0], first);
    assert.equal(kept[1], third);
    assert.deepEqual(items, [first, second, third]);
  });

  it("carries the item's own type through the filter", () => {
    interface Rule extends EnvironmentScopedItem { readonly name: string }
    const rule: Rule = { name: "a rule", environments: [CLOUD] };
    const kept: Rule[] = filterByEnvironment([rule], CLOUD);
    assert.equal(kept[0]?.name, "a rule");
  });
});

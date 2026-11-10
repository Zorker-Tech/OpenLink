import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SidebarGrouping,
  UNASSIGNED_SECTION_ID,
  UNASSIGNED_SECTION_NAME,
  type SidebarSection,
} from "../../source/shared/sidebar-sections.ts";

const section = (id: string, agentIds: string[] = [], name = id): SidebarSection => ({ id, name, agentIds });

describe("the sections a sidebar shows", () => {
  it("is the unassigned section last, always empty and always named by this build", () => {
    const shown = SidebarGrouping.cleaned([{ ...section("mine", [], "Mine"), isCollapsed: true }, section(UNASSIGNED_SECTION_ID, ["ignored"], "theirs")]);
    assert.deepEqual(shown.map((entry) => entry.id), ["mine", UNASSIGNED_SECTION_ID]);
    assert.deepEqual(shown.at(-1), { id: UNASSIGNED_SECTION_ID, name: UNASSIGNED_SECTION_NAME, agentIds: [] });
    assert.equal(UNASSIGNED_SECTION_ID, "__agents__");
    assert.equal(UNASSIGNED_SECTION_NAME, "Unassigned");
  });

  it("drops a section with no id, trims the ids it keeps, and keeps one section per id", () => {
    const shown = SidebarGrouping.cleaned([section("  "), section(""), section(" a ", []), section("a", [], "again")]);
    assert.deepEqual(shown.map((entry) => entry.id), ["a", UNASSIGNED_SECTION_ID]);
    // The id is trimmed and the name is not: a name is the user's, and the id is what a fold is filed under.
    assert.deepEqual(shown.map((entry) => entry.name), [" a ", UNASSIGNED_SECTION_NAME], "the first section with an id is the one kept");
  });

  it("gives an agent to the first section that claims it, once", () => {
    const shown = SidebarGrouping.cleaned([section("a", ["1", "1", ""]), section("b", ["1", "2"])]);
    assert.deepEqual(shown.map((entry) => entry.agentIds), [["1"], ["2"], []]);
  });

  it("answers nothing but the unassigned section when there was nothing to show", () => {
    assert.deepEqual(SidebarGrouping.cleaned([]), []);
    assert.equal(SidebarGrouping.cleaned([]), SidebarGrouping.cleaned([]), "the empty list is one list, not a new one each time");
  });
});

describe("the sections a sidebar was stored with", () => {
  it("are read from whatever was stored, and anything that is not a section is left out", () => {
    const stored: unknown[] = [null, 5, "x", [], { id: 5 }, { id: "a" }, { id: "b", name: 5, agentIds: "no" }];
    assert.deepEqual(SidebarGrouping.readFrom(stored).map((entry) => entry.id), ["a", "b", UNASSIGNED_SECTION_ID]);
    const withJunk = SidebarGrouping.readFrom([{ id: "a", name: "A", agentIds: ["1", 5, null, "2"] }]);
    assert.deepEqual(withJunk[0]?.agentIds, ["1", "2"], "an id that is not a text is not an agent");
  });

  it("keep the fold they were last seen with, and are not folded when they were never seen", () => {
    const carried = SidebarGrouping.foldsCarried({ sections: [section("a"), section("b")], stored: [{ ...section("a"), isCollapsed: true }] });
    assert.deepEqual(carried.map((entry) => [entry.id, entry.isCollapsed]), [["a", true], ["b", false], [UNASSIGNED_SECTION_ID, false]]);
  });

  it("take the newest sighting of a fold, and say whether each is folded now", () => {
    const carried = SidebarGrouping.foldsCarried({ sections: [{ ...section("a"), isCollapsed: false }], stored: [{ ...section("a"), isCollapsed: true }] });
    assert.equal(carried[0]?.isCollapsed, false, "what is in front of us wins over what was stored");
    assert.deepEqual(SidebarGrouping.folded([section("a"), section("b")], ["b"]).map((entry) => entry.isCollapsed), [false, true]);
  });
});

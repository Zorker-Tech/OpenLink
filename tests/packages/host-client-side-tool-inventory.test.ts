import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLIENT_SIDE_TOOL_V2_PROJECTION_INVENTORY,
  SHIPPED_AGENT_TOOL_CALL_UNION,
  SHIPPED_CLIENT_SIDE_TOOL_V2_UNION,
  UNPROJECTED_AGENT_TOOL_CALL_ONEOFS,
  UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS,
} from "../../source/host/transcript/client-side-tool-v2-inventory.ts";

const inventory = CLIENT_SIDE_TOOL_V2_PROJECTION_INVENTORY;

/** The variant name at the head of a projection, before whatever the projection says about it. */
const variantOf = (projection: string) => projection.split(" (")[0] ?? projection;

describe("the client-side tools this build ships", () => {
  it("lists the enum's variants and the call union's oneofs", () => {
    assert.equal(SHIPPED_CLIENT_SIDE_TOOL_V2_UNION.length, 54);
    assert.equal(SHIPPED_AGENT_TOOL_CALL_UNION.length, 66);
    assert.equal(SHIPPED_CLIENT_SIDE_TOOL_V2_UNION.includes("RUN_TERMINAL_COMMAND_V2"), true);
    assert.equal((SHIPPED_CLIENT_SIDE_TOOL_V2_UNION as readonly string[]).includes("UNSPECIFIED"), false);
    assert.equal(SHIPPED_AGENT_TOOL_CALL_UNION.includes("shellToolCall"), true);
    assert.equal(SHIPPED_AGENT_TOOL_CALL_UNION.includes("connectScmToolCall"), true);
  });

  it("accounts for every oneof it ships: projected, ordinary-only, or unrecovered — never two of those", () => {
    const projected = Object.keys(inventory.supported);
    const ordinary = Object.keys(inventory.ordinaryTranscriptOnly).filter((oneof) => (SHIPPED_AGENT_TOOL_CALL_UNION as readonly string[]).includes(oneof));
    const covered = [...projected, ...ordinary, ...UNPROJECTED_AGENT_TOOL_CALL_ONEOFS];
    assert.equal(new Set(covered).size, covered.length, "no oneof is accounted for twice");
    for (const oneof of SHIPPED_AGENT_TOOL_CALL_UNION) assert.equal(covered.includes(oneof), true, `${oneof} is unaccounted for`);
  });

  it("accounts for every variant it ships: mapped, or left unrecovered", () => {
    const mapped = Object.values(inventory.supported).map(variantOf);
    const covered = [...mapped, ...UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS];
    assert.equal(new Set(covered).size, covered.length, "no variant is accounted for twice");
    for (const variant of SHIPPED_CLIENT_SIDE_TOOL_V2_UNION) assert.equal(covered.includes(variant), true, `${variant} is unaccounted for`);
  });

  it("keeps the unrecovered lists in the order the shipped unions keep, not sorted", () => {
    const inShippedOrder = (all: readonly string[], subset: readonly string[]) => JSON.stringify(all.filter((name) => subset.includes(name))) === JSON.stringify(subset);
    assert.equal(inShippedOrder(SHIPPED_AGENT_TOOL_CALL_UNION, UNPROJECTED_AGENT_TOOL_CALL_ONEOFS), true);
    assert.equal(inShippedOrder(SHIPPED_CLIENT_SIDE_TOOL_V2_UNION, UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS), true);
  });

  it("says what each projection becomes, and keeps the note that a variant is not lossless", () => {
    assert.equal(inventory.supported.shellToolCall, "RUN_TERMINAL_COMMAND_V2");
    assert.equal(inventory.supported.editToolCall, "EDIT_FILE_V2");
    assert.match(inventory.supported.readToolCall, /^READ_FILE_V2 \(Read and ExternalRead share this generated agent oneof\)$/);
    assert.match(inventory.supported.generateImageToolCall, /rawArgs is preserved/);
  });

  it("says why three things stay in the ordinary transcript", () => {
    assert.match(inventory.ordinaryTranscriptOnly.sendMessageToolCall, /no SendMessage variant/);
    assert.match(inventory.ordinaryTranscriptOnly.approvalInteractions, /lifecycle transcript records/);
    assert.match(inventory.ordinaryTranscriptOnly.awaitToolCall, /no await arms/);
  });

  it("states the policy for what it cannot recover, and where a binary read stays", () => {
    assert.match(inventory.unrecovered.policy, /losslessly matched/);
    assert.match(inventory.unrecovered.readBinaryOutputs, /binary\/blob identifiers remain in ordinary transcript/);
  });

  it("is frozen all the way down", () => {
    assert.equal(Object.isFrozen(inventory), true);
    assert.equal(Object.isFrozen(inventory.supported), true);
    assert.equal(Object.isFrozen(inventory.ordinaryTranscriptOnly), true);
    assert.equal(Object.isFrozen(inventory.unrecovered), true);
    assert.equal(Object.isFrozen(UNPROJECTED_AGENT_TOOL_CALL_ONEOFS), true);
    assert.equal(Object.isFrozen(UNPROJECTED_CLIENT_SIDE_TOOL_V2_VARIANTS), true);
  });
});

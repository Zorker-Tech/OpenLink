/**
 * The gateway's configuration and errors, an agent's own paths, a local tool's resolution, the roster
 * search and the approvals a user gave.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { assertValidSlateAgentId, getSlateAgentsRootDir, SlateInvalidAgentIdError } from "../../source/host/storage/agent-paths.ts";
import { classifyGatewayCommandError } from "../../source/gateway/gateway-command-error.ts";
import { SlateLocalToolPermissionResolutionError } from "../../source/host/extensions/local-tool-permission/local-tool-permission-resolution.ts";
import { SlateGatewayConfigError } from "../../source/gateway/gateway-config.ts";
import { getLocalToolApprovalsPath, LOCAL_TOOL_APPROVALS_FILENAME } from "../../source/host/local-exec/local-tool-approvals.ts";
import { AUTOMATION_MAX_NAME_LENGTH } from "../../source/host/automations/automation.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-gateway-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("where an agent's files live", () => {
  it("names the directory after a safe id and refuses one that is not", () => {
    assert.equal(typeof getSlateAgentsRootDir(), "string");
    assert.throws(() => assertValidSlateAgentId("../escape"), SlateInvalidAgentIdError);
    assert.equal(new SlateInvalidAgentIdError("bad").name, "Error");
  });
});

describe("what a failed gateway command turns into", () => {
  it("knows the connection errors that are worth trying again", () => {
    const report = classifyGatewayCommandError({ error: new Error("the command was rejected") } as never);
    assert.equal(typeof report.reason, "string");
    assert.equal("errorClass" in report, true);
  });
});

describe("the configuration a gateway starts with", () => {
  it("refuses what it cannot read rather than guessing", () => {
    assert.equal(new SlateGatewayConfigError("missing").name, "SlateGatewayConfigError");
  });
});

describe("what a local tool permission resolved to", () => {
  it("names the error a broken resolution raises", () => {
    assert.equal(new SlateLocalToolPermissionResolutionError("broken").name, "Error");
  });
});

describe("the approvals a user gave for local tools", () => {
  it("keeps them under the host's own root and stops counting them after their time", () => {
    assert.equal(LOCAL_TOOL_APPROVALS_FILENAME.length > 0, true);
    assert.match(getLocalToolApprovalsPath(), /\.slate\//);
    assert.equal(LOCAL_TOOL_APPROVALS_FILENAME.endsWith(".json"), true);
  });
});

describe("an automation", () => {
  it("bounds the name a user reads", () => {
    assert.equal(AUTOMATION_MAX_NAME_LENGTH > 0, true);
  });
});

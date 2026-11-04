import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PermissionsAutoRunInstructions } from "../../source/adapters/interop/proto/generated/agent/v1/request_context_exec_pb.ts";
import { smartModeAutoRunInstructionsFromRequestContext } from "../../source/adapters/interop/agent/smart-mode-permissions-adapter.ts";

const wireInstructions = (allowInstructions: string[], blockInstructions: string[]) =>
  new PermissionsAutoRunInstructions({ allowInstructions, blockInstructions });

describe("smart-mode permission request adapter", () => {
  it("maps the three request owners into Slate's separate policy layers", () => {
    assert.deepEqual(
      smartModeAutoRunInstructionsFromRequestContext({
        userPermissionsAutoRun: wireInstructions(["user allow"], [""]),
        projectPermissionsAutoRun: wireInstructions([], ["project block"]),
      }),
      {
        userAutoRunInstructions: { allowInstructions: ["user allow"], blockInstructions: [] },
        projectAutoRunInstructions: { allowInstructions: [], blockInstructions: ["project block"] },
        hasAdminOverride: false,
      },
    );
  });

  it("recognizes an effective administrator layer and excludes both lower layers", () => {
    assert.deepEqual(
      smartModeAutoRunInstructionsFromRequestContext({
        userPermissionsAutoRun: wireInstructions(["user allow"], []),
        projectPermissionsAutoRun: wireInstructions(["project allow"], []),
        adminPermissionsAutoRun: wireInstructions([""], ["admin block"]),
      }),
      {
        projectAutoRunInstructions: { allowInstructions: [], blockInstructions: ["admin block"] },
        hasAdminOverride: true,
      },
    );
  });
});

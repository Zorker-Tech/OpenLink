import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAutomationsPlatformCommunicationToolName,
  isSubagentExcludedPlatformCommunicationToolName,
  subagentExcludedCommunicationMcpToolNamesByServer,
} from "../../source/adapters/interop/automation/platform-communication-tool-policy-adapter.ts";

describe("external communication tool policy adapter", () => {
  it("recognizes the named communication actions and keeps them out of subagent work", () => {
    for (const name of ["SendSlackMessage", "SendMicrosoftTeamsMessage", "PostReviewCommentOnPr"]) {
      assert.equal(isAutomationsPlatformCommunicationToolName(name), true, name);
      assert.equal(isSubagentExcludedPlatformCommunicationToolName(name), true, name);
    }
    for (const name of ["SendSlackMessageV2", "OfferRepositorySwitch", "StartSlackStreaming", "PostToPrComment"]) {
      assert.equal(isSubagentExcludedPlatformCommunicationToolName(name), true, name);
    }
    assert.equal(isAutomationsPlatformCommunicationToolName("Read"), false);
    assert.equal(isSubagentExcludedPlatformCommunicationToolName("Read"), false);
  });

  it("lists MCP exclusions under their own server identifiers", () => {
    assert.deepEqual(
      [...(subagentExcludedCommunicationMcpToolNamesByServer.get("slate slack tools") ?? [])].sort(),
      ["offer_repository_switch", "send_slack_message", "set_slack_status", "start_slack_streaming"],
    );
    assert.deepEqual(
      [...(subagentExcludedCommunicationMcpToolNamesByServer.get("slate automation tools") ?? [])].sort(),
      ["post_review_comment_on_pr", "post_to_pr_comment", "send_microsoft_teams_message", "send_slack_message"],
    );
  });
});

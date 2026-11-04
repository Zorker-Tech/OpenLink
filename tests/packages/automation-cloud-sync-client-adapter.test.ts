import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptAutomationCloudRpcClient, type AutomationCloudRpcPort } from "../../source/adapters/interop/automation/automations-cloud-sync-client-adapter.ts";
import {
  CreateAutomationRequest,
  DeleteAutomationRequest,
  ListSlateAutomationsRequest,
  Prompt,
  UpdateAutomationRequest,
  Workflow,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/automations_pb.ts";

describe("automation cloud RPC adapter", () => {
  it("maps Slate-owned operations to wire requests and projects remote records back", async () => {
    let listed: ListSlateAutomationsRequest | undefined;
    let created: CreateAutomationRequest | undefined;
    let updated: UpdateAutomationRequest | undefined;
    let deleted: DeleteAutomationRequest | undefined;
    const rpc: AutomationCloudRpcPort = {
      async listSlateAutomations(request) {
        listed = request;
        return {
          workflows: [
            { workflow: { automationId: "cloud-one", description: "slate-shadow:hash", enabled: true } },
            {},
          ],
        };
      },
      async createSlateAutomation(request) { created = request; return {}; },
      async updateSlateAutomation(request) { updated = request; return {}; },
      async deleteSlateAutomation(request) { deleted = request; return {}; },
    };
    const client = adaptAutomationCloudRpcClient(rpc);
    const workflow = new Workflow({ prompts: [new Prompt({ prompt: "Write a report" })] });

    const listing = await client.listAutomationsForAgent({ agentId: "agent-one" });
    assert.ok(listed instanceof ListSlateAutomationsRequest);
    assert.equal(listed.slateAgentId, "agent-one");
    assert.deepEqual(listing, { automations: [{ id: "cloud-one", description: "slate-shadow:hash", enabled: true }] });

    await client.createAutomation({ agentId: "agent-one", automationId: "slate-one", description: "slate-shadow:hash", name: "Report", workflow, enabled: true });
    assert.ok(created instanceof CreateAutomationRequest);
    assert.deepEqual([created.slateAgentId, created.slateAutomationId, created.name, created.description, created.enabled], ["agent-one", "slate-one", "Report", "slate-shadow:hash", true]);
    assert.equal(created.workflow, workflow);

    await client.updateAutomation({ id: "cloud-one", description: "slate-shadow:new-hash", name: "Updated report", workflow, enabled: false });
    assert.ok(updated instanceof UpdateAutomationRequest);
    assert.deepEqual([updated.automationId, updated.name, updated.description, updated.enabled], ["cloud-one", "Updated report", "slate-shadow:new-hash", false]);
    assert.equal(updated.workflow, workflow);

    await client.deleteAutomation({ id: "cloud-one" });
    assert.ok(deleted instanceof DeleteAutomationRequest);
    assert.equal(deleted.automationId, "cloud-one");
  });

  it("rejects a workflow value that did not come from the interop definition adapter", async () => {
    const client = adaptAutomationCloudRpcClient({
      async listSlateAutomations() { return { workflows: [] }; },
      async createSlateAutomation() { return {}; },
      async updateSlateAutomation() { return {}; },
      async deleteSlateAutomation() { return {}; },
    });
    await assert.rejects(
      client.createAutomation({ agentId: "agent-one", automationId: "slate-one", description: "marker", name: "Report", workflow: {}, enabled: true }),
      TypeError,
    );
  });
});

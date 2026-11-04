import type { CloudSyncClient, CreateAutomationInput, RemoteAutomationList, UpdateAutomationInput } from "../../../host/automations/slate-automation-cloud-sync.ts";
import { AutomationsService } from "../proto/generated/aiserver/v1/automations_connect.ts";
import {
  CreateAutomationRequest,
  DeleteAutomationRequest,
  ListSlateAutomationsRequest,
  UpdateAutomationRequest,
  Workflow,
} from "../proto/generated/aiserver/v1/automations_pb.ts";
import { createSlateCursorBackendClient } from "../cursor-backend/cursor-inference.ts";

export interface AutomationCloudCredentials {
  getAccessToken(args: { readonly backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string>;
}

export interface AutomationCloudRpcPort {
  createSlateAutomation(request: CreateAutomationRequest): Promise<unknown>;
  listSlateAutomations(request: ListSlateAutomationsRequest): Promise<{
    readonly workflows: readonly { readonly workflow?: {
      readonly automationId: string;
      readonly description?: string;
      readonly enabled: boolean;
    } }[];
  }>;
  updateSlateAutomation(request: UpdateAutomationRequest): Promise<unknown>;
  deleteSlateAutomation(request: DeleteAutomationRequest): Promise<unknown>;
}

function cloudWorkflow(value: unknown): Workflow {
  if (!(value instanceof Workflow)) throw new TypeError("Cloud automation workflow was not encoded by the interop adapter");
  return value;
}

/** Projects the counterpart RPC methods and messages onto the host's own automation sync port. */
export function adaptAutomationCloudRpcClient(client: AutomationCloudRpcPort): CloudSyncClient {
  return {
    async listAutomationsForAgent({ agentId }): Promise<RemoteAutomationList> {
      const response = await client.listSlateAutomations(new ListSlateAutomationsRequest({ slateAgentId: agentId }));
      return {
        automations: response.workflows.flatMap(({ workflow }) => workflow === undefined ? [] : [{
          id: workflow.automationId,
          enabled: workflow.enabled,
          ...(workflow.description === undefined ? {} : { description: workflow.description }),
        }]),
      };
    },
    async createAutomation(input: CreateAutomationInput): Promise<unknown> {
      return client.createSlateAutomation(new CreateAutomationRequest({
        description: input.description,
        name: input.name,
        workflow: cloudWorkflow(input.workflow),
        enabled: input.enabled,
        slateAgentId: input.agentId,
        slateAutomationId: input.automationId,
      }));
    },
    async updateAutomation(input: UpdateAutomationInput): Promise<unknown> {
      return client.updateSlateAutomation(new UpdateAutomationRequest({
        automationId: input.id,
        description: input.description,
        name: input.name,
        workflow: cloudWorkflow(input.workflow),
        enabled: input.enabled,
      }));
    },
    async deleteAutomation({ id }): Promise<unknown> {
      return client.deleteSlateAutomation(new DeleteAutomationRequest({ automationId: id }));
    },
  };
}

/** Connects the host-owned automation sync port to the counterpart cloud service. */
export function createAutomationCloudSyncClient(credentials: AutomationCloudCredentials): CloudSyncClient {
  const client = createSlateCursorBackendClient(AutomationsService, {
    getAccessToken: credentials.getAccessToken,
    getMachineId: async () => await credentials.getMachineId(),
  });
  return adaptAutomationCloudRpcClient(client);
}

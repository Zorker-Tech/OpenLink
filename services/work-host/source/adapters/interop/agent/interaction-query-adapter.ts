/** Converts Slate's decision requests to the persisted and renderer-facing interaction messages. */

import {
  InteractionQuery,
  InteractionResponse,
  type InteractionQuery as WireInteractionQuery,
  type InteractionResponse as WireInteractionResponse,
} from "../proto/generated/agent/v1/agent_pb.ts";
import {
  AskQuestionRejected,
  AskQuestionResult,
} from "../proto/generated/agent/v1/ask_question_tool_pb.ts";
import {
  ConnectScmRequestResponse,
  ConnectScmRequestResponse_Approved,
  ConnectScmRequestResponse_Failed,
  ConnectScmRequestResponse_Rejected,
} from "../proto/generated/agent/v1/connect_scm_tool_pb.ts";
import {
  CreatePlanRequestResponse,
  CreatePlanResult,
  CreatePlanSuccess,
} from "../proto/generated/agent/v1/create_plan_tool_pb.ts";
import {
  GenerateImageRequestResponse,
  GenerateImageRequestResponse_Approved,
  GenerateImageRequestResponse_Rejected,
} from "../proto/generated/agent/v1/generate_image_tool_pb.ts";
import {
  McpAuthArgs,
  McpAuthRequestQuery,
  McpAuthRequestResponse,
  McpAuthRequestResponse_Approved,
  McpAuthRequestResponse_Rejected,
} from "../proto/generated/agent/v1/mcp_auth_tool_pb.ts";
import {
  PrManagementError,
  PrManagementResult,
} from "../proto/generated/agent/v1/pr_management_tool_pb.ts";
import {
  ReplaceEnvFailure,
  ReplaceEnvResult,
} from "../proto/generated/agent/v1/replace_env_tool_pb.ts";
import {
  SetupVmEnvironmentResult,
  SetupVmEnvironmentSuccess,
} from "../proto/generated/agent/v1/setup_vm_environment_tool_pb.ts";
import {
  SwitchModeRequestResponse,
  SwitchModeRequestResponse_Approved,
  SwitchModeRequestResponse_Rejected,
} from "../proto/generated/agent/v1/switch_mode_tool_pb.ts";
import {
  WebFetchArgs,
  WebFetchRequestQuery,
  WebFetchRequestResponse,
  WebFetchRequestResponse_Approved,
  WebFetchRequestResponse_Rejected,
} from "../proto/generated/agent/v1/web_fetch_tool_pb.ts";
import {
  WebSearchArgs,
  WebSearchRequestQuery,
  WebSearchRequestResponse,
  WebSearchRequestResponse_Approved,
  WebSearchRequestResponse_Rejected,
} from "../proto/generated/agent/v1/web_search_tool_pb.ts";
import type {
  SlateInteractionQuery,
  SlateInteractionResponse,
} from "../../../packages/agent-core/interaction-queries.ts";

type DecisionPayload = {
  readonly decision: "approved" | "rejected" | "failed" | "success" | "error" | "failure";
  readonly detail?: string | undefined;
  readonly description?: string | undefined;
  readonly reason?: string | undefined;
  readonly error?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly setupLogs?: string | undefined;
};

type QueryRecord = {
  readonly args?: {
    readonly searchTerm?: string;
    readonly toolCallId?: string;
    readonly url?: string;
    readonly serverIdentifier?: string;
    readonly description?: string;
  } | undefined;
  readonly description?: string | undefined;
  readonly skipApproval?: boolean | undefined;
  readonly smartModeApproval?: unknown;
  toJson?(): unknown;
};

function wirePayload(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "toJson" in value && typeof value.toJson === "function") {
    return value.toJson();
  }
  return value;
}

export function fromInteropInteractionQuery(query: WireInteractionQuery): SlateInteractionQuery {
  const value = query.query.value as QueryRecord | undefined;
  switch (query.query.case) {
    case "webSearchRequestQuery":
      return {
        id: query.id,
        kind: "web-search",
        payload: {
          searchTerm: value?.args?.searchTerm ?? "",
          ...(value?.args?.toolCallId === undefined ? {} : { toolCallId: value.args.toolCallId }),
        },
      };
    case "webFetchRequestQuery":
      return {
        id: query.id,
        kind: "web-fetch",
        payload: {
          args: {
            url: value?.args?.url ?? "",
            ...(value?.args?.toolCallId === undefined ? {} : { toolCallId: value.args.toolCallId }),
          },
          skipApproval: value?.skipApproval ?? false,
          ...(value?.smartModeApproval === undefined ? {} : { smartModeApproval: value.smartModeApproval }),
        },
      };
    case "mcpAuthRequestQuery":
      return {
        id: query.id,
        kind: "mcp-auth",
        payload: {
          serverIdentifier: value?.args?.serverIdentifier ?? "",
          ...(value?.args?.toolCallId === undefined ? {} : { toolCallId: value.args.toolCallId }),
        },
      };
    case "askQuestionInteractionQuery": return { id: query.id, kind: "ask-question", payload: wirePayload(value) };
    case "switchModeRequestQuery": return { id: query.id, kind: "switch-mode", payload: wirePayload(value) };
    case "createPlanRequestQuery": return { id: query.id, kind: "create-plan", payload: wirePayload(value) };
    case "setupVmEnvironmentArgs": return { id: query.id, kind: "setup-vm-environment", payload: wirePayload(value) };
    case "replaceEnvArgs": return { id: query.id, kind: "replace-environment", payload: wirePayload(value) };
    case "prManagementRequestQuery": return { id: query.id, kind: "pr-management", payload: wirePayload(value) };
    case "connectScmRequestQuery": return { id: query.id, kind: "connect-scm", payload: wirePayload(value) };
    case "generateImageRequestQuery":
      return {
        id: query.id,
        kind: "generate-image",
        payload: { description: value?.args?.description ?? value?.description ?? "" },
      };
    default:
      return { id: query.id, kind: query.query.case ?? "unknown", payload: wirePayload(value) };
  }
}

export function toInteropInteractionQuery(query: SlateInteractionQuery): InteractionQuery {
  const payload = query.payload as Record<string, unknown> | undefined;
  switch (query.kind) {
    case "web-search": {
      const args = payload as { searchTerm?: string; toolCallId?: string } | undefined;
      return new InteractionQuery({
        id: query.id,
        query: {
          case: "webSearchRequestQuery",
          value: new WebSearchRequestQuery({
            args: new WebSearchArgs({
              searchTerm: args?.searchTerm ?? "",
              ...(args?.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
            }),
          }),
        },
      });
    }
    case "web-fetch": {
      const request = payload as {
        args?: { url?: string; toolCallId?: string };
        skipApproval?: boolean;
        smartModeApproval?: unknown;
      } | undefined;
      return new InteractionQuery({
        id: query.id,
        query: {
          case: "webFetchRequestQuery",
          value: new WebFetchRequestQuery({
            args: new WebFetchArgs({
              url: request?.args?.url ?? "",
              ...(request?.args?.toolCallId === undefined ? {} : { toolCallId: request.args.toolCallId }),
            }),
            skipApproval: request?.skipApproval ?? false,
            ...(request?.smartModeApproval === undefined ? {} : { smartModeApproval: request.smartModeApproval as never }),
          }),
        },
      });
    }
    case "mcp-auth": {
      const args = payload as { serverIdentifier?: string; toolCallId?: string } | undefined;
      return new InteractionQuery({
        id: query.id,
        query: {
          case: "mcpAuthRequestQuery",
          value: new McpAuthRequestQuery({
            args: new McpAuthArgs({
              serverIdentifier: args?.serverIdentifier ?? "",
              ...(args?.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
            }),
          }),
        },
      });
    }
    default:
      throw new Error("Slate does not send interaction query kind " + query.kind);
  }
}

function decisionFromWire(caseName: string | undefined, reason?: string): DecisionPayload {
  if (caseName === "approved") return { decision: "approved" };
  return { decision: "rejected", ...(reason === undefined ? {} : { detail: reason }) };
}

export function fromInteropInteractionResponse(response: WireInteractionResponse): SlateInteractionResponse {
  switch (response.result.case) {
    case "webSearchRequestResponse": {
      const result = (response.result.value as WebSearchRequestResponse).result;
      return {
        id: response.id,
        kind: "web-search",
        payload: decisionFromWire(result.case, result.case === "rejected" ? result.value.reason : undefined),
      };
    }
    case "webFetchRequestResponse": {
      const result = (response.result.value as WebFetchRequestResponse).result;
      return {
        id: response.id,
        kind: "web-fetch",
        payload: decisionFromWire(result.case, result.case === "rejected" ? result.value.reason : undefined),
      };
    }
    case "mcpAuthRequestResponse": {
      const result = (response.result.value as McpAuthRequestResponse).result;
      return {
        id: response.id,
        kind: "mcp-auth",
        payload: decisionFromWire(
          result.case,
          result.case === "rejected" ? result.value.reason : undefined,
        ),
      };
    }
    case "askQuestionInteractionResponse":
      return {
        id: response.id,
        kind: "ask-question",
        payload: wirePayload(response.result.value),
      };
    case "switchModeRequestResponse": {
      const result = (response.result.value as SwitchModeRequestResponse).result;
      return {
        id: response.id,
        kind: "switch-mode",
        payload: decisionFromWire(
          result.case,
          result.case === "rejected" ? result.value.reason : undefined,
        ),
      };
    }
    case "createPlanRequestResponse":
      return { id: response.id, kind: "create-plan", payload: wirePayload(response.result.value) };
    case "setupVmEnvironmentResult":
      return { id: response.id, kind: "setup-vm-environment", payload: wirePayload(response.result.value) };
    case "replaceEnvResult":
      return { id: response.id, kind: "replace-environment", payload: wirePayload(response.result.value) };
    case "prManagementResult":
      return { id: response.id, kind: "pr-management", payload: wirePayload(response.result.value) };
    case "connectScmRequestResponse": {
      const result = (response.result.value as ConnectScmRequestResponse).result;
      if (result.case === "approved") {
        return { id: response.id, kind: "connect-scm", payload: { decision: "approved" } };
      }
      if (result.case === "failed") {
        return { id: response.id, kind: "connect-scm", payload: { decision: "failed", detail: result.value.error } };
      }
      return {
        id: response.id,
        kind: "connect-scm",
        payload: { decision: "rejected", detail: result.case === "rejected" ? result.value.reason : "" },
      };
    }
    case "generateImageRequestResponse": {
      const result = (response.result.value as GenerateImageRequestResponse).result;
      if (result.case === "approved") {
        return {
          id: response.id,
          kind: "generate-image",
          payload: { decision: "approved", description: result.value.description },
        };
      }
      return {
        id: response.id,
        kind: "generate-image",
        payload: { decision: "rejected", reason: result.case === "rejected" ? result.value.reason : "" },
      };
    }
    default:
      return {
        id: response.id,
        kind: response.result.case ?? "unknown",
        payload: wirePayload(response.result.value),
      };
  }
}

function decision(payload: unknown): DecisionPayload {
  if (typeof payload !== "object" || payload === null || !("decision" in payload)) {
    throw new TypeError("An interaction reply must include its decision");
  }
  return payload as DecisionPayload;
}

function approvalCase<TApproved, TRejected>(payload: unknown, approved: TApproved, rejected: (reason: string) => TRejected) {
  const result = decision(payload);
  return result.decision === "approved"
    ? { case: "approved" as const, value: approved }
    : { case: "rejected" as const, value: rejected(result.detail ?? result.reason ?? "") };
}

export function toInteropInteractionResponse(response: SlateInteractionResponse): InteractionResponse {
  switch (response.kind) {
    case "web-search":
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "webSearchRequestResponse",
          value: new WebSearchRequestResponse({
            result: approvalCase(
              response.payload,
              new WebSearchRequestResponse_Approved(),
              reason => new WebSearchRequestResponse_Rejected({ reason }),
            ),
          }),
        },
      });
    case "web-fetch":
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "webFetchRequestResponse",
          value: new WebFetchRequestResponse({
            result: approvalCase(
              response.payload,
              new WebFetchRequestResponse_Approved(),
              reason => new WebFetchRequestResponse_Rejected({ reason }),
            ),
          }),
        },
      });
    case "ask-question": {
      const result = decision(response.payload);
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "askQuestionInteractionResponse",
          value: {
            result: new AskQuestionResult({
              result: {
                case: "rejected",
                value: new AskQuestionRejected({ reason: result.detail ?? result.reason ?? "" }),
              },
            }),
          },
        },
      });
    }
    case "switch-mode":
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "switchModeRequestResponse",
          value: new SwitchModeRequestResponse({
            result: approvalCase(
              response.payload,
              new SwitchModeRequestResponse_Approved(),
              reason => new SwitchModeRequestResponse_Rejected({ reason }),
            ),
          }),
        },
      });
    case "create-plan":
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "createPlanRequestResponse",
          value: new CreatePlanRequestResponse({
            result: new CreatePlanResult({
              result: { case: "success", value: new CreatePlanSuccess() },
            }),
          }),
        },
      });
    case "setup-vm-environment":
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "setupVmEnvironmentResult",
          value: new SetupVmEnvironmentResult({ result: { case: "success", value: new SetupVmEnvironmentSuccess({}) } }),
        },
      });
    case "replace-environment": {
      const value = response.payload as { errorMessage?: string; setupLogs?: string };
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "replaceEnvResult",
          value: new ReplaceEnvResult({
            result: {
              case: "failure",
              value: new ReplaceEnvFailure({
                errorMessage: value.errorMessage ?? "Environment replacement is not supported",
                setupLogs: value.setupLogs ?? "",
              }),
            },
          }),
        },
      });
    }
    case "pr-management": {
      const value = response.payload as { error?: string };
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "prManagementResult",
          value: new PrManagementResult({
            result: { case: "error", value: new PrManagementError({ error: value.error ?? "PR management is unavailable" }) },
          }),
        },
      });
    }
    case "mcp-auth":
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "mcpAuthRequestResponse",
          value: new McpAuthRequestResponse({
            result: approvalCase(
              response.payload,
              new McpAuthRequestResponse_Approved(),
              reason => new McpAuthRequestResponse_Rejected({ reason }),
            ),
          }),
        },
      });
    case "connect-scm": {
      const result = decision(response.payload);
      const value = result.decision === "approved"
        ? { case: "approved" as const, value: new ConnectScmRequestResponse_Approved() }
        : result.decision === "failed"
          ? { case: "failed" as const, value: new ConnectScmRequestResponse_Failed({ error: result.detail ?? result.error ?? "" }) }
          : { case: "rejected" as const, value: new ConnectScmRequestResponse_Rejected({ reason: result.detail ?? result.reason ?? "" }) };
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "connectScmRequestResponse",
          value: new ConnectScmRequestResponse({ result: value }),
        },
      });
    }
    case "generate-image": {
      const result = decision(response.payload);
      const value = result.decision === "approved"
        ? { case: "approved" as const, value: new GenerateImageRequestResponse_Approved({ description: result.description ?? "" }) }
        : { case: "rejected" as const, value: new GenerateImageRequestResponse_Rejected({ reason: result.detail ?? result.reason ?? "" }) };
      return new InteractionResponse({
        id: response.id,
        result: {
          case: "generateImageRequestResponse",
          value: new GenerateImageRequestResponse({ result: value }),
        },
      });
    }
    default:
      throw new Error("No wire response is registered for interaction kind " + response.kind);
  }
}

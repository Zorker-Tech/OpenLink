/**
 * Slate's question-and-answer port for actions that need a user or host decision.
 *
 * The core names each request and carries its small input record. The transport adapter maps these
 * values to whichever messages the running host speaks.
 */

export interface SlateInteractionQuery {
  readonly id: number;
  readonly kind: string;
  readonly payload?: unknown;
}

export interface SlateInteractionResponse {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface InteractionQueryListener<Context = unknown> {
  query(context: Context, query: SlateInteractionQuery): Promise<SlateInteractionResponse>;
}

export type SlateApprovalResponse = {
  readonly result:
    | { readonly case: "approved" }
    | { readonly case: "rejected"; readonly value: { readonly reason: string } };
};

/** An answer arrives after this call returns, so the request is kept for the host to resume. */
export class DeferredInteractionResponseError extends Error {
  constructor(readonly query: SlateInteractionQuery) {
    super("Deferred interaction response requested for query " + query.id + " (" + query.kind + ")");
    this.name = "DeferredInteractionResponseError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function approvalReply(decision: "approved" | "rejected" | "failed", detail?: string | null) {
  return {
    decision,
    ...(detail === undefined || detail === null ? {} : { detail }),
  };
}

/** Standard answers the headless listener and host adapters can build without wire message classes. */
export const Responses = {
  webSearchApproved(queryId: number): SlateInteractionResponse {
    return { id: queryId, kind: "web-search", payload: approvalReply("approved") };
  },
  webSearchRejected(queryId: number, reason?: string | null): SlateInteractionResponse {
    return { id: queryId, kind: "web-search", payload: approvalReply("rejected", reason ?? "") };
  },
  webFetchApproved(queryId: number): SlateInteractionResponse {
    return { id: queryId, kind: "web-fetch", payload: approvalReply("approved") };
  },
  webFetchRejected(queryId: number, reason?: string | null): SlateInteractionResponse {
    return { id: queryId, kind: "web-fetch", payload: approvalReply("rejected", reason ?? "") };
  },
  askQuestion(queryId: number, payload: unknown): SlateInteractionResponse {
    return { id: queryId, kind: "ask-question", payload };
  },
  switchModeApproved(queryId: number): SlateInteractionResponse {
    return { id: queryId, kind: "switch-mode", payload: approvalReply("approved") };
  },
  switchModeRejected(queryId: number, reason?: string | null): SlateInteractionResponse {
    return { id: queryId, kind: "switch-mode", payload: approvalReply("rejected", reason ?? "") };
  },
  createPlan(queryId: number, payload: unknown): SlateInteractionResponse {
    return { id: queryId, kind: "create-plan", payload };
  },
  setupVmEnvironment(queryId: number, payload: unknown): SlateInteractionResponse {
    return { id: queryId, kind: "setup-vm-environment", payload };
  },
  replaceEnv(queryId: number, payload: unknown): SlateInteractionResponse {
    return { id: queryId, kind: "replace-environment", payload };
  },
  prManagement(queryId: number, payload: unknown): SlateInteractionResponse {
    return { id: queryId, kind: "pr-management", payload };
  },
  mcpAuthApproved(queryId: number): SlateInteractionResponse {
    return { id: queryId, kind: "mcp-auth", payload: approvalReply("approved") };
  },
  mcpAuthRejected(queryId: number, reason?: string | null): SlateInteractionResponse {
    return {
      id: queryId,
      kind: "mcp-auth",
      payload: approvalReply("rejected", reason ?? "Authentication was rejected"),
    };
  },
  connectScmApproved(queryId: number): SlateInteractionResponse {
    return { id: queryId, kind: "connect-scm", payload: approvalReply("approved") };
  },
  connectScmRejected(queryId: number, reason?: string | null): SlateInteractionResponse {
    return {
      id: queryId,
      kind: "connect-scm",
      payload: approvalReply("rejected", reason ?? "Connecting the source-control account was skipped"),
    };
  },
  connectScmFailed(queryId: number, error?: string | null): SlateInteractionResponse {
    return {
      id: queryId,
      kind: "connect-scm",
      payload: approvalReply("failed", error ?? "The source-control connection failed"),
    };
  },
  generateImageApproved(queryId: number, description?: string | null): SlateInteractionResponse {
    return {
      id: queryId,
      kind: "generate-image",
      payload: { decision: "approved", description: description ?? "" },
    };
  },
  generateImageRejected(queryId: number, reason?: string | null): SlateInteractionResponse {
    return {
      id: queryId,
      kind: "generate-image",
      payload: { decision: "rejected", reason: reason ?? "" },
    };
  },
};

function expectResponse<T>(response: SlateInteractionResponse, expectedKind: string, label: string): T {
  if (response.kind !== expectedKind) {
    throw new Error("Unexpected response for " + label + " query: " + response.kind);
  }
  return response.payload as T;
}

function approvalView(payload: unknown, label: string): SlateApprovalResponse {
  if (typeof payload !== "object" || payload === null || !("decision" in payload)) {
    throw new Error("Invalid " + label + " decision");
  }
  const decision = (payload as { decision: unknown }).decision;
  if (decision === "approved") return { result: { case: "approved" } };
  if (decision === "rejected") {
    const detail = (payload as { detail?: unknown }).detail;
    return {
      result: {
        case: "rejected",
        value: { reason: typeof detail === "string" ? detail : "" },
      },
    };
  }
  throw new Error("Unexpected " + label + " decision: " + String(decision));
}

export interface WebSearchInteractionInput {
  readonly searchTerm: string;
  readonly explanation?: string | undefined;
  readonly toolCallId?: string | undefined;
}

export interface WebFetchInteractionInput {
  readonly url: string;
  readonly toolCallId?: string | undefined;
}

/** Ask whether the current web search may run. */
export async function queryWebSearch<Context>(
  listener: InteractionQueryListener<Context>,
  context: Context,
  args: WebSearchInteractionInput,
): Promise<SlateApprovalResponse> {
  const response = await listener.query(context, { id: 0, kind: "web-search", payload: args });
  return approvalView(expectResponse(response, "web-search", "web search"), "web search");
}

/** Ask whether a URL may be fetched, carrying the optional approval context only when present. */
export async function queryWebFetch<Context>(
  listener: InteractionQueryListener<Context>,
  context: Context,
  args: WebFetchInteractionInput,
  options?: boolean | {
    readonly skipApproval?: boolean;
    readonly smartModeApproval?: unknown;
  } | null,
): Promise<SlateApprovalResponse> {
  const queryOptions = typeof options === "boolean" ? { skipApproval: options } : options ?? {};
  const response = await listener.query(context, {
    id: 0,
    kind: "web-fetch",
    payload: {
      args,
      skipApproval: queryOptions.skipApproval ?? false,
      ...(queryOptions.smartModeApproval === undefined
        ? {}
        : { smartModeApproval: queryOptions.smartModeApproval }),
    },
  });
  return approvalView(expectResponse(response, "web-fetch", "web fetch"), "web fetch");
}

/** Ask a host to authorize access to an external MCP server. */
export async function queryMcpAuth<Context>(
  listener: InteractionQueryListener<Context>,
  context: Context,
  args: Readonly<Record<string, unknown>>,
): Promise<SlateApprovalResponse> {
  const response = await listener.query(context, { id: 0, kind: "mcp-auth", payload: args });
  return approvalView(expectResponse(response, "mcp-auth", "MCP auth"), "MCP auth");
}

import { test } from "node:test";
import assert from "node:assert/strict";

import { InteractionQuery, InteractionResponse } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts";
import { WebSearchRequestResponse } from "../../source/adapters/interop/proto/generated/agent/v1/web_search_tool_pb.ts";
import { Responses, type SlateInteractionQuery } from "../../source/packages/agent-core/interaction-queries.ts";
import {
  fromInteropInteractionQuery,
  fromInteropInteractionResponse,
  toInteropInteractionQuery,
  toInteropInteractionResponse,
} from "../../source/adapters/interop/agent/interaction-query-adapter.ts";

test("Slate web-search input crosses the wire as a search request", () => {
  const query: SlateInteractionQuery = {
    id: 9,
    kind: "web-search",
    payload: { searchTerm: "red fox", toolCallId: "call-2" },
  };
  const wire = toInteropInteractionQuery(query);
  assert.equal(wire.query.case, "webSearchRequestQuery");
  assert.deepEqual(fromInteropInteractionQuery(wire), query);
});

test("incoming web-fetch and image requests become Slate query records", () => {
  const fetch = fromInteropInteractionQuery(new InteractionQuery({
    id: 3,
    query: {
      case: "webFetchRequestQuery",
      value: { args: { url: "https://example.com", toolCallId: "call-3" }, skipApproval: true },
    } as never,
  }));
  assert.deepEqual(fetch, {
    id: 3,
    kind: "web-fetch",
    payload: {
      args: { url: "https://example.com", toolCallId: "call-3" },
      skipApproval: true,
    },
  });

  const image = fromInteropInteractionQuery(new InteractionQuery({
    id: 4,
    query: { case: "generateImageRequestQuery", value: { args: { description: "a lighthouse" } } } as never,
  }));
  assert.deepEqual(image, { id: 4, kind: "generate-image", payload: { description: "a lighthouse" } });
});

test("Slate approval answers become the matching wire result and decode back", () => {
  const slate = Responses.webSearchRejected(11, "permission declined");
  const wire = toInteropInteractionResponse(slate);
  assert.equal(wire.result.case, "webSearchRequestResponse");
  assert.equal((wire.result.value as WebSearchRequestResponse).result.case, "rejected");
  assert.deepEqual(fromInteropInteractionResponse(wire), slate);

  const approved = toInteropInteractionResponse(Responses.mcpAuthApproved(12));
  assert.equal(approved.result.case, "mcpAuthRequestResponse");
  assert.deepEqual(fromInteropInteractionResponse(approved), Responses.mcpAuthApproved(12));
});

test("host-side response constructors return Slate records for the adapter to encode", () => {
  const input = new InteractionResponse({
    id: 15,
    result: {
      case: "webFetchRequestResponse",
      value: { result: { case: "rejected", value: { reason: "blocked" } } },
    } as never,
  });
  assert.deepEqual(fromInteropInteractionResponse(input), {
    id: 15,
    kind: "web-fetch",
    payload: { decision: "rejected", detail: "blocked" },
  });
});

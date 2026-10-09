/**
 * The four backend clients the host talks through: what each one sends, what it answers with, and what a refusal it
 * cannot act on becomes. Each is driven with a client handed in, so the logic is proven without a backend.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import { smartModeClassifierAttemptIndexKey, smartModeClassifierModeKey } from "../../source/packages/agent/utils/smart-mode-classifier-measurement.ts";
import { ClassifySlateAutoReviewRequest, ClassifySlateAutoReviewResponse } from "../../source/packages/proto/generated/aiserver/v1/dashboard_pb.ts";
import { RunGenerateImageRequest, RunGenerateImageResponse, RunWebFetchRequest, RunWebFetchResponse, RunWebSearchRequest, RunWebSearchResponse } from "../../source/packages/proto/generated/aiserver/v1/aiserver_pb.ts";
import { SmartModeClassifierArgs, SmartModeClassifierConversationMessage, SmartModeClassifierDecision, SmartModeClassifierResult, SmartModeRiskTarget } from "../../source/packages/proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts";
import { createCursorGenerateImageService, SlateGenerateImageError, SlateGenerateImageModelRestrictedError } from "../../source/shared/node/cursor-backend/cursor-generate-image.ts";
import { createCursorWebFetchService, createCursorWebSearchService } from "../../source/host/extensions/inference/cursor-web-tools.ts";
import { fetchSlateModelCatalog } from "../../source/host/cloud-agents/model-catalog-fetch.ts";
import { createSlateBackendSmartModeClassifierExecutor, SlateSmartModeClassifierError } from "../../source/host/extensions/auto-review/slate-backend-smart-mode-classifier-exec.ts";

const account = { getAccessToken: async () => "token", getMachineId: async () => "machine" };

describe("generating an image", () => {
  const imageWorld = (result: unknown) => {
    const requests: RunGenerateImageRequest[] = [];
    const service = createCursorGenerateImageService({
      ...account,
      modelId: "image-model",
      client: {
        runGenerateImage: async (request) => {
          requests.push(request);
          return { result } as unknown as RunGenerateImageResponse;
        },
      },
    });
    return { service, requests };
  };

  it("sends the description, the reference images and the model, and answers with the picture", async () => {
    const world = imageWorld({ case: "success", value: { imageData: "AAAA", mimeType: "image/png" } });
    assert.deepEqual(await world.service(undefined, "a cat", [{ data: "BBBB", mimeType: "image/jpeg" }]), { imageData: "AAAA", mimeType: "image/png" });
    const request = world.requests[0]!;
    assert.deepEqual([request.description, request.modelId, request.maxMode], ["a cat", "image-model", false]);
    assert.deepEqual(request.referenceImages.map((image) => [image.data, image.mimeType]), [["BBBB", "image/jpeg"]]);
    // No reference images is no reference images, not one empty one.
    const bare = imageWorld({ case: "success", value: { imageData: "AAAA", mimeType: "image/png" } });
    await bare.service(undefined, "a cat");
    assert.deepEqual(bare.requests[0]!.referenceImages, []);
    const maximised = createCursorGenerateImageService({ ...account, modelId: "image-model", maxMode: true, client: { runGenerateImage: async () => ({ result: { case: "success", value: { imageData: "A", mimeType: "image/png" } } }) as unknown as RunGenerateImageResponse } });
    await maximised(undefined, "a cat");
  });

  it("tells a restricted model from every other refusal, and a missing answer from both", async () => {
    const restricted = imageWorld({ case: "error", value: { error: "not allowed", modelRestricted: true } });
    await assert.rejects(restricted.service(undefined, "a cat"), SlateGenerateImageModelRestrictedError);
    const refused = imageWorld({ case: "error", value: { error: "the model is down", modelRestricted: false } });
    await assert.rejects(refused.service(undefined, "a cat"), (error: Error) => error instanceof SlateGenerateImageError && error.message === "the model is down");
    // A response that carries no result at all is the shape the wire gives a call that answered nothing.
    const nothing = imageWorld({ case: undefined });
    await assert.rejects(nothing.service(undefined, "a cat"), (error: Error) => error.message === "Image generation returned no result.");
  });
});

describe("fetching the model catalog", () => {
  it("asks for the parameters a turn would use, and answers with the platform's own entries", async () => {
    const requests: unknown[] = [];
    const catalog = await fetchSlateModelCatalog({
      ...account,
      client: {
        availableModels: async (request) => {
          requests.push(request);
          // A model the platform cannot name is not one of the catalog's own entries; the rest are mapped by the
          // catalog module, which keeps a model only when it has a name and something to choose from.
          return { models: [{ name: "model-one", clientDisplayName: "One", idAliases: [], parameterDefinitions: [], variants: [] }, { name: "  ", idAliases: [], parameterDefinitions: [], variants: [] }] } as unknown as never;
        },
      },
    });
    assert.deepEqual([requests.length, catalog.length], [1, 1]);
    const request = requests[0] as { useModelParameters: boolean; doNotUseMarkdown: boolean; scope: number };
    assert.deepEqual([request.useModelParameters, request.doNotUseMarkdown], [true, true]);
    assert.equal(request.scope, 1);
  });
});

describe("searching the web and fetching a page", () => {
  it("sends the search as it was given and answers with the documents it read", async () => {
    const requests: RunWebSearchRequest[] = [];
    const search = createCursorWebSearchService({
      ...account,
      modelId: "web-model",
      client: {
        runWebSearch: async (request) => {
          requests.push(request);
          return { answer: "the answer", documents: [{ url: "https://one.test", title: "One", text: "first", extra: 1 }] } as unknown as RunWebSearchResponse;
        },
      },
    });
    assert.deepEqual(await search(undefined, { searchTerm: "slate", explanation: "why" }), { answer: "the answer", documents: [{ url: "https://one.test", title: "One", text: "first" }] });
    assert.deepEqual([requests[0]!.searchTerm, requests[0]!.explanation, requests[0]!.modelId], ["slate", "why", "web-model"]);
    // A search with nothing to explain sends no explanation at all.
    await search(undefined, { searchTerm: "slate" });
    assert.equal(requests[1]!.explanation, undefined);
  });

  it("answers a fetch with the page, or with why it could not be had", async () => {
    const fetchAnswering = (result: unknown) =>
      createCursorWebFetchService({
        ...account,
        client: {
          runWebFetch: async (request) => {
            return { url: request.url, result: result ?? { case: undefined } } as unknown as RunWebFetchResponse;
          },
        },
      });
    assert.deepEqual(await fetchAnswering({ case: "success", value: { content: "<html>hi</html>" } })(undefined, "https://one.test"), { content: "<html>hi</html>" });
    assert.deepEqual(await fetchAnswering({ case: "error", value: { error: "timed out", isTimeout: true } })(undefined, "https://one.test"), { error: "timed out", isTimeout: true });
    assert.deepEqual(await fetchAnswering(undefined)(undefined, "https://one.test"), { error: "Web fetch returned no result." });
  });
});

describe("classifying a conversation for smart mode", () => {
  it("sends the conversation, the attempt and the mode the context carries, under the context's own cancellation", async () => {
    const requests: { request: ClassifySlateAutoReviewRequest; signal: AbortSignal | undefined }[] = [];
    const executor = createSlateBackendSmartModeClassifierExecutor({
      ...account,
      client: {
        classifySlateAutoReview: async (request, options) => {
          requests.push({ request, signal: options?.signal });
          return new ClassifySlateAutoReviewResponse({ result: new SmartModeClassifierResult({ result: { case: "success", value: { decision: SmartModeClassifierDecision.ALLOW } } }) });
        },
      },
    });
    const context = createContext().with(smartModeClassifierAttemptIndexKey, 4);
    const args = new SmartModeClassifierArgs({ target: new SmartModeRiskTarget({ action: "what this turn was about" }), conversationContext: [new SmartModeClassifierConversationMessage({ role: "user", content: "the earlier turn" })], parentConversationId: "parent-1" });
    const result = await executor.execute(context, args);
    assert.equal(result.result.case, "success");
    const sent = requests[0]!;
    assert.deepEqual([sent.request.args?.target?.action, sent.request.args?.parentConversationId, sent.request.attemptIndex, sent.request.mode], ["what this turn was about", "parent-1", 4, "enforce"]);
    // What the turn already said goes with it, so the classification is made on the same conversation.
    assert.deepEqual(sent.request.args?.conversationContext.map((message) => [message.role, message.content]), [["user", "the earlier turn"]]);
    assert.equal(sent.signal, context.signal);
    // The mode the context carries is the one that goes, and the tool call id stays behind.
    const enforcing = createContext().with(smartModeClassifierAttemptIndexKey, 1).with(smartModeClassifierModeKey, "observe");
    await executor.execute(enforcing, args);
    assert.equal(requests[1]!.request.mode, "observe");
    assert.deepEqual(requests[1]!.request.args?.toolCallId, "");
  });

  it("calls a classification that did not come back a failure", async () => {
    const executor = createSlateBackendSmartModeClassifierExecutor({
      ...account,
      client: { classifySlateAutoReview: async () => new ClassifySlateAutoReviewResponse({}) },
    });
    await assert.rejects(executor.execute(createContext(), new SmartModeClassifierArgs({ target: new SmartModeRiskTarget({ action: "t" }) })), SlateSmartModeClassifierError);
  });
});

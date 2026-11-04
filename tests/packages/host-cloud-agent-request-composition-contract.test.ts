import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCloudAgentConversationAction,
  buildCloudAgentRequestedModel,
  buildCloudAgentUserMessage,
  buildRepoFromRemote,
  normalizeRepoReference,
  resolveCloudAgentEnvironmentFields,
  resolveLaunchRepoReference,
  sanitizeRemoteUrl,
  sanitizeRemoteUrlForHttpUrl,
  toStartRepoConfig,
} from "../../source/host/cloud-agents/cloud-agent-request-composition.ts";

describe("cloud-agent launch request composition", () => {
  it("carries selected model parameters and keeps them out when no model was chosen", () => {
    assert.equal(buildCloudAgentRequestedModel(undefined, undefined), null);
    assert.equal(buildCloudAgentRequestedModel("  ", {}), null);
    assert.throws(() => buildCloudAgentRequestedModel(undefined, { effort: "high" }), /model.*required/);
    assert.deepEqual(buildCloudAgentRequestedModel(" gpt ", { effort: "high", speed: "fast" }), {
      modelId: "gpt",
      maxMode: true,
      parameters: [{ id: "effort", value: "high" }, { id: "speed", value: "fast" }],
    });
  });

  it("builds a user message with an optional mode and image context", () => {
    const plain = buildCloudAgentUserMessage({ prompt: "hello", mode: null });
    assert.equal(plain.text, "hello");
    assert.match(plain.messageId, /^[0-9a-f-]{36}$/i);
    assert.equal(Object.hasOwn(plain, "mode"), false);
    assert.equal(Object.hasOwn(plain, "selectedContext"), false);

    const withMedia = buildCloudAgentUserMessage({
      prompt: "look",
      mode: "agent",
      images: [{ data: Uint8Array.from([1, 2]), mimeType: "image/png" }, { data: Uint8Array.from([3]), path: "/tmp/a.png" }],
    });
    assert.equal(withMedia.mode, "agent");
    assert.deepEqual(withMedia.selectedContext, {
      selectedImages: [
        { dataOrBlobId: { case: "data", value: Uint8Array.from([1, 2]) }, path: "", mimeType: "image/png" },
        { dataOrBlobId: { case: "data", value: Uint8Array.from([3]) }, path: "/tmp/a.png", mimeType: "" },
      ],
    });
    assert.deepEqual(buildCloudAgentConversationAction(plain), {
      action: { case: "userMessageAction", value: { userMessage: plain, sendToInteractionListener: true } },
    });
  });

  it("normalizes remote repository forms without leaking credentials or git suffixes", () => {
    assert.equal(normalizeRepoReference("org/repo"), "https://github.com/org/repo");
    assert.equal(sanitizeRemoteUrl(" https://user:secret@Example.com/Org/Repo.git?token=x#frag "), "example.com/org/repo");
    assert.equal(sanitizeRemoteUrl("git@github.com:Org/Repo.git"), "github.com/org/repo");
    assert.equal(sanitizeRemoteUrl(""), "");
    assert.equal(sanitizeRemoteUrlForHttpUrl("ssh://git@GitHub.com/Org/Repo.git"), "https://github.com/Org/Repo");
    assert.deepEqual(buildRepoFromRemote("org/repo", "main"), {
      sanitizedRepoUrl: "github.com/org/repo",
      httpRepoUrl: "https://github.com/org/repo",
      baseBranch: "main",
    });
    assert.throws(() => buildRepoFromRemote("not a repository"), /could not parse/);
  });

  it("uses only the saved environment's primary repository for a launch", () => {
    const environment = {
      publicId: "env-1",
      name: "Team",
      repoConfig: { repos: [{ repoUrl: "https://github.com/org/primary" }, { repoUrl: "https://github.com/org/secondary" }] },
    };
    assert.equal(resolveLaunchRepoReference(undefined, environment), "https://github.com/org/primary");
    assert.equal(resolveLaunchRepoReference("org/primary", environment), "https://github.com/org/primary");
    assert.throws(() => resolveLaunchRepoReference("org/secondary", environment), /secondary repo/);
    assert.throws(() => resolveLaunchRepoReference("org/other", environment), /not part of/);
    assert.throws(() => resolveLaunchRepoReference(undefined, { publicId: "empty", name: "Team" }), /no repositories configured/);
    assert.throws(() => resolveLaunchRepoReference(undefined), /repo_url.*required/);
  });

  it("copies saved repositories without manufacturing optional IDs and routes pool or machine labels", () => {
    assert.equal(toStartRepoConfig(undefined), undefined);
    assert.equal(toStartRepoConfig({ repos: [] }), undefined);
    assert.deepEqual(toStartRepoConfig({ repos: [
      { repoUrl: "https://github.com/org/repo" },
      { repoUrl: "https://github.com/other/repo", scmRepoNodeId: "node-1", gitEnterpriseUuid: "enterprise-1" },
    ] }), { repos: [
      { repoUrl: "https://github.com/org/repo" },
      { repoUrl: "https://github.com/other/repo", scmRepoNodeId: "node-1", gitEnterpriseUuid: "enterprise-1" },
    ] });
    assert.deepEqual(resolveCloudAgentEnvironmentFields("org/repo", { type: "cloud" }), {});
    assert.deepEqual(resolveCloudAgentEnvironmentFields("org/repo", { type: "pool", name: " pool " }), {
      usePrivateWorker: true,
      labels: [{ key: "repo", value: "org/repo" }, { key: "pool", value: "pool" }],
    });
    assert.deepEqual(resolveCloudAgentEnvironmentFields("org/repo", { type: "machine", name: "box" }), {
      usePrivateWorker: true,
      labels: [{ key: "name", value: "box" }, { key: "slate.private_worker.shared_assignment_allowed", value: "true" }],
    });
    assert.throws(() => resolveCloudAgentEnvironmentFields("  ", { type: "pool" }), /derive private-worker routing labels/);
    assert.throws(() => resolveCloudAgentEnvironmentFields("org/repo", { type: "machine", name: "  " }), /registered name/);
  });
});

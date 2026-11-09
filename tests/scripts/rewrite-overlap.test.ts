import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { codeTokens, compareRiskFirst, exemptSourceReason, fingerprintCode, findFileResult, mayReplaceExistingRewriteRecord, overlapForOwnedFingerprints, overlapForOwnedSources, overlapOf, overlapOfFingerprint, parseOptions, removalProblems, rewriteRecordProblems, sourcePathsOf, withdrawClaimsForRemovedPorts } from "../../scripts/rewrite-overlap.mjs";

const scriptPath = fileURLToPath(new URL("../../scripts/rewrite-overlap.mjs", import.meta.url));

describe("rewrite overlap gate inputs", () => {
  it("accepts both separated and equals-style options", () => {
    const options = parseOptions(["check", "--threshold", "0.8", "--limit=5"]);
    assert.equal(options.get("threshold"), "0.8");
    assert.equal(options.get("limit"), "5");
  });

  it("does not treat the old protobuf schema tree as external by directory", () => {
    assert.equal(exemptSourceReason("packages/proto/schema/agent/v1/agent.proto"), undefined);
    assert.equal(exemptSourceReason("packages/proto/schema/aiserver/v1/dashboard.proto"), undefined);
  });

  it("resolves an exact port before an earlier entry's source alias", () => {
    const alias = { port: "component.ts", source: "packages/agent/prompts/user-info.ts", sourcePaths: ["packages/agent/prompts/user-info.ts"] };
    const port = { port: "packages/agent/prompts/user-info.ts", source: "packages/agent/prompts/user-info.ts", sourcePaths: ["packages/agent/prompts/user-info.ts"] };
    assert.equal(findFileResult([alias, port], "packages/agent/prompts/user-info.ts"), port);
    assert.equal(findFileResult([alias], "packages/agent/prompts/user-info.ts"), alias);
  });

  it("recomputes the same overlap from non-readable token-pair fingerprints", () => {
    const baseline = "export const localValue = 'private phrase';\nfunction keep(value) { return value + 2; }";
    const ours = ["export const slateValue='private phrase'", "function keep(value){ return value + 3 }"];
    const fingerprint = fingerprintCode(baseline);
    assert.equal(JSON.stringify(fingerprint).includes("private phrase"), false);
    assert.deepEqual(overlapOfFingerprint(fingerprint, ours), overlapOf(baseline, ours));
    assert.deepEqual(
      overlapForOwnedFingerprints(fingerprint, ["source/a.ts", "adapters/interop/agent/sandbox-policy-adapter.ts"], ours),
      overlapForOwnedSources(baseline, ["source/a.ts", "adapters/interop/agent/sandbox-policy-adapter.ts"], ours),
    );
  });

  it("keeps sandbox schema translation in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/local-exec/sandbox-conversion.ts",
      rewritten: "source/packages/local-exec/sandbox-conversion.ts",
    }), ["adapters/interop/agent/sandbox-policy-adapter.ts"]);
    assert.match(exemptSourceReason("adapters/interop/agent/sandbox-policy-adapter.ts") ?? "", /interop adapter/);
  });

  it("keeps redacted interrupted-call decoding in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/user-message-action/interrupted-tool-reconstruction.ts",
      rewritten: "source/packages/agent/actions/user-message-action/interrupted-tool-reconstruction.ts",
    }), [
      "packages/agent/actions/user-message-action/interrupted-tool-reconstruction.ts",
      "adapters/interop/agent/interrupted-tool-resolution-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/interrupted-tool-resolution-adapter.ts") ?? "", /interop adapter/);
  });

  it("keeps plan-file executor request and result mapping in interop", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/core/create-plan/backend-plan-utils.ts",
      rewritten: "source/packages/agent/tools/core/create-plan/backend-plan-utils.ts",
    }), [
      "packages/agent/tools/core/create-plan/backend-plan-utils.ts",
      "adapters/interop/agent/plan-file-read-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/plan-file-read-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate's built-in MCP registry apart from generated descriptor and result encoding", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/mcp/builtin-tools.ts",
      rewritten: "source/packages/agent/tools/mcp/builtin-tools.ts",
    }), [
      "packages/agent/tools/mcp/builtin-tools.ts",
      "adapters/interop/agent/mcp-builtins-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/mcp-builtins-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate MCP error policy apart from generated call/result conversion", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/mcp/mcp-result-boundary.ts",
      rewritten: "source/packages/agent/tools/mcp/mcp-result-boundary.ts",
    }), [
      "packages/agent/tools/mcp/mcp-result-boundary.ts",
      "adapters/interop/agent/mcp-result-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/mcp-result-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate web-fetch policy apart from generated tool envelopes", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/core/web-fetch.ts",
      rewritten: "source/packages/agent/tools/core/web-fetch.ts",
    }), [
      "packages/agent/tools/core/web-fetch.ts",
      "adapters/interop/agent/web-fetch-tool-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/web-fetch-tool-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate web-search policy apart from generated tool envelopes", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/core/web-search.ts",
      rewritten: "source/packages/agent/tools/core/web-search.ts",
    }), [
      "packages/agent/tools/core/web-search.ts",
      "adapters/interop/agent/web-search-tool-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/web-search-tool-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate subagent lifecycle apart from the generated executor envelope", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/subagent.ts",
      rewritten: "source/packages/agent-exec/subagent.ts",
    }), [
      "packages/agent-exec/subagent.ts",
      "adapters/interop/agent/subagent-exec-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/subagent-exec-adapter.ts") ?? "", /interop adapter/);
  });

  it("does not exempt the retired generated subagent completion bridge", () => {
    assert.equal(exemptSourceReason("adapters/interop/agent/task-subagent-completion-adapter.ts"), undefined);
  });

  it("keeps client-side subagent protocol messages in interop", () => {
    assert.match(
      exemptSourceReason("adapters/interop/agent/task-client-protocol-adapter.ts") ?? "",
      /interop adapter/,
    );
  });

  it("keeps classifier message decoding and serialization in interop", () => {
    assert.match(
      exemptSourceReason("adapters/interop/agent/smart-mode-classifier-context-adapter.ts") ?? "",
      /interop adapter/,
    );
  });

  it("keeps generated interaction tool-call operations in interop", () => {
    assert.match(
      exemptSourceReason("adapters/interop/agent/interaction-tool-call-adapter.ts") ?? "",
      /interop adapter/,
    );
  });

  it("keeps await executor messages and result envelopes in interop", () => {
    assert.match(
      exemptSourceReason("adapters/interop/agent/await-tool-protocol-adapter.ts") ?? "",
      /interop adapter/,
    );
  });

  it("keeps MCP discovery wire arguments, server snapshots, and tool results in interop", () => {
    assert.match(
      exemptSourceReason("adapters/interop/agent/get-mcp-tools-protocol-adapter.ts") ?? "",
      /interop adapter/,
    );
  });

  it("keeps remote hook request and response messages in interop", () => {
    assert.match(
      exemptSourceReason("adapters/interop/agent/remote-hooks-protocol-adapter.ts") ?? "",
      /interop adapter/,
    );
  });

  it("scores the Slate MCP catalog view apart from generated option serialization", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/local-exec/mcp-file-system-writer.ts",
      rewritten: "source/packages/local-exec/mcp-file-system-writer.ts",
    }), [
      "packages/local-exec/mcp-file-system-writer.ts",
      "adapters/interop/agent/mcp-file-system-options-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/mcp-file-system-options-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate post-write policy apart from generated canvas diagnostics", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/core/edit/post-write-result-decoration.ts",
      rewritten: "source/packages/agent/tools/core/edit/post-write-result-decoration.ts",
    }), [
      "packages/agent/tools/core/edit/post-write-result-decoration.ts",
      "adapters/interop/agent/canvas-diagnostics-operation-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/canvas-diagnostics-operation-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate action auditing apart from generated shell probes", () => {
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/slate-action-audit.ts",
      rewritten: "source/host/runner/slate-action-audit.ts",
    }), [
      "host/runner/slate-action-audit.ts",
      "adapters/interop/agent/navigation-probe-shell-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/navigation-probe-shell-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate shell-review policy apart from generated read requests", () => {
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/slate-shell-auto-review-enrichment.ts",
      rewritten: "source/host/runner/slate-shell-auto-review-enrichment.ts",
    }), [
      "host/runner/slate-shell-auto-review-enrichment.ts",
      "adapters/interop/agent/shell-auto-review-read-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/shell-auto-review-read-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate transcript rendering apart from generated summary archives", () => {
    assert.deepEqual(sourcePathsOf({
      port: "host/transcript/agent-transcript/index.ts",
      rewritten: "source/host/transcript/agent-transcript/index.ts",
    }), [
      "host/transcript/agent-transcript/index.ts",
      "adapters/interop/agent/transcript-summary-archive-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/transcript-summary-archive-adapter.ts") ?? "", /interop adapter/);
  });

  it("scores Slate local-read behavior apart from generated executor messages", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/local-exec/read.ts",
      rewritten: "source/packages/local-exec/read.ts",
    }), [
      "packages/local-exec/read.ts",
      "adapters/interop/agent/local-read-executor-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/local-read-executor-adapter.ts") ?? "", /interop adapter/);
  });

  it("keeps communicate tool-call envelope construction in interop", () => {
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/tools/communicate-tool.ts",
      rewritten: "source/host/runner/tools/communicate-tool.ts",
    }), ["adapters/interop/agent/communicate-tool-adapter.ts"]);
    assert.match(exemptSourceReason("adapters/interop/agent/communicate-tool-adapter.ts") ?? "", /interop adapter/);
  });

  it("keeps the supported legacy box Connect envelope at its compatibility boundary", () => {
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-remote-accessor.ts",
      rewritten: "source/host/boxes/box-remote-accessor.ts",
    }), ["adapters/interop/agent/box-remote-exec-accessor-adapter.ts"]);
    assert.match(exemptSourceReason("host/boxes/box-remote-accessor.ts") ?? "", /legacy box Connect compatibility/);
    assert.match(exemptSourceReason("adapters/interop/agent/box-remote-exec-accessor-adapter.ts") ?? "", /supported legacy box Connect exec envelope/);
  });

  it("measures the Slate-owned computer executor bridge instead of exempting its directory", () => {
    assert.equal(exemptSourceReason("adapters/interop/agent/computer-use-executor-adapter.ts"), undefined);
    assert.equal(exemptSourceReason("adapters/interop/agent/remote-box-resource-adapter.ts"), undefined);
  });

  it("ignores comments and whitespace while retaining code tokens", () => {
    assert.deepEqual(codeTokens("const value = 1; // comment\n"), ["const", "value", "1"]);
    assert.deepEqual(overlapOf("const value = 1;", "const\nvalue=1;"), {
      overlap: 1,
      baselinePairs: 2,
      identical: true,
    });
  });

  it("orders the rewrite queue by overlap band and measured token size", () => {
    const queue = [
      { port: "smaller-exact.ts", identical: true, overlap: 1, baselinePairs: 10, lines: 900 },
      { port: "larger-near.ts", identical: false, overlap: 0.99, baselinePairs: 500, lines: 500 },
      { port: "larger-exact.ts", identical: true, overlap: 1, baselinePairs: 100, lines: 1 },
      { port: "larger-lower-risk.ts", identical: false, overlap: 0.79, baselinePairs: 900, lines: 900 },
    ];
    queue.sort(compareRiskFirst);
    assert.deepEqual(queue.map((entry) => entry.port), [
      "larger-exact.ts",
      "smaller-exact.ts",
      "larger-near.ts",
      "larger-lower-risk.ts",
    ]);
  });

  it("measures moved fragments together without adding token pairs across file boundaries", () => {
    assert.deepEqual(
      overlapOf("one two three four", ["one two", "three four"]),
      { overlap: 2 / 3, baselinePairs: 3, identical: false },
    );
    assert.deepEqual(sourcePathsOf({
      port: "host/slate-host.ts",
      rewritten: "source/host/slate-host.ts",
    }), [
      "host/slate-host.ts",
      "host/slate-host-production.ts",
      "host/box-ready-reporter.ts",
      "host/host-health.ts",
      "host/host-event-feeds.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/cursor-plugins/loader.ts",
      rewritten: "source/packages/plugin-install/loader.ts",
    }), [
      "packages/plugin-install/loader.ts",
      "packages/plugin-install/plugin-loader-contracts.ts",
      "packages/plugin-install/plugin-file-fetcher.ts",
      "packages/plugin-install/plugin-document-loader.ts",
      "packages/plugin-install/marketplace-plugin-loader.ts",
      "adapters/interop/plugin-marketplace/plugin-origin.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/rooms/xuser-sharing-service.ts",
      rewritten: "source/host/rooms/xuser-sharing-service.ts",
    }), [
      "host/rooms/xuser-sharing-service.ts",
      "host/rooms/xuser-sharing-contracts.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/rooms/extension.ts",
      rewritten: "source/host/rooms/extension.ts",
    }), [
      "host/rooms/extension.ts",
      "host/rooms/xuser-sharing-extension-contracts.ts",
      "host/rooms/xuser-sharing-extension-lifecycle.ts",
      "host/rooms/xuser-sharing-extension-api.ts",
      "host/rooms/xuser-sharing-extension-service.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/local-tool-permission/local-tool-permission-controller.ts",
      rewritten: "source/host/extensions/local-tool-permission/local-tool-permission-controller.ts",
    }), [
      "host/extensions/local-tool-permission/local-tool-permission-controller.ts",
      "host/extensions/local-tool-permission/local-tool-permission-controller-contracts.ts",
      "host/extensions/local-tool-permission/local-tool-permission-refusal-memory.ts",
      "host/extensions/local-tool-permission/local-tool-pending-ask-queue.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/observability/structured-log-transport.ts",
      rewritten: "source/shared/observability/structured-log-transport.ts",
    }), [
      "shared/observability/structured-log-transport.ts",
      "shared/observability/structured-log-transport-contracts.ts",
      "shared/observability/structured-log-transport-values.ts",
      "shared/observability/structured-log-buffer.ts",
      "shared/observability/structured-log-drop-ledger.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "gateway/gateway-server.ts",
      rewritten: "source/gateway/gateway-server.ts",
    }), [
      "gateway/gateway-server.ts",
      "gateway/gateway-server-contracts.ts",
      "gateway/gateway-server-http.ts",
      "gateway/gateway-server-routes.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/skills/plugin-skills.ts",
      rewritten: "source/host/skills/plugin-skills.ts",
    }), [
      "host/skills/plugin-skills.ts",
      "host/skills/plugin-skills-contracts.ts",
      "host/skills/plugin-skill-records.ts",
      "host/skills/plugin-skills-loader.ts",
      "adapters/interop/plugin-marketplace/installed-plugin-dashboard-adapter.ts",
      "host/skills/plugin-skills-service.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/local-exec/shell-stream.ts",
      rewritten: "source/packages/local-exec/shell-stream.ts",
    }), [
      "packages/local-exec/shell-stream.ts",
      "packages/local-exec/shell-stream-contracts.ts",
      "packages/local-exec/shell-stream-analysis.ts",
      "packages/local-exec/shell-stream-policy.ts",
      "packages/local-exec/shell-stream-events.ts",
      "packages/local-exec/shell-stream-handoff.ts",
      "packages/local-exec/shell-stream-foreground-runs.ts",
      "adapters/interop/agent/local-shell-stream-executor-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/local-shell-stream-executor-adapter.ts") ?? "", /interop adapter/);
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/shell-terminal-watch.ts",
      rewritten: "source/host/runner/shell-terminal-watch.ts",
    }), [
      "host/runner/shell-terminal-watch.ts",
      "adapters/interop/agent/shell-terminal-watch-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/agent/shell-terminal-watch-adapter.ts") ?? "", /interop adapter/);
    assert.deepEqual(sourcePathsOf({
      port: "shared/workflow-model.ts",
      rewritten: "source/shared/workflow-model.ts",
    }), [
      "shared/workflow-model.ts",
      "shared/workflow-model-contracts.ts",
      "shared/workflow-model-values.ts",
      "shared/workflow-frontmatter.ts",
      "shared/workflow-model-projections.ts",
      "shared/workflow-model-references.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/local-exec/local-exec-bridge.ts",
      rewritten: "source/host/local-exec/local-exec-bridge.ts",
    }), [
      "host/local-exec/local-exec-bridge.ts",
      "host/local-exec/local-exec-bridge-contracts.ts",
      "host/local-exec/local-exec-provider-directory.ts",
      "host/local-exec/local-exec-response-channels.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/local-exec/local-exec-daemon.ts",
      rewritten: "source/host/local-exec/local-exec-daemon.ts",
    }), [
      "host/local-exec/local-exec-daemon.ts",
      "host/local-exec/local-exec-daemon-run-contracts.ts",
      "host/local-exec/local-exec-daemon-connection.ts",
      "host/local-exec/local-exec-daemon-discovery-publisher.ts",
      "host/local-exec/local-exec-daemon-policy.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-store-sync/box-store-sync-service.ts",
      rewritten: "source/host/boxes/box-store-sync/box-store-sync-service.ts",
    }), [
      "host/boxes/box-store-sync/box-store-sync-service.ts",
      "host/boxes/box-store-sync/box-store-sync-service-api.ts",
      "host/boxes/box-store-sync/box-store-sync-service-contracts.ts",
      "host/boxes/box-store-sync/box-store-sync-service-categories.ts",
      "host/boxes/box-store-sync/box-store-sync-service-reporter.ts",
      "host/boxes/box-store-sync/box-store-sync-service-runtime.ts",
      "host/boxes/box-store-sync/box-store-sync-service-store.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-store-sync/box-store-pack.ts",
      rewritten: "source/host/boxes/box-store-sync/box-store-pack.ts",
    }), [
      "host/boxes/box-store-sync/box-store-pack.ts",
      "host/boxes/box-store-sync/box-store-pack-index.ts",
      "host/boxes/box-store-sync/box-store-pack-files.ts",
      "host/boxes/box-store-sync/box-store-pack-planner.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-transfer.ts",
      rewritten: "source/host/boxes/box-transfer.ts",
    }), [
      "host/boxes/box-transfer.ts",
      "host/boxes/box-transfer-contracts.ts",
      "host/boxes/box-transfer-paths.ts",
      "host/boxes/box-transfer-failures.ts",
      "host/boxes/box-transfer-copy.ts",
      "host/boxes/box-transfer-concurrency.ts",
      "host/boxes/box-transfer-batches.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/forever-box/forever-box-service.ts",
      rewritten: "source/host/boxes/forever-box/forever-box-service.ts",
    }), [
      "host/boxes/forever-box/forever-box-service.ts",
      "host/boxes/forever-box/forever-box-service-contracts.ts",
      "host/boxes/forever-box/forever-box-image-updates.ts",
      "host/boxes/forever-box/forever-box-status-overlay.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/forever-box/host-box.ts",
      rewritten: "source/host/boxes/forever-box/host-box.ts",
    }), [
      "host/boxes/forever-box/host-box.ts",
      "host/boxes/forever-box/host-box-contracts.ts",
      "host/boxes/forever-box/host-box-status-state.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/memory/agent-state.ts",
      rewritten: "source/host/memory/agent-state.ts",
    }), [
      "host/memory/agent-state.ts",
      "host/memory/agent-state-contracts.ts",
      "host/memory/agent-state-memory.ts",
      "host/memory/agent-state-workflows.ts",
      "host/memory/agent-state-profile.ts",
      "host/memory/agent-state-projects.ts",
      "host/memory/agent-state-avatar.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/background-work.ts",
      rewritten: "source/host/runner/background-work.ts",
    }), [
      "host/runner/background-work.ts",
      "host/runner/background-work-contracts.ts",
      "host/runner/background-work-registry.ts",
      "host/runner/background-work-terminal.ts",
      "host/runner/background-work-watchers.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/content-search/search-index-writer.ts",
      rewritten: "source/host/extensions/content-search/search-index-writer.ts",
    }), [
      "host/extensions/content-search/search-index-writer.ts",
      "host/extensions/content-search/search-index-writer-contracts.ts",
      "host/extensions/content-search/search-index-row-projector.ts",
      "host/extensions/content-search/search-index-write-statements.ts",
      "host/extensions/content-search/search-index-transcript-reader.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/session/session-maintenance.ts",
      rewritten: "source/host/extensions/session/session-maintenance.ts",
    }), [
      "host/extensions/session/session-maintenance.ts",
      "host/extensions/session/session-maintenance-contracts.ts",
      "host/extensions/session/session-maintenance-common.ts",
      "host/extensions/session/session-maintenance-checkpoint.ts",
      "host/extensions/session/session-maintenance-transcript.ts",
      "host/extensions/session/session-maintenance-repair.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/session/session-summaries.ts",
      rewritten: "source/host/extensions/session/session-summaries.ts",
    }), [
      "host/extensions/session/session-summaries.ts",
      "host/extensions/session/session-summary-contracts.ts",
      "host/extensions/session/session-summary-db-extras.ts",
      "host/extensions/session/session-summary-minimal.ts",
      "host/extensions/session/session-summary-footprint.ts",
      "host/extensions/session/session-summary-builder.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/action-audit/action-audit-service.ts",
      rewritten: "source/host/extensions/action-audit/action-audit-service.ts",
    }), [
      "host/extensions/action-audit/action-audit-service.ts",
      "host/extensions/action-audit/action-audit-contracts.ts",
      "host/extensions/action-audit/action-audit-policy.ts",
      "host/extensions/action-audit/action-audit-local-jsonl.ts",
      "host/extensions/action-audit/action-audit-outbox.ts",
      "host/extensions/action-audit/action-audit-local-write-lane.ts",
      "host/extensions/action-audit/action-audit-flush-controller.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/secrets/secrets-service.ts",
      rewritten: "source/host/extensions/secrets/secrets-service.ts",
    }), [
      "host/extensions/secrets/secrets-service.ts",
      "host/extensions/secrets/secrets-service-contracts.ts",
      "host/extensions/secrets/secrets-store.ts",
      "host/extensions/secrets/secrets-generation-waiters.ts",
      "host/extensions/secrets/secrets-apply-loop.ts",
      "host/extensions/secrets/secrets-applier.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/cursor-plugins/mcp-parser.ts",
      rewritten: "source/packages/plugin-install/mcp-parser.ts",
    }), [
      "packages/plugin-install/mcp-parser.ts",
      "packages/plugin-install/mcp-parser-contracts.ts",
      "packages/plugin-install/mcp-parser-expansion.ts",
      "packages/plugin-install/mcp-parser-document.ts",
      "packages/plugin-install/mcp-parser-resolution.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/local-exec/shell-core.ts",
      rewritten: "source/packages/local-exec/shell-core.ts",
    }), [
      "packages/local-exec/shell-core.ts",
      "packages/local-exec/shell-core-contracts.ts",
      "packages/local-exec/shell-core-environment.ts",
      "packages/local-exec/shell-core-sandbox-policy.ts",
      "packages/local-exec/shell-core-output-capture.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/cursor-plugins/git-url-parsing.ts",
      rewritten: "source/packages/plugin-install/git-url-parsing.ts",
    }), [
      "packages/plugin-install/git-url-parsing.ts",
      "packages/plugin-install/git-url-parsing-contracts.ts",
      "packages/plugin-install/git-url-normalize.ts",
      "packages/plugin-install/git-url-provider.ts",
      "packages/plugin-install/git-url-scm.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/cursor-config/auth/mdm-sign-in-policy.ts",
      rewritten: "source/packages/config/auth/mdm-sign-in-policy.ts",
    }), [
      "packages/config/auth/mdm-sign-in-policy.ts",
      "packages/config/auth/mdm-sign-in-policy-contracts.ts",
      "packages/config/auth/mdm-sign-in-policy-values.ts",
      "packages/config/auth/mdm-sign-in-policy-sources.ts",
      "packages/config/auth/mdm-sign-in-policy-cache.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/transcript/mirror/transcript-mirror.ts",
      rewritten: "source/host/transcript/mirror/transcript-mirror.ts",
    }), [
      "host/transcript/mirror/transcript-mirror.ts",
      "host/transcript/mirror/transcript-mirror-contracts.ts",
      "host/transcript/mirror/transcript-mirror-files.ts",
      "host/transcript/mirror/transcript-mirror-write-lanes.ts",
      "host/transcript/mirror/transcript-mirror-outcomes.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/automations/automation-trigger.ts",
      rewritten: "source/host/automations/automation-trigger.ts",
    }), [
      "host/automations/automation-trigger.ts",
      "host/automations/automation-trigger-contracts.ts",
      "host/automations/automation-trigger-parse.ts",
      "host/automations/automation-trigger-matching.ts",
      "host/automations/automation-trigger-context.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/automations/backend-relay-source.ts",
      rewritten: "source/host/automations/backend-relay-source.ts",
    }), [
      "host/automations/backend-relay-source.ts",
      "host/automations/backend-relay-contracts.ts",
      "host/automations/backend-relay-events.ts",
      "host/automations/backend-relay-status.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/attachments/safe-link-preview-fetch.ts",
      rewritten: "source/host/attachments/safe-link-preview-fetch.ts",
    }), [
      "host/attachments/safe-link-preview-fetch.ts",
      "host/attachments/safe-link-preview-contracts.ts",
      "host/attachments/safe-link-preview-target.ts",
      "host/attachments/safe-link-preview-transport.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/conversation-state.ts",
      rewritten: "source/host/runner/conversation-state.ts",
    }), [
      "host/runner/conversation-state.ts",
      "host/runner/conversation-state-contracts.ts",
      "host/runner/conversation-user-state.ts",
      "host/runner/conversation-usage.ts",
      "host/runner/conversation-prompt-usage.ts",
      "host/runner/conversation-summary-policy.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/agent-adapters.ts",
      rewritten: "source/host/runner/agent-adapters.ts",
    }), [
      "host/runner/agent-adapters.ts",
      "adapters/interop/agent/runner-agent-adapters.ts",
      "host/runner/request-context-result.ts",
      "host/runner/subagent-session-coordinator.ts",
      "host/runner/forwarding-interaction-updates.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/codebase-telemetry/privacy-mode.ts",
      rewritten: "source/host/extensions/codebase-telemetry/privacy-mode.ts",
    }), [
      "host/extensions/codebase-telemetry/privacy-mode.ts",
      "adapters/interop/telemetry/privacy-mode-dashboard-adapter.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-core/interaction-updates.ts",
      rewritten: "source/packages/agent-core/interaction-updates.ts",
    }), [
      "packages/agent-core/interaction-updates.ts",
      "packages/agent-core/interaction-update-contracts.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/slate-activity.ts",
      rewritten: "source/host/slate-activity.ts",
    }), [
      "host/slate-activity.ts",
      "host/slate-activity-contracts.ts",
      "host/slate-activity-transitions.ts",
      "host/slate-activity-shell-paths.ts",
      "host/slate-activity-tool-projection.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/rooms/xuser-remote-turns.ts",
      rewritten: "source/host/rooms/xuser-remote-turns.ts",
    }), [
      "host/rooms/xuser-remote-turns.ts",
      "host/rooms/xuser-remote-turn-contracts.ts",
      "host/rooms/xuser-remote-turn-inbound.ts",
      "host/rooms/xuser-remote-turn-outbound.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/local-exec/local-exec-daemon-protocol.ts",
      rewritten: "source/host/local-exec/local-exec-daemon-protocol.ts",
    }), [
      "host/local-exec/local-exec-daemon-protocol.ts",
      "host/local-exec/local-exec-daemon-contracts.ts",
      "host/local-exec/local-exec-daemon-files.ts",
      "host/local-exec/local-exec-daemon-discovery.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/rooms/xuser-relay.ts",
      rewritten: "source/host/rooms/xuser-relay.ts",
    }), [
      "host/rooms/xuser-relay.ts",
      "host/rooms/xuser-relay-contracts.ts",
      "host/rooms/xuser-relay-http-api.ts",
      "host/rooms/xuser-relay-polling.ts",
      "host/rooms/xuser-relay-room-routes.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/session/conversation-size-limits.ts",
      rewritten: "source/host/extensions/session/conversation-size-limits.ts",
    }), [
      "host/extensions/session/conversation-size-limits.ts",
      "host/extensions/session/conversation-size-limits-contracts.ts",
      "host/extensions/session/conversation-size-limits-config.ts",
      "host/extensions/session/conversation-size-garbage-collection.ts",
      "host/extensions/session/conversation-size-maintenance.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/agents/agent-avatar.ts",
      rewritten: "source/host/agents/agent-avatar.ts",
    }), [
      "host/agents/agent-avatar.ts",
      "host/agents/agent-avatar-contracts.ts",
      "host/agents/agent-avatar-format.ts",
      "host/agents/agent-avatar-paths.ts",
      "host/agents/agent-avatar-reading.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/os-notification.ts",
      rewritten: "source/shared/os-notification.ts",
    }), [
      "shared/os-notification.ts",
      "shared/os-notification-contracts.ts",
      "shared/os-notification-snapshot.ts",
      "shared/os-notification-content.ts",
      "shared/os-notification-policy.ts",
      "shared/os-notification-decider.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/local-exec/ls.ts",
      rewritten: "source/packages/local-exec/ls.ts",
    }), [
      "packages/local-exec/ls.ts",
      "packages/local-exec/ls-contracts.ts",
      "packages/local-exec/ls-tree-builder.ts",
    ]);
    assert.equal(exemptSourceReason("adapters/interop/agent/local-ls-exec-adapter.ts"), undefined);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/utils/mcp-meta-tool-options.ts",
      rewritten: "source/packages/agent/utils/mcp-meta-tool-options.ts",
    }), [
      "packages/agent/utils/mcp-meta-tool-options.ts",
      "adapters/interop/agent/mcp-meta-tool-options-adapter.ts",
    ]);
    assert.equal(exemptSourceReason("adapters/interop/agent/mcp-meta-tool-options-adapter.ts"),
      "interop adapter: projects discovered tool names and Slate tool policy into generated MCP option messages");
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/action-audit/action-audit-backend.ts",
      rewritten: "source/host/extensions/action-audit/action-audit-backend.ts",
    }), [
      "host/extensions/action-audit/action-audit-backend.ts",
      "adapters/interop/analytics/action-audit-backend-adapter.ts",
    ]);
    assert.equal(exemptSourceReason("adapters/interop/analytics/action-audit-backend-adapter.ts"),
      "interop adapter: serializes Slate audit records into generated dashboard events and submits request batches");
    assert.deepEqual(sourcePathsOf({
      port: "packages/cursor-config/auth/login.ts",
      rewritten: "source/packages/config/auth/login.ts",
    }), [
      "packages/config/auth/login.ts",
      "packages/config/auth/login-contracts.ts",
      "packages/config/auth/login-link.ts",
      "packages/config/auth/login-polling.ts",
      "packages/config/auth/login-api-key.ts",
      "packages/config/auth/login-manager.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/session/session-materialization.ts",
      rewritten: "source/host/extensions/session/session-materialization.ts",
    }), [
      "host/extensions/session/session-materialization.ts",
      "host/extensions/session/session-materialization-contracts.ts",
      "host/extensions/session/session-mint-queue.ts",
      "host/extensions/session/session-store-materializer.ts",
      "host/extensions/session/session-directory-index.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/agents/isolation/conversation-blob-store.ts",
      rewritten: "source/host/agents/isolation/conversation-blob-store.ts",
    }), [
      "host/agents/isolation/conversation-blob-store.ts",
      "host/agents/isolation/conversation-blob-store-contracts.ts",
      "host/agents/isolation/conversation-blob-identifiers.ts",
      "host/agents/isolation/conversation-blob-write-history.ts",
      "host/agents/isolation/conversation-blob-legacy-adoption.ts",
      "host/agents/isolation/conversation-blob-stale-roots.ts",
      "host/agents/isolation/conversation-blob-collector.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/forever-box/disk-pressure.ts",
      rewritten: "source/host/boxes/forever-box/disk-pressure.ts",
    }), [
      "host/boxes/forever-box/disk-pressure.ts",
      "host/boxes/forever-box/disk-pressure-reminder-ledger.ts",
      "host/boxes/forever-box/disk-pressure-reminder-persistence.ts",
      "host/boxes/forever-box/disk-pressure-watch.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/local-exec/gateway-local-exec-slate-box.ts",
      rewritten: "source/host/local-exec/gateway-local-exec-slate-box.ts",
    }), [
      "host/local-exec/gateway-local-exec-slate-box.ts",
      "host/local-exec/gateway-local-exec-contracts.ts",
      "host/local-exec/gateway-local-exec-manager.ts",
      "host/local-exec/gateway-local-exec-box.ts",
      "host/local-exec/gateway-local-exec-computers.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/local-exec/production.ts",
      rewritten: "source/host/local-exec/production.ts",
    }), [
      "host/local-exec/production.ts",
      "adapters/interop/agent/local-exec-codec-adapter.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/host-upgrade/host-upgrade-service.ts",
      rewritten: "source/host/extensions/host-upgrade/host-upgrade-service.ts",
    }), [
      "host/extensions/host-upgrade/host-upgrade-service.ts",
      "host/extensions/host-upgrade/host-upgrade-service-contracts.ts",
      "host/extensions/host-upgrade/host-upgrade-marker-forwarder.ts",
      "host/extensions/host-upgrade/host-upgrade-update-coordinator.ts",
      "host/extensions/host-upgrade/host-upgrade-update-watch.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/host-upgrade/host-bundle-upgrade.ts",
      rewritten: "source/host/extensions/host-upgrade/host-bundle-upgrade.ts",
    }), [
      "host/extensions/host-upgrade/host-bundle-upgrade.ts",
      "host/extensions/host-upgrade/host-bundle-upgrade-contracts.ts",
      "host/extensions/host-upgrade/host-bundle-command.ts",
      "host/extensions/host-upgrade/host-bundle-upgrade-command-values.ts",
      "host/extensions/host-upgrade/host-bundle-upgrade-state.ts",
      "host/extensions/host-upgrade/host-bundle-fetch-stage.ts",
      "host/extensions/host-upgrade/host-bundle-error-detail.ts",
      "host/extensions/host-upgrade/host-bundle-watch-policy.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/workflows/workflow-store.ts",
      rewritten: "source/host/workflows/workflow-store.ts",
    }), [
      "host/workflows/workflow-store.ts",
      "host/workflows/workflow-store-contracts.ts",
      "host/workflows/workflow-store-sources.ts",
      "host/workflows/workflow-store-migration.ts",
      "host/workflows/workflow-store-imports.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/cloud-agents/cloud-agents-service.ts",
      rewritten: "source/host/cloud-agents/cloud-agents-service.ts",
    }), [
      "host/cloud-agents/cloud-agents-service.ts",
      "host/cloud-agents/cloud-agent-manager-contracts.ts",
      "host/cloud-agents/cloud-agent-view-mappers.ts",
      "host/cloud-agents/cloud-agent-manager-queries.ts",
      "host/cloud-agents/cloud-agent-manager-launch.ts",
      "adapters/interop/cursor-backend/slate-cloud-agent-client-adapter.ts",
    ]);
    assert.match(exemptSourceReason("adapters/interop/cursor-backend/slate-cloud-agent-client-adapter.ts") ?? "", /interop adapter/);
    assert.deepEqual(sourcePathsOf({
      port: "host/automations/automation-store.ts",
      rewritten: "source/host/automations/automation-store.ts",
    }), [
      "host/automations/automation-store.ts",
      "host/automations/automation-store-contracts.ts",
      "host/automations/automation-store-codecs.ts",
      "host/automations/automation-store-files.ts",
      "host/automations/automation-store-service.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/automation-schedule.ts",
      rewritten: "source/shared/automation-schedule.ts",
    }), [
      "shared/automation-schedule.ts",
      "shared/automation-schedule-contracts.ts",
      "shared/automation-schedule-core.ts",
      "shared/automation-schedule-description.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/shared-desktop-slate-box.ts",
      rewritten: "source/host/boxes/shared-desktop-slate-box.ts",
    }), [
      "host/boxes/shared-desktop-slate-box.ts",
      "host/boxes/shared-desktop-contracts.ts",
      "host/boxes/shared-desktop-assignments.ts",
      "host/boxes/shared-desktop-capabilities.ts",
      "host/boxes/shared-desktop-window-manager.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/loopback-slate-box.ts",
      rewritten: "source/host/boxes/loopback-slate-box.ts",
    }), [
      "host/boxes/loopback-slate-box.ts",
      "host/boxes/loopback-box-contracts.ts",
      "host/boxes/loopback-daemon-readiness.ts",
      "host/boxes/loopback-box-windows.ts",
      "host/boxes/loopback-box-file-access.ts",
      "box-exec/terminal-paths.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/node/egress-tunnel/exit-client.ts",
      rewritten: "source/shared/node/egress-tunnel/exit-client.ts",
    }), [
      "shared/node/egress-tunnel/exit-client.ts",
      "shared/node/egress-tunnel/exit-client-contracts.ts",
      "shared/node/egress-tunnel/egress-frame-codec.ts",
      "shared/node/egress-tunnel/egress-target-policy.ts",
      "shared/node/egress-tunnel/egress-tunnel-exit-client.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/node/experiments/cursor-experiments.ts",
      rewritten: "source/shared/node/experiments/slate-experiment-service.ts",
    }), [
      "shared/node/experiments/slate-experiment-service.ts",
      "shared/node/experiments/slate-experiment-service-engine.ts",
      "shared/node/experiments/slate-experiment-contracts.ts",
      "shared/node/experiments/slate-experiment-policies.ts",
      "shared/node/experiments/slate-experiment-snapshot.ts",
      "shared/node/experiments/slate-experiment-client.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-store-sync/box-store-transfer.ts",
      rewritten: "source/host/boxes/box-store-sync/box-store-transfer.ts",
    }), [
      "host/boxes/box-store-sync/box-store-transfer.ts",
      "host/boxes/box-store-sync/box-store-transfer-contracts.ts",
      "host/boxes/box-store-sync/box-store-transfer-primitives.ts",
      "host/boxes/box-store-sync/box-store-transfer-service.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-store-sync/box-store-sync.ts",
      rewritten: "source/host/boxes/box-store-sync/box-store-sync.ts",
    }), [
      "host/boxes/box-store-sync/box-store-sync.ts",
      "host/boxes/box-store-sync/box-store-sync-contracts.ts",
      "host/boxes/box-store-sync/box-store-sync-observability.ts",
      "host/boxes/box-store-sync/box-store-sync-engine.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/host-runner-composition.ts",
      rewritten: "source/host/host-runner-composition.ts",
    }), [
      "host/host-runner-composition.ts",
      "host/runner/host-runner-permission-surfaces.ts",
      "host/runner/production-turn-settle-host.ts",
      "host/runner/host-runner-turn-scope.ts",
      "host/runner/host-runner-capabilities.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/host-lock.ts",
      rewritten: "source/host/host-lock.ts",
    }), [
      "host/host-lock.ts",
      "host/host-lock-files.ts",
      "host/host-lock-processes.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/local-tool-permission-machinery.ts",
      rewritten: "source/shared/local-tool-permission-machinery.ts",
    }), [
      "shared/local-tool-permission-machinery.ts",
      "shared/local-tool-permission-contracts.ts",
      "shared/local-tool-permission-coverage.ts",
      "shared/local-tool-permission-gate.ts",
      "shared/local-tool-permission-messages.ts",
      "shared/local-tool-permission-requests.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/cursor-plugins/inline-plugin-synthesizer.ts",
      rewritten: "source/packages/plugin-install/inline-plugin-synthesizer.ts",
    }), [
      "packages/plugin-install/inline-plugin-synthesizer.ts",
      "packages/plugin-install/inline-plugin-contracts.ts",
      "packages/plugin-install/inline-plugin-platform.ts",
      "packages/plugin-install/inline-plugin-yaml.ts",
      "packages/plugin-install/inline-plugin-writer.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/user-message-action/conversation-history.ts",
      rewritten: "source/packages/agent/actions/user-message-action/conversation-history.ts",
    }), [
      "packages/agent/actions/user-message-action/conversation-history.ts",
      "packages/agent/actions/user-message-action/conversation-history-content.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/local-exec/grep-output.ts",
      rewritten: "source/packages/local-exec/grep-output.ts",
    }), [
      "packages/local-exec/grep-output.ts",
      "packages/local-exec/grep-output-contracts.ts",
      "packages/local-exec/grep-output-records.ts",
      "packages/local-exec/grep-output-content.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/storage/sqlite-recovery.ts",
      rewritten: "source/host/storage/sqlite-recovery.ts",
    }), [
      "host/storage/sqlite-recovery.ts",
      "host/storage/sqlite-recovery-files.ts",
      "host/storage/sqlite-recovery-quarantine.ts",
      "host/storage/sqlite-recovery-salvage.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/cloud-agents/cloud-agent-request-composition.ts",
      rewritten: "source/host/cloud-agents/cloud-agent-request-composition.ts",
    }), [
      "host/cloud-agents/cloud-agent-request-composition.ts",
      "host/cloud-agents/cloud-agent-request-contracts.ts",
      "host/cloud-agents/cloud-agent-request-model.ts",
      "host/cloud-agents/cloud-agent-repository.ts",
      "host/cloud-agents/cloud-agent-repo-selection.ts",
      "host/cloud-agents/cloud-agent-environment-routing.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/node/experiments/feature-flag-overrides.ts",
      rewritten: "source/shared/node/experiments/feature-flag-overrides.ts",
    }), [
      "shared/node/experiments/feature-flag-overrides.ts",
      "shared/node/experiments/feature-flag-override-state.ts",
      "shared/node/experiments/feature-flag-override-storage.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/lenient-array.ts",
      rewritten: "source/packages/agent/tools/lenient-array.ts",
    }), [
      "packages/agent/tools/lenient-array.ts",
      "packages/agent/tools/lenient-array-json.ts",
      "packages/agent/tools/lenient-array-repair.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/rooms/xuser-wire-normalization.ts",
      rewritten: "source/host/rooms/xuser-wire-normalization.ts",
    }), [
      "host/rooms/xuser-wire-normalization.ts",
      "host/rooms/xuser-wire-contracts.ts",
      "host/rooms/xuser-wire-images.ts",
      "host/rooms/xuser-wire-mirror-entry.ts",
      "host/rooms/xuser-wire-records.ts",
      "host/rooms/xuser-wire-turn-messages.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/node/mcp/mcp-account-slot-lifecycle.ts",
      rewritten: "source/shared/node/mcp/mcp-account-slot-lifecycle.ts",
    }), [
      "shared/node/mcp/mcp-account-slot-lifecycle.ts",
      "shared/node/mcp/mcp-account-slot-contracts.ts",
      "shared/node/mcp/mcp-account-slot-resolution.ts",
      "shared/node/mcp/mcp-account-slot-commit.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/session/session-roster.ts",
      rewritten: "source/host/extensions/session/session-roster.ts",
    }), [
      "host/extensions/session/session-roster.ts",
      "host/extensions/session/session-roster-contracts.ts",
      "host/extensions/session/session-roster-list.ts",
      "host/extensions/session/session-roster-item.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/node/mcp/mcp-listing-summaries.ts",
      rewritten: "source/shared/node/mcp/mcp-listing-summaries.ts",
    }), [
      "shared/node/mcp/mcp-listing-summaries.ts",
      "shared/node/mcp/mcp-listing-summary-contracts.ts",
      "shared/node/mcp/mcp-listing-summary-projectors.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/node/mcp/mcp-definition-source.ts",
      rewritten: "source/shared/node/mcp/mcp-definition-source.ts",
    }), [
      "shared/node/mcp/mcp-definition-source.ts",
      "shared/node/mcp/mcp-definition-source-cache.ts",
      "shared/node/mcp/mcp-definition-source-contracts.ts",
      "shared/node/mcp/mcp-definition-source-identity.ts",
      "shared/node/mcp/mcp-definition-source-projections.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/inference/slate-labeling.ts",
      rewritten: "source/host/extensions/inference/slate-labeling.ts",
    }), [
      "host/extensions/inference/slate-labeling.ts",
      "host/extensions/inference/slate-labeling-contracts.ts",
      "host/extensions/inference/slate-labeling-client.ts",
      "host/extensions/inference/slate-labeling-diagnostics.ts",
      "host/extensions/inference/slate-followup-labeling.ts",
      "host/extensions/inference/slate-post-turn-labeling.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/session/session-profile-files.ts",
      rewritten: "source/host/extensions/session/session-profile-files.ts",
    }), [
      "host/extensions/session/session-profile-files.ts",
      "host/extensions/session/session-profile-contracts.ts",
      "host/extensions/session/session-profile-update.ts",
      "host/extensions/session/session-avatar-reads.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/wallpaper/box-wallpaper-commands.ts",
      rewritten: "source/host/extensions/wallpaper/box-wallpaper-commands.ts",
    }), [
      "host/extensions/wallpaper/box-wallpaper-commands.ts",
      "host/extensions/wallpaper/wallpaper-command-contracts.ts",
      "host/extensions/wallpaper/wallpaper-command-runner.ts",
      "host/extensions/wallpaper/wallpaper-display-discovery.ts",
      "host/extensions/wallpaper/wallpaper-tone-plan.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-summarization/prompt-truncation.ts",
      rewritten: "source/packages/agent-summarization/prompt-truncation.ts",
    }), [
      "packages/agent-summarization/prompt-truncation.ts",
      "packages/agent-summarization/prompt-truncation-allocation.ts",
      "packages/agent-summarization/prompt-truncation-contracts.ts",
      "packages/agent-summarization/prompt-truncation-user-query.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/core/subagent/ci-investigator-subagent.ts",
      rewritten: "source/packages/agent/tools/core/subagent/ci-investigator.ts",
    }), [
      "packages/agent/tools/core/subagent/ci-investigator.ts",
      "packages/agent/tools/core/subagent/ci-investigator-contracts.ts",
      "packages/agent/tools/core/subagent/ci-investigator-prompt.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/transcript/slate-ack-obligation-store.ts",
      rewritten: "source/host/transcript/slate-ack-obligation-store.ts",
    }), [
      "host/transcript/slate-ack-obligation-store.ts",
      "host/transcript/ack-obligation-records.ts",
      "host/transcript/ack-obligation-file.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/chat-inference-proto/client.ts",
      rewritten: "source/packages/chat-inference-proto/client.ts",
    }), ["adapters/interop/chat-inference-proto/client.ts"]);
    assert.deepEqual(sourcePathsOf({
      port: "shared/node/cursor-backend/cursor-inference.ts",
      rewritten: "source/shared/node/cursor-backend/cursor-inference.ts",
    }), ["adapters/interop/cursor-backend/cursor-inference.ts"]);
  });

  it("scores Slate-owned fragments while listing counterpart adapters separately", () => {
    const adapter = "adapters/interop/cursor-backend/summary-origin-marker-adapter.ts";
    const result = overlapForOwnedSources(
      "first second third fourth",
      ["packages/agent/local-policy.ts", adapter],
      ["first second", "second third fourth"],
    );
    assert.deepEqual(result, {
      overlap: 1 / 3,
      baselinePairs: 3,
      identical: false,
      sourceExemptions: [{
        path: adapter,
        reason: "interop adapter: reads the counterpart provider's summary-origin marker",
      }],
    });
    assert.equal(exemptSourceReason("packages/agent/local-policy.ts"), undefined);
  });

  it("keeps external model identifiers and tool marker spellings in inference interop", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/utils/model-utils.ts",
      rewritten: "source/packages/utils/model-markers.ts",
    }), [
      "packages/utils/model-markers.ts",
      "adapters/interop/inference/model-capability-adapter.ts",
      "adapters/interop/inference/tool-marker-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/inference/model-capability-adapter.ts"),
      "interop adapter: maps external model-name fragments into Slate inference capability behavior",
    );
    assert.equal(
      exemptSourceReason("adapters/interop/inference/tool-marker-adapter.ts"),
      "interop adapter: removes external tool-call marker tokens from model arguments",
    );
  });

  it("keeps external thread-session spellings in the interop adapter", () => {
    const adapter = "adapters/interop/agent/thread-session-kind-adapter.ts";
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/claude-helpers.ts",
      rewritten: "source/packages/agent/prompts/thread-bound-session.ts",
    }), ["packages/agent/prompts/thread-bound-session.ts", adapter]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/composer2-cloud-testing-sections.ts",
      rewritten: "source/packages/agent/prompts/cloud-testing-sections.ts",
    }), ["packages/agent/prompts/cloud-testing-sections.ts", adapter]);
    assert.equal(
      exemptSourceReason(adapter),
      "interop adapter: maps external named-session kind strings into Slate thread-session categories",
    );
  });

  it("keeps provider summary metadata in the interop source group", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/user-message-action/synthetic-user-message.ts",
      rewritten: "source/packages/agent/actions/user-message-action/synthetic-user-message.ts",
    }), [
      "packages/agent/actions/user-message-action/synthetic-user-message.ts",
      "packages/agent/actions/user-message-action/notification-message-classifier.ts",
      "adapters/interop/cursor-backend/summary-origin-marker-adapter.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/self-summary/self-summary.ts",
      rewritten: "source/packages/agent/self-summary/self-summary.ts",
    }), [
      "packages/agent/self-summary/self-summary.ts",
      "packages/agent/self-summary/self-summary-message-window.ts",
      "packages/agent/self-summary/self-summary-trigger-policy.ts",
      "adapters/interop/cursor-backend/summary-origin-marker-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/cursor-backend/summary-origin-marker-adapter.ts"),
      "interop adapter: reads the counterpart provider's summary-origin marker",
    );
  });

  it("keeps generated blob serialization outside the Slate-owned serde score", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-kv/serde.ts",
      rewritten: "source/packages/agent-kv/serde.ts",
    }), [
      "packages/agent-kv/serde.ts",
      "packages/agent-kv/serde-contracts.ts",
      "packages/agent-kv/byte-hex-codec.ts",
      "adapters/interop/agent/protobuf-blob-serde-adapter.ts",
    ]);
  });

  it("measures extracted auto-review, VNC, box-store-sync, local-exec, prompt and shared helpers together", () => {
    assert.deepEqual(sourcePathsOf({
      port: "coordinator/gateway/box-vnc-proxy.ts",
      rewritten: "source/coordinator/gateway/box-vnc-proxy.ts",
    }), [
      "coordinator/gateway/box-vnc-proxy.ts",
      "coordinator/gateway/box-vnc-proxy-contracts.ts",
      "coordinator/gateway/box-vnc-url-projection.ts",
      "coordinator/gateway/box-vnc-status-projection.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/prompt-suggestion.ts",
      rewritten: "source/packages/agent/prompts/prompt-suggestion.ts",
    }), [
      "packages/agent/prompts/prompt-suggestion.ts",
      "packages/agent/prompts/prompt-suggestion-contracts.ts",
      "packages/agent/prompts/prompt-suggestion-guidance.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/utils/event-tracking.ts",
      rewritten: "source/packages/agent/utils/event-tracking.ts",
    }), [
      "packages/agent/utils/event-tracking.ts",
      "packages/agent/utils/agent-event-tracker-contracts.ts",
      "packages/agent/utils/agent-event-tracker-context.ts",
      "packages/agent/utils/skill-application-tracking.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/context-processing-code-selection-renderer.ts",
      rewritten: "source/packages/agent/context/code-selection-context.ts",
    }), [
      "packages/agent/context/code-selection-context.ts",
      "packages/agent/context/code-selection-context-contracts.ts",
      "packages/agent/context/code-selection-content-projections.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-kv/blob-store.ts",
      rewritten: "source/packages/agent-kv/blob-store.ts",
    }), [
      "packages/agent-kv/blob-store.ts",
      "packages/agent-kv/blob-store-contracts.ts",
      "packages/agent-kv/blob-content-address.ts",
      "packages/agent-kv/in-memory-blob-store.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/utils/webp-codec.ts",
      rewritten: "source/packages/utils/webp.ts",
    }), [
      "packages/utils/webp.ts",
      "packages/utils/webp-contracts.ts",
      "packages/utils/webp-codec-registry.ts",
      "packages/utils/webp-header.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/host-upgrade/host-bundle-source.ts",
      rewritten: "source/host/extensions/host-upgrade/host-bundle-source.ts",
    }), [
      "host/extensions/host-upgrade/host-bundle-source.ts",
      "host/extensions/host-upgrade/host-bundle-source-contracts.ts",
      "host/extensions/host-upgrade/host-bundle-location.ts",
      "host/extensions/host-upgrade/host-bundle-version-catalog.ts",
      "host/extensions/host-upgrade/host-bundle-download.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-file-transfer.ts",
      rewritten: "source/host/boxes/box-file-transfer.ts",
    }), [
      "host/boxes/box-file-transfer.ts",
      "host/boxes/box-file-transfer-contracts.ts",
      "host/boxes/box-shell-failure-policy.ts",
      "adapters/interop/agent/box-file-write-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/box-file-write-adapter.ts"),
      "interop adapter: maps Slate box file writes to counterpart executor requests and result cases",
    );
    assert.deepEqual(sourcePathsOf({
      port: "shared/send-message-preview.ts",
      rewritten: "source/shared/send-message-preview.ts",
    }), [
      "shared/send-message-preview.ts",
      "shared/send-message-preview-contracts.ts",
      "shared/send-message-preview-connectors.ts",
      "shared/send-message-preview-projector.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/user-info-mcp-meta-instructions.ts",
      rewritten: "source/packages/agent/prompts/mcp-meta-tool-instructions.ts",
    }), [
      "packages/agent/prompts/mcp-meta-tool-instructions.ts",
      "packages/agent/prompts/mcp-meta-tool-instruction-contracts.ts",
      "packages/agent/prompts/mcp-meta-tool-resource-access.ts",
      "packages/agent/prompts/mcp-meta-tool-dynamic-instructions.ts",
      "packages/agent/prompts/mcp-meta-tool-server-instructions.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/extensions/content-search/extension.ts",
      rewritten: "source/host/extensions/content-search/extension.ts",
    }), [
      "host/extensions/content-search/extension.ts",
      "host/extensions/content-search/content-search-gate-lifecycle.ts",
      "host/extensions/content-search/content-search-extension-api.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/utils/cursor-rule-matching.ts",
      rewritten: "source/packages/agent/utils/rule-matching.ts",
    }), [
      "packages/agent/utils/rule-matching.ts",
      "packages/agent/utils/rule-matching-policy.ts",
      "adapters/interop/agent/rule-scope-boundary-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/rule-scope-boundary-adapter.ts"),
      "interop adapter: maps counterpart rule type and directory conventions to a Slate rule-scope location",
    );
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/slate-auto-review-classifier-run.ts",
      rewritten: "source/host/runner/slate-auto-review-classifier-run.ts",
    }), [
      "host/runner/slate-auto-review-classifier-run.ts",
      "host/runner/auto-review-classifier-contracts.ts",
      "adapters/interop/agent/auto-review-classifier-adapter.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/local-exec/extension.ts",
      rewritten: "source/host/local-exec/extension.ts",
    }), [
      "host/local-exec/extension.ts",
      "host/local-exec/local-exec-extension-contracts.ts",
      "host/local-exec/local-exec-extension-api.ts",
      "host/local-exec/local-exec-extension-lifecycle.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "host/boxes/box-store-sync/extension.ts",
      rewritten: "source/host/boxes/box-store-sync/extension.ts",
    }), [
      "host/boxes/box-store-sync/extension.ts",
      "host/boxes/box-store-sync/box-store-sync-extension-composition.ts",
      "host/boxes/box-store-sync/box-store-sync-extension-policies.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/auto-review-classifier-adapter.ts"),
      "interop adapter: encodes Slate review inputs and projects counterpart classifier outcomes",
    );
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/utils/prompt-context-usage-snapshot.ts",
      rewritten: "source/packages/agent/utils/usage-snapshot.ts",
    }), [
      "packages/agent/utils/usage-snapshot.ts",
      "packages/agent/utils/usage-snapshot-contracts.ts",
      "packages/agent/utils/usage-snapshot-cache.ts",
      "adapters/interop/agent/prompt-context-usage-snapshot-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/prompt-context-usage-snapshot-adapter.ts"),
      "interop adapter: serializes usage snapshots and projects their privacy and wire type metadata",
    );
  });

  it("scores skill attachment policy apart from generated selected-context decoding", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/context-processing-selected-context.ts",
      rewritten: "source/packages/agent/selected-context-skills.ts",
    }), [
      "packages/agent/skill-attachment-policy.ts",
      "packages/agent/skill-attachment-contracts.ts",
      "adapters/interop/agent/selected-context-skills-adapter.ts",
    ]);
  });

  it("keeps provider-specific subagent model identifiers behind the catalog adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/composer-subagent-resolution.ts",
      rewritten: "source/packages/agent/tools/subagent-model-resolution.ts",
    }), [
      "packages/agent/tools/subagent-model-resolution.ts",
      "adapters/interop/agent/subagent-model-id-adapter.ts",
    ]);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/subagent-composer-model-ids.ts",
      rewritten: "source/packages/agent/tools/subagent-model-ids.ts",
    }), [
      "packages/agent/tools/subagent-model-ids.ts",
      "adapters/interop/agent/subagent-model-id-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/subagent-model-id-adapter.ts"),
      "interop adapter: maps Slate subagent model tiers to supported catalog ids and renamed legacy values",
    );
  });

  it("keeps ask-question result schemas at the interop boundary", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/core/ask-question/index.ts",
      rewritten: "source/packages/agent/tools/core/ask-question/index.ts",
    }), [
      "packages/agent/tools/core/ask-question/index.ts",
      "packages/agent/tools/core/ask-question/outcome-format.ts",
      "adapters/interop/agent/ask-question-result-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/ask-question-result-adapter.ts"),
      "interop adapter: projects generated ask-question results into Slate outcome formatting and receipt policy",
    );
  });

  it("keeps ask-question completion result decoding and message constructors in interop", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/ask-question-completion.ts",
      rewritten: "source/packages/agent/actions/ask-question-completion.ts",
    }), [
      "packages/agent/actions/ask-question-completion.ts",
      "adapters/interop/agent/ask-question-result-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/ask-question-result-adapter.ts"),
      "interop adapter: projects generated ask-question results into Slate outcome formatting and receipt policy",
    );
  });

  it("keeps generated read operation cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/read.ts",
      rewritten: "source/packages/agent-exec/read-operation.ts",
    }), [
      "packages/agent-exec/read-operation.ts",
      "adapters/interop/agent/read-exec-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/read-exec-operation-adapter.ts"),
      "interop adapter: binds ordinary and privacy-filtered read operations to the counterpart executor message cases",
    );
  });

  it("keeps generated send-message envelopes at the interop boundary", () => {
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/tools/send-message-tool.ts",
      rewritten: "source/host/runner/tools/send-message-tool.ts",
    }), [
      "host/runner/tools/send-message-tool.ts",
      "adapters/interop/agent/send-message-tool-protocol-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/send-message-tool-protocol-adapter.ts"),
      "interop adapter: constructs generated message payloads and tool-call envelopes for the send operation",
    );
  });

  it("scores paused goal lifecycle policy as Slate code", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/user-message-action/reactivate-paused-goal.ts",
      rewritten: "source/packages/agent/actions/user-message-action/reactivate-paused-goal.ts",
    }), [
      "packages/agent/actions/user-message-action/reactivate-paused-goal.ts",
    ]);
    assert.equal(exemptSourceReason("adapters/interop/agent/paused-goal-state-adapter.ts"), undefined);
  });

  it("scores goal continuation wakeups as a Slate-owned user-message action", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/goal-continuation-action-handler.ts",
      rewritten: "source/packages/agent/actions/goal-continuation-action-handler.ts",
    }), [
      "packages/agent/actions/goal-continuation-action-handler.ts",
      "packages/agent/actions/goal-continuation-contracts.ts",
    ]);
    assert.equal(exemptSourceReason("adapters/interop/agent/goal-continuation-message-adapter.ts"), undefined);
  });

  it("scores subscription notification batches as Slate-owned message data", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/subscription-notification-action-handler.ts",
      rewritten: "source/packages/agent/actions/subscription-notification-action-handler.ts",
    }), [
      "packages/agent/actions/subscription-notification-action-handler.ts",
      "packages/agent/actions/subscription-notification-contracts.ts",
    ]);
    assert.equal(exemptSourceReason("adapters/interop/agent/subscription-notification-action-adapter.ts"), undefined);
  });

  it("scores shell command request data alongside the Slate action contract", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/shell-command-action-handler.ts",
      rewritten: "source/packages/agent/actions/shell-command-action-handler.ts",
    }), [
      "packages/agent/actions/shell-command-action-handler.ts",
      "packages/agent/actions/shell-command-action-contracts.ts",
      "adapters/interop/agent/shell-command-action-adapter.ts",
    ]);
  });

  it("scores background completion handling together with its Slate action contract", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/actions/background-task-completion-action-handler.ts",
      rewritten: "source/packages/agent/actions/background-task-completion-action-handler.ts",
    }), [
      "packages/agent/actions/background-task-completion-action-handler.ts",
      "packages/agent/actions/background-task-completion-contracts.ts",
    ]);
  });

  it("keeps background-shell executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/background-shell.ts",
      rewritten: "source/packages/agent-exec/background-shell.ts",
    }), [
      "packages/agent-exec/background-shell.ts",
      "adapters/interop/agent/background-shell-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/background-shell-operation-adapter.ts"),
      "interop adapter: binds background-shell start and input operations to their generated executor message cases",
    );
  });

  it("keeps the foreground shell message case in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/shell.ts",
      rewritten: "source/packages/agent-exec/shell.ts",
    }), [
      "packages/agent-exec/shell.ts",
      "adapters/interop/agent/shell-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/shell-operation-adapter.ts"),
      "interop adapter: binds the foreground shell operation to its generated executor message cases",
    );
  });

  it("keeps file-write executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/write.ts",
      rewritten: "source/packages/agent-exec/write-operation.ts",
    }), [
      "packages/agent-exec/write-operation.ts",
      "adapters/interop/agent/write-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/write-operation-adapter.ts"),
      "interop adapter: binds file writes to the generated executor request and result cases",
    );
  });

  it("keeps adopted-work executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/adopt.ts",
      rewritten: "source/packages/agent-exec/adopt.ts",
    }), [
      "packages/agent-exec/adopt.ts",
      "adapters/interop/agent/adopt-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/adopt-operation-adapter.ts"),
      "interop adapter: binds adopted-work execution to its generated executor request and result cases",
    );
  });

  it("keeps agent-store conflict executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/agent-store-conflict.ts",
      rewritten: "source/packages/agent-exec/agent-store-conflict.ts",
    }), [
      "packages/agent-exec/agent-store-conflict.ts",
      "adapters/interop/agent/agent-store-conflict-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/agent-store-conflict-operation-adapter.ts"),
      "interop adapter: binds agent-store conflict execution to its generated executor request and result cases",
    );
  });

  it("keeps canvas diagnostics executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/canvas-diagnostics.ts",
      rewritten: "source/packages/agent-exec/canvas-diagnostics.ts",
    }), [
      "packages/agent-exec/canvas-diagnostics.ts",
      "adapters/interop/agent/canvas-diagnostics-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/canvas-diagnostics-operation-adapter.ts"),
      "interop adapter: projects generated canvas diagnostics into Slate display records",
    );
  });

  it("keeps conversation-search executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/conversation-search.ts",
      rewritten: "source/packages/agent-exec/conversation-search.ts",
    }), [
      "packages/agent-exec/conversation-search.ts",
      "adapters/interop/agent/conversation-search-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/conversation-search-operation-adapter.ts"),
      "interop adapter: binds conversation search to its generated executor request and result cases",
    );
  });

  it("keeps delete executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/delete.ts",
      rewritten: "source/packages/agent-exec/delete.ts",
    }), [
      "packages/agent-exec/delete.ts",
      "adapters/interop/agent/delete-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/delete-operation-adapter.ts"),
      "interop adapter: binds path deletion to its generated executor request and result cases",
    );
  });

  it("keeps diagnostics executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/diagnostics.ts",
      rewritten: "source/packages/agent-exec/diagnostics.ts",
    }), [
      "packages/agent-exec/diagnostics.ts",
      "adapters/interop/agent/diagnostics-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/diagnostics-operation-adapter.ts"),
      "interop adapter: binds executor diagnostics to their generated request and result cases",
    );
  });

  it("keeps fetch executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/fetch.ts",
      rewritten: "source/packages/agent-exec/fetch.ts",
    }), [
      "packages/agent-exec/fetch.ts",
      "adapters/interop/agent/fetch-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/fetch-operation-adapter.ts"),
      "interop adapter: binds fetch to its generated executor request and result cases",
    );
  });

  it("keeps git-diff executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/git-diff.ts",
      rewritten: "source/packages/agent-exec/git-diff.ts",
    }), [
      "packages/agent-exec/git-diff.ts",
      "adapters/interop/agent/git-diff-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/git-diff-operation-adapter.ts"),
      "interop adapter: binds git-diff requests to their generated executor message cases",
    );
  });

  it("keeps grep executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/grep.ts",
      rewritten: "source/packages/agent-exec/grep.ts",
    }), [
      "packages/agent-exec/grep.ts",
      "adapters/interop/agent/grep-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/grep-operation-adapter.ts"),
      "interop adapter: binds grep requests to their generated executor message cases",
    );
  });

  it("keeps hook executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/hook-executor.ts",
      rewritten: "source/packages/agent-exec/hook-executor.ts",
    }), [
      "packages/agent-exec/hook-executor.ts",
      "adapters/interop/agent/hook-executor-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/hook-executor-adapter.ts"),
      "interop adapter: binds hook execution to its generated executor request and result cases",
    );
  });

  it("keeps directory-listing executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/ls.ts",
      rewritten: "source/packages/agent-exec/ls.ts",
    }), [
      "packages/agent-exec/ls.ts",
      "adapters/interop/agent/ls-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/ls-operation-adapter.ts"),
      "interop adapter: binds directory listing to its generated executor request and result cases",
    );
  });

  it("keeps MCP allowlist precheck cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/mcp-allowlist-precheck.ts",
      rewritten: "source/packages/agent-exec/mcp-allowlist-precheck.ts",
    }), [
      "packages/agent-exec/mcp-allowlist-precheck.ts",
      "adapters/interop/agent/mcp-allowlist-precheck-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/mcp-allowlist-precheck-operation-adapter.ts"),
      "interop adapter: binds MCP allowlist checks to their generated executor request and result cases",
    );
  });

  it("keeps delegated Bash executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/mini-swe-agent-bash.ts",
      rewritten: "source/packages/agent-exec/mini-swe-agent-bash.ts",
    }), [
      "packages/agent-exec/mini-swe-agent-bash.ts",
      "adapters/interop/agent/mini-swe-bash-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/mini-swe-bash-operation-adapter.ts"),
      "interop adapter: binds the delegated Bash operation to generated executor message cases",
    );
  });

  it("keeps Pi Bash executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/pi-bash.ts",
      rewritten: "source/packages/agent-exec/pi-bash.ts",
    }), [
      "packages/agent-exec/pi-bash.ts",
      "adapters/interop/agent/pi-bash-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/pi-bash-operation-adapter.ts"),
      "interop adapter: binds Pi Bash to its generated executor request and result cases",
    );
  });

  it("keeps Pi edit executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/pi-edit.ts",
      rewritten: "source/packages/agent-exec/pi-edit.ts",
    }), [
      "packages/agent-exec/pi-edit.ts",
      "adapters/interop/agent/pi-edit-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/pi-edit-operation-adapter.ts"),
      "interop adapter: binds Pi edit to its generated executor request and result cases",
    );
  });

  it("keeps Pi find executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/pi-find.ts",
      rewritten: "source/packages/agent-exec/pi-find.ts",
    }), [
      "packages/agent-exec/pi-find.ts",
      "adapters/interop/agent/pi-find-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/pi-find-operation-adapter.ts"),
      "interop adapter: binds Pi find to its generated executor request and result cases",
    );
  });

  it("keeps Pi grep executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/pi-grep.ts",
      rewritten: "source/packages/agent-exec/pi-grep.ts",
    }), [
      "packages/agent-exec/pi-grep.ts",
      "adapters/interop/agent/pi-grep-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/pi-grep-operation-adapter.ts"),
      "interop adapter: binds Pi grep to its generated executor request and result cases",
    );
  });

  it("keeps Pi ls executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/pi-ls.ts",
      rewritten: "source/packages/agent-exec/pi-ls.ts",
    }), [
      "packages/agent-exec/pi-ls.ts",
      "adapters/interop/agent/pi-ls-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/pi-ls-operation-adapter.ts"),
      "interop adapter: binds Pi ls to its generated executor request and result cases",
    );
  });

  it("keeps Pi read executor cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/pi-read.ts",
      rewritten: "source/packages/agent-exec/pi-read.ts",
    }), [
      "packages/agent-exec/pi-read.ts",
      "adapters/interop/agent/pi-read-operation-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/pi-read-operation-adapter.ts"),
      "interop adapter: binds Pi read to its generated executor request and result cases",
    );
  });

  it("keeps file-writing wire cases in the interop adapter and uses a Slate-owned resource name", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/pi-write.ts",
      rewritten: "source/packages/agent-exec/pi-write.ts",
    }), [
      "packages/agent-exec/agent-file-write.ts",
      "adapters/interop/agent/agent-file-write-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/agent-file-write-exec-adapter.ts"),
      "interop adapter: binds Slate file-write execution to the counterpart request and result cases",
    );
  });

  it("keeps screen-recording wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/record-screen.ts",
      rewritten: "source/packages/agent-exec/record-screen.ts",
    }), [
      "packages/agent-exec/record-screen.ts",
      "adapters/interop/agent/screen-recording-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/screen-recording-exec-adapter.ts"),
      "interop adapter: binds screen recording to generated executor request and result cases",
    );
  });

  it("keeps request-context wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/request-context.ts",
      rewritten: "source/packages/agent-exec/request-context-operation.ts",
    }), [
      "packages/agent-exec/request-context-operation.ts",
      "adapters/interop/agent/request-context-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/request-context-exec-adapter.ts"),
      "interop adapter: binds request-context execution to generated request and result cases",
    );
  });

  it("keeps shell precheck wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/shell-allowlist-precheck.ts",
      rewritten: "source/packages/agent-exec/shell-allowlist-precheck.ts",
    }), [
      "packages/agent-exec/shell-allowlist-precheck.ts",
      "adapters/interop/agent/shell-allowlist-precheck-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/shell-allowlist-precheck-exec-adapter.ts"),
      "interop adapter: binds shell precheck execution to generated request and result cases",
    );
  });

  it("keeps shell-control wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/shell-control.ts",
      rewritten: "source/packages/agent-exec/shell-control.ts",
    }), [
      "packages/agent-exec/shell-control.ts",
      "adapters/interop/agent/shell-control-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/shell-control-exec-adapter.ts"),
      "interop adapter: binds shell control to generated executor request and result cases",
    );
  });

  it("keeps streamed shell wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/shell-stream.ts",
      rewritten: "source/packages/agent-exec/shell-stream-operation.ts",
    }), [
      "packages/agent-exec/shell-stream-operation.ts",
      "adapters/interop/agent/shell-stream-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/shell-stream-exec-adapter.ts"),
      "interop adapter: binds shell streaming resources to generated executor cases",
    );
  });

  it("keeps subagent wait wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/subagent-await.ts",
      rewritten: "source/packages/agent-exec/subagent-await.ts",
    }), [
      "packages/agent-exec/subagent-await.ts",
      "adapters/interop/agent/subagent-await-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/subagent-await-exec-adapter.ts"),
      "interop adapter: binds subagent waits to generated executor request and result cases",
    );
  });

  it("keeps subagent-control wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/subagent-control.ts",
      rewritten: "source/packages/agent-exec/subagent-control.ts",
    }), [
      "packages/agent-exec/subagent-control.ts",
      "adapters/interop/agent/subagent-control-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/subagent-control-exec-adapter.ts"),
      "interop adapter: binds subagent control to generated executor request and result cases",
    );
  });

  it("keeps web-fetch precheck wire cases in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-exec/web-fetch-allowlist-precheck.ts",
      rewritten: "source/packages/agent-exec/web-fetch-allowlist-precheck.ts",
    }), [
      "packages/agent-exec/web-fetch-allowlist-precheck.ts",
      "adapters/interop/agent/web-fetch-allowlist-precheck-exec-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/web-fetch-allowlist-precheck-exec-adapter.ts"),
      "interop adapter: binds web-fetch precheck to generated executor request and result cases",
    );
  });

  it("scores attached command rendering under a Slate-owned module name", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/context-processing-cursor-commands.ts",
      rewritten: "source/packages/agent/context/cursor-commands-context.ts",
    }), ["packages/agent/context/attached-commands-context.ts"]);
  });

  it("scores the mode switch reminder under its behavior-owned module name", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/utils/agent-mode-guidance.ts",
      rewritten: "source/packages/agent/utils/mode-guidance.ts",
    }), ["packages/agent/utils/mode-switch-reminder.ts"]);
  });

  it("scores pull-request context from Slate copy plus its interop projection", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/context-processing-invocation.ts",
      rewritten: "source/packages/agent/context/github-pr-context.ts",
    }), [
      "packages/agent/context/pull-request-invocation-context.ts",
      "adapters/interop/agent/invocation-platforms-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/invocation-platforms-adapter.ts"),
      "interop adapter: projects generated invocation metadata into Slate conversation, pull-request and editor context",
    );
  });

  it("keeps inherited archive layout data in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/constants/slate-box-archive.ts",
      rewritten: "source/packages/constants/box-archive.ts",
    }), [
      "packages/constants/box-archive.ts",
      "adapters/interop/box/workspace-archive-layout-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/box/workspace-archive-layout-adapter.ts"),
      "interop adapter: holds external workspace and browser-profile exclusion patterns",
    );
  });

  it("keeps shell-specific state syntax in its interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/shell-exec/dump_powershell_state.ts",
      rewritten: "source/packages/shell-exec/dump_powershell_state.ts",
    }), ["adapters/interop/shell/powershell-state-wrapper-adapter.ts"]);
    assert.equal(
      exemptSourceReason("adapters/interop/shell/powershell-state-wrapper-adapter.ts"),
      "interop adapter: constructs the supported shell runtime's state-restore script and command envelope",
    );
  });

  it("keeps legacy worktree-path correction in its workspace adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/core/worktree-paths.ts",
      rewritten: "source/packages/agent/tools/core/worktree-paths.ts",
    }), ["adapters/interop/workspace/legacy-worktree-path-adapter.ts"]);
    assert.equal(
      exemptSourceReason("adapters/interop/workspace/legacy-worktree-path-adapter.ts"),
      "interop adapter: recognizes the former desktop worktree path segment during workspace reads",
    );
  });

  it("keeps the injected browser-runtime script in its interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "host/runner/tools/slate-browser-driver-source.ts",
      rewritten: "source/host/runner/tools/slate-browser-driver-source.ts",
    }), ["adapters/interop/browser/browser-driver-source-adapter.ts"]);
    assert.equal(
      exemptSourceReason("adapters/interop/browser/browser-driver-source-adapter.ts"),
      "interop adapter: supplies the browser-runtime script and state contract executed outside the host",
    );
  });

  it("scores the conversation-action inbox as a generic Slate port", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-core/conversation-actions/receiver-contract.ts",
      rewritten: "source/packages/agent-core/conversation-actions/receiver-contract.ts",
    }), ["packages/agent-core/conversation-actions/action-inbox.ts"]);
  });

  it("keeps counterpart model flags at the persistence-guidance adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/gpt-helpers.ts",
      rewritten: "source/packages/agent/prompts/persistence-instructions.ts",
    }), [
      "packages/agent/prompts/persistence-instructions.ts",
      "adapters/interop/agent/model-persistence-guidance-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/model-persistence-guidance-adapter.ts"),
      "interop adapter: maps counterpart model-version flags to Slate's long-running-work guidance capability",
    );
  });

  it("keeps model-version checks for Git guidance in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/user-info-git-rule-gates.ts",
      rewritten: "source/packages/agent/prompts/composer-git-rule-gate.ts",
    }), [
      "packages/agent/prompts/git-workflow-rule-policy.ts",
      "adapters/interop/agent/git-workflow-model-capability-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/git-workflow-model-capability-adapter.ts"),
      "interop adapter: maps counterpart model and prompt-version flags to Slate's Git-guidance capability",
    );
  });

  it("scores Slate's Git-rule decision apart from model metadata projection", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/user-info-git-rule-gates.ts",
      rewritten: "source/packages/agent/prompts/composer-git-rule-gate.ts",
    }), [
      "packages/agent/prompts/git-workflow-rule-policy.ts",
      "adapters/interop/agent/git-workflow-model-capability-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/git-workflow-model-capability-adapter.ts"),
      "interop adapter: maps counterpart model and prompt-version flags to Slate's Git-guidance capability",
    );
  });

  it("keeps external skill directory conventions in the interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/prompts/user-info-rule-helpers.ts",
      rewritten: "source/packages/agent/prompts/rule-predicates.ts",
    }), [
      "packages/agent/prompts/rule-predicates.ts",
      "adapters/interop/agent/skill-path-layout-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/skill-path-layout-adapter.ts"),
      "interop adapter: recognizes skill-file locations used by supported external workspace layouts",
    );
  });

  it("keeps platform communication names in their interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/automations/platform-communication-tools.ts",
      rewritten: "source/packages/agent/automations/platform-communication-tools.ts",
    }), [
      "packages/agent/automations/platform-communication-tools.ts",
      "adapters/interop/automation/platform-communication-tool-policy-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/automation/platform-communication-tool-policy-adapter.ts"),
      "interop adapter: keeps provider tool names and external server identifiers at the communication boundary",
    );
  });

  it("keeps external tool identifiers in the tool-family interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/tools/all-tools.ts",
      rewritten: "source/packages/agent/tools/tool-families.ts",
    }), [
      "packages/agent/tools/tool-families.ts",
      "adapters/interop/agent/tool-family-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/tool-family-adapter.ts"),
      "interop adapter: maps counterpart tool identifiers into Slate telemetry families",
    );
  });

  it("keeps foreign hook file shapes in the hook interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/hooks/claude-code-types.ts",
      rewritten: "source/packages/hooks/foreign-hook-config.ts",
    }), [
      "packages/hooks/foreign-hook-config.ts",
      "adapters/interop/hooks/foreign-hook-config-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/hooks/foreign-hook-config-adapter.ts"),
      "interop adapter: maps foreign hook event and script shapes into Slate's hook configuration",
    );
  });

  it("keeps foreign hook response fields in the response interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/hooks/validators/preToolUseResponse.ts",
      rewritten: "source/packages/hooks/validators/hook-responses.ts",
    }), ["adapters/interop/hooks/foreign-hook-response-adapter.ts"]);
    assert.equal(
      exemptSourceReason("adapters/interop/hooks/foreign-hook-response-adapter.ts"),
      "interop adapter: validates foreign hook response fields into Slate validation results",
    );
  });

  it("records a removal only when the source is absent and no module imports it", () => {
    const record = { reason: "empty module", evidence: "no runtime statements or importers" };
    assert.deepEqual(removalProblems({
      port: "packages/agent-exec/common.ts",
      record,
      result: { missing: "source" },
      importers: [],
      claimed: false,
      floor: false,
    }), []);
    assert.deepEqual(removalProblems({
      port: "packages/agent-exec/common.ts",
      record,
      result: {},
      importers: ["source/packages/agent-exec/index.ts"],
      claimed: true,
      floor: false,
    }), [
      "packages/agent-exec/common.ts  removal entry still has a source file or cannot be measured",
      "packages/agent-exec/common.ts  removed source still has importers: source/packages/agent-exec/index.ts",
      "packages/agent-exec/common.ts  removed source is also marked rewritten",
    ]);
  });

  it("retires an earlier floor or rewrite claim when the port is removed", () => {
    const removed = "packages/local-exec/services/team-settings-service.ts";
    const ledger = new Map([[removed, "rewritten"], ["shared/active.ts", "rewritten"]]);
    const floors = new Map([[removed, { claim: "floor" }], ["shared/floor.ts", { claim: "floor" }]]);

    withdrawClaimsForRemovedPorts([removed], ledger, floors);

    assert.deepEqual([...ledger], [["shared/active.ts", "rewritten"]]);
    assert.deepEqual([...floors], [["shared/floor.ts", { claim: "floor" }]]);
  });

  it("requires a tracked rewrite claim to match its measured score and stay below the gate", () => {
    const record = { claim: "rewritten", overlap: 0.4, evidence: "behavior suite pins the contract" };
    assert.deepEqual(rewriteRecordProblems({
      port: "shared/example.ts",
      record,
      result: { overlap: 0.4, identical: false },
      threshold: 0.8,
    }), []);
    assert.deepEqual(rewriteRecordProblems({
      port: "shared/example.ts",
      record,
      result: { overlap: 0.9, identical: false },
      threshold: 0.8,
    }), [
      "shared/example.ts  tracked record says 0.4, measured 0.900",
      "shared/example.ts  tracked rewrite claim still overlaps the baseline at or above 0.8",
    ]);
    assert.deepEqual(rewriteRecordProblems({
      port: "shared/contract.ts",
      record: { claim: "floor", overlap: 1, floorReason: "public values", evidence: "tests pin values" },
      result: { overlap: 1, identical: true },
      threshold: 0.8,
    }), []);
  });

  it("only replaces a prior ledger measurement with an explicit refresh reason", () => {
    const priorRewrite = { claim: "rewritten" };
    assert.equal(mayReplaceExistingRewriteRecord(priorRewrite, { claim: "rewritten" }), false);
    assert.equal(mayReplaceExistingRewriteRecord(priorRewrite, {
      claim: "rewritten",
      refreshReason: "The source was structurally updated and measured again.",
    }), true);
    assert.equal(mayReplaceExistingRewriteRecord(priorRewrite, {
      claim: "floor",
      refreshReason: "The new structure preserves its stable public values.",
    }), true);
    assert.equal(mayReplaceExistingRewriteRecord({ claim: "floor" }, { claim: "rewritten" }), true);
    assert.equal(mayReplaceExistingRewriteRecord({ claim: "withdrawn" }, { claim: "rewritten" }), true);
    // This is the untyped JSON shape used by the original local ledger.
    const priorReferenceLedgerEntry = { rewritten: "2026-10-22", notes: "legacy measured claim" } as never;
    assert.equal(mayReplaceExistingRewriteRecord(priorReferenceLedgerEntry, { claim: "rewritten" }), false);
    assert.equal(mayReplaceExistingRewriteRecord(priorReferenceLedgerEntry, {
      claim: "rewritten",
      refreshReason: "Counterpart URI construction moved behind the adapter.",
    }), true);
  });

  it("reopens a historical exemption only with an explicit refresh marker and no remaining adapter source", () => {
    const previous = { claim: "exempt", exemptBecause: "the former port could not be measured" };
    const refreshed = {
      claim: "rewritten",
      overlap: 0.77,
      refreshReason: "the current port now maps to a measurable Slate source",
      replaceExemption: true,
      evidence: "behavior tests pin the refreshed source",
    };
    const measured = { overlap: 0.77, identical: false, sourceExemptions: [] };

    assert.equal(mayReplaceExistingRewriteRecord(previous, refreshed), true);
    assert.equal(mayReplaceExistingRewriteRecord(previous, { ...refreshed, replaceExemption: false }), false);

    assert.deepEqual(rewriteRecordProblems({ port: "skills.ts", record: refreshed, result: measured, threshold: 0.8 }), []);
    assert.deepEqual(rewriteRecordProblems({
      port: "skills.ts",
      record: refreshed,
      result: { ...measured, sourceExemptions: ["adapter"] },
      threshold: 0.8,
    }), ["skills.ts  exemption remeasurement still includes generated or interop-owned source"]);
    assert.deepEqual(rewriteRecordProblems({
      port: "skills.ts",
      record: refreshed,
      result: { ...measured, exempt: "generated" },
      threshold: 0.8,
    }), ["skills.ts  exemption remeasurement still includes generated or interop-owned source"]);
  });

  it("scores Slate error classification separately from its remote schema adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent-client/errors.ts",
      rewritten: "source/packages/agent-client/errors.ts",
    }), [
      "packages/agent-client/errors.ts",
      "packages/agent-client/error-contract.ts",
      "adapters/interop/agent/agent-error-details-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/agent-error-details-adapter.ts"),
      "interop adapter: decodes remote failure details into the Slate error contract",
    );
  });

  it("scores Slate privacy categories separately from the account enum adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/redaction/privacy-mode.ts",
      rewritten: "source/packages/redaction/privacy-mode.ts",
    }), [
      "packages/redaction/privacy-mode.ts",
      "adapters/interop/telemetry/privacy-mode-wire-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/telemetry/privacy-mode-wire-adapter.ts"),
      "interop adapter: translates account privacy enum values to Slate policy categories",
    );
  });

  it("keeps provider OAuth hosts and scopes in the MCP interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/constants/mcp.ts",
      rewritten: "source/packages/constants/mcp-oauth.ts",
    }), [
      "packages/constants/mcp-oauth.ts",
      "adapters/interop/mcp/google-workspace-oauth-provider-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/mcp/google-workspace-oauth-provider-adapter.ts"),
      "interop adapter: carries external MCP OAuth hosts, registration requirements and provider scopes",
    );
  });

  it("keeps generated simulated-message reasons in the git-action prompt interop adapter", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/context-processing-simulated-message.ts",
      rewritten: "source/packages/agent/simulated-message-prompts.ts",
    }), [
      "packages/agent/simulated-message-prompts.ts",
      "adapters/interop/agent/git-action-prompt-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/git-action-prompt-adapter.ts"),
      "interop adapter: projects selected git-action and simulated-reason messages into Slate-owned prompt choices",
    );
  });

  it("scores the Slate sandbox policy separately from external workspace path rules", () => {
    assert.deepEqual(sourcePathsOf({
      port: "packages/shell-exec/sandbox/hardcoded-policy.ts",
      rewritten: "source/packages/shell-exec/sandbox/hardcoded-policy.ts",
    }), [
      "packages/shell-exec/sandbox/hardcoded-policy.ts",
      "adapters/interop/agent/sandbox-workspace-path-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/sandbox-workspace-path-adapter.ts"),
      "interop adapter: keeps external editor and agent workspace paths at the sandbox boundary",
    );
  });

  it("scores prompt-usage policy apart from generated storage serialization", () => {
    const expected = [
      "packages/agent/utils/prompt-token-breakdown.ts",
      "packages/agent/utils/prompt-usage-contracts.ts",
      "adapters/interop/agent/redacted-prompt-token-details-adapter.ts",
    ];
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/utils/prompt-token-breakdown.ts",
      rewritten: "source/packages/agent/utils/prompt-token-breakdown.ts",
    }), expected);
    assert.deepEqual(sourcePathsOf({
      port: "packages/agent/utils/prompt-context-usage-tree.ts",
      rewritten: "source/packages/agent/utils/prompt-context-usage-tree.ts",
    }), [
      "packages/agent/utils/prompt-context-usage-tree.ts",
      "packages/agent/utils/prompt-usage-contracts.ts",
      "adapters/interop/agent/redacted-prompt-token-details-adapter.ts",
    ]);
    assert.equal(
      exemptSourceReason("adapters/interop/agent/redacted-prompt-token-details-adapter.ts"),
      "interop adapter: maps Slate prompt-usage values to generated redacted storage messages",
    );
  });

  it("uses only hash fingerprints when the local-only source baseline is absent", () => {
    const referenceDir = mkdtempSync(join(tmpdir(), "rewrite-overlap-missing-"));
    try {
      const result = spawnSync(process.execPath, [scriptPath, "check"], {
        encoding: "utf8",
        env: { ...process.env, SLATE_WORK_REFERENCE_DIR: referenceDir },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /rewrite claims under 0\.8/);
    } finally {
      rmSync(referenceDir, { recursive: true, force: true });
    }
  });
});

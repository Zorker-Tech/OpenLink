/**
 * How much of the baseline a landed file still reproduces, as a gate on calling it rewritten.
 *
 * A file that was "ported" and a file that was "rewritten in Slate's own logic" look the same in the checklist, so the
 * checklist alone cannot be the evidence for the second claim. This script answers that question with tokens: for every
 * landed file it compares our source against the baseline laid out at the same port path, and reports the share of the
 * baseline's identifier pairs that our file still reproduces.
 *
 * - **overlap** is `common identifier pairs / baseline identifier pairs`. A file that was copied scores 1.0; a file
 *   whose structure, names and decomposition are ours scores low even when it answers the same behaviour.
 * - **bands** group the landed files by that number, so the rewrite pass can run risk-first: the identical files
 *   (largest first), then the near-identical ones, then the rest.
 * - **check** is the gate: no file may be recorded as rewritten in the ledger while it still reproduces the baseline at
 *   or above the threshold. Generated trees and the interop adapters (which must speak the counterpart's wire shape)
 *   are listed below with the reason they are exempt, and the report prints that list so the exemption stays auditable.
 * - a **floor** claim is the third honest book: a file that was rewritten, measured, and found to sit above the threshold
 *   because what is left is the interface other modules call. It needs its measured number and the reason in the ledger,
 *   and `check` refuses a floor claim that could have been a plain rewrite — a floor is a finding, not a shelter.
 *
 * Baseline source is local-only and never committed (`reference/` is git-ignored). The `snapshot` command writes only
 * one-way token-pair hashes and port/ledger metadata, not source tokens. A local run prefers the read-only reference;
 * a clean CI checkout uses that hash-only snapshot. Missing both is a hard error for `check`, never a passing result.
 *
 *   node scripts/rewrite-overlap.mjs report [--threshold 0.8] [--limit 20]
 *   node scripts/rewrite-overlap.mjs queue [--limit 20]          # risk-first rewrite order, largest first
 *   node scripts/rewrite-overlap.mjs check [--threshold 0.8]     # exit 1 when a rewrite claim cannot be measured or is >= threshold
 *   node scripts/rewrite-overlap.mjs file <port>                 # one file's numbers
 *   node scripts/rewrite-overlap.mjs snapshot                    # write hash-only CI baseline fingerprints from local reference
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const commandArgs = process.argv.slice(2);
const isCli = import.meta.filename === process.argv[1];
const command = isCli ? (commandArgs[0] ?? "report") : "noop";
const argument = command === "file" ? commandArgs[1] : undefined;

export function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    if (separator >= 0) {
      options.set(argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(argument.slice(2), next);
      index += 1;
    } else {
      options.set(argument.slice(2), "true");
    }
  }
  return options;
}

const options = parseOptions(commandArgs.slice(1));
const referenceDir = path.resolve(
  options.get("reference-dir") ?? process.env.SLATE_WORK_REFERENCE_DIR ?? path.join(root, "reference"),
);
const baselineDir = path.join(referenceDir, "derived");
const fingerprintManifestPath = path.join(root, "scripts", "rewrite-ci-fingerprints.json.gz");
const threshold = Number(options.get("threshold") ?? 0.8);
const limit = Number(options.get("limit") ?? 20);
if (isCli && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
  console.error("--threshold must be a number from 0 through 1");
  process.exit(2);
}
if (isCli && (!Number.isInteger(limit) || limit < 1)) {
  console.error("--limit must be a positive integer");
  process.exit(2);
}

/**
 * What the gate does not measure, and why. These are not loopholes: each entry is a path prefix that either is not our
 * source at all (generated from a schema) or is an adapter whose text is dictated by the counterpart's wire shape.
 */
const EXEMPT = [
  ["adapters/interop/mcp/google-workspace-oauth-provider-adapter.ts", "interop adapter: carries external MCP OAuth hosts, registration requirements and provider scopes"],
  ["adapters/interop/hooks/foreign-hook-config-adapter.ts", "interop adapter: maps foreign hook event and script shapes into Slate's hook configuration"],
  ["adapters/interop/hooks/foreign-hook-response-adapter.ts", "interop adapter: validates foreign hook response fields into Slate validation results"],
  ["adapters/interop/agent/mcp-builtins-adapter.ts", "interop adapter: encodes Slate built-in tool descriptors and results as generated MCP messages"],
  ["adapters/interop/agent/mcp-result-adapter.ts", "interop adapter: maps generated MCP call/result messages to and from Slate tool outcomes"],
  ["host/runner/tools/communicate-tool.ts", "interop port: communicate-tool message wrapping moved to adapters/interop/agent/communicate-tool-adapter.ts"],
  ["adapters/interop/agent/communicate-tool-adapter.ts", "interop adapter: encodes Slate communicate steps and outcomes as generated Agent messages"],
  ["host/boxes/box-remote-accessor.ts", "interop port: external box transport and generated exec-message handling moved to adapters/interop/agent/box-remote-exec-accessor-adapter.ts"],
  ["adapters/interop/agent/box-remote-exec-accessor-adapter.ts", "interop adapter: carries box transport messages and external exec RPC envelopes"],
  ["adapters/interop/agent/web-search-tool-adapter.ts", "interop adapter: encodes Slate web-search outcomes as generated Agent tool messages"],
  ["adapters/interop/agent/subagent-exec-adapter.ts", "interop adapter: maps Slate subagent run outcomes to the generated exec executor envelope"],
  ["adapters/interop/agent/mcp-file-system-options-adapter.ts", "interop adapter: serializes Slate's file-catalog view into generated MCP descriptors"],
  ["adapters/interop/agent/canvas-diagnostics-operation-adapter.ts", "interop adapter: projects generated canvas diagnostics into Slate display records"],
  ["adapters/interop/agent/navigation-probe-shell-adapter.ts", "interop adapter: executes generated shell probes and reads request-context identifiers"],
  ["adapters/interop/agent/shell-auto-review-read-adapter.ts", "interop adapter: constructs generated read requests and projects text responses for Slate shell policy"],
  ["adapters/interop/agent/transcript-summary-archive-adapter.ts", "interop adapter: decodes generated transcript-summary archives into message blob identifiers"],
  ["adapters/interop/agent/local-read-executor-adapter.ts", "interop adapter: maps generated file-read requests and results to Slate read outcomes"],
  ["adapters/interop/agent/local-shell-stream-executor-adapter.ts", "interop adapter: encodes Slate shell events and handoff outcomes as generated stream messages"],
  ["adapters/interop/agent/shell-terminal-watch-adapter.ts", "interop adapter: decodes generated read and conversation messages for the Slate shell-watch ports"],
  ["adapters/interop/cursor-backend/slate-cloud-agent-client-adapter.ts", "interop adapter: binds generated cloud-agent and dashboard services to Slate client ports"],
  ["adapters/interop/agent/web-fetch-tool-adapter.ts", "interop adapter: encodes Slate web-fetch policy outcomes as generated Agent tool messages"],
  ["adapters/interop/agent/prompt-context-usage-snapshot-adapter.ts", "interop adapter: serializes usage snapshots and projects their privacy and wire type metadata"],
  ["adapters/interop/agent/redacted-prompt-token-details-adapter.ts", "interop adapter: maps Slate prompt-usage values to generated redacted storage messages"],
  ["adapters/interop/agent/tool-family-adapter.ts", "interop adapter: maps counterpart tool identifiers into Slate telemetry families"],
  ["adapters/interop/inference/model-capability-adapter.ts", "interop adapter: maps external model-name fragments into Slate inference capability behavior"],
  ["adapters/interop/inference/tool-marker-adapter.ts", "interop adapter: removes external tool-call marker tokens from model arguments"],
  ["packages/proto/schema/", "external wire schema retained only for counterpart-service interoperability"],
  ["packages/local-exec/sandbox-conversion.ts", "interop port: sandbox policy translation now lives at adapters/interop/agent/sandbox-policy-adapter.ts"],
  ["adapters/interop/agent/sandbox-policy-adapter.ts", "interop adapter: translates Slate sandbox rules to and from the generated executor policy message"],
  ["packages/proto/generated/agent/v1/blob-reference-metadata.ts", "interop adapter metadata derived from counterpart agent message descriptors for blob reachability"],
  ["packages/proto/generated/", "generated from external wire schemas by buf; reviewed, never hand-rewritten"],
  ["packages/redacted-protos/generated/", "generated adapter view from external wire descriptors and Slate redaction annotations"],
  ["shared/observability/sentry-scrub.gen.ts", "generated: mechanically recovered from the counterpart bundle (scripts/recover-sentry-scrub.mjs); the scrubbing rules are data with no hand decisions, and no in-repo generator exists yet"],
  ["shared/node/experiments/experiment-config.gen.ts", "generated data table: the registry of platform settings (parsers, defaults, gates) is machine-owned data; no in-repo generator exists yet"],
  ["packages/mcp-core/", "adapter-side constants for counterpart MCP wire names; no Slate product values"],
  ["packages/agent-store-sync/bcs-transport.ts", "adapter: speaks the counterpart's agent-store wire frame for frame"],
  ["packages/agent-store-sync/bcs-list-adapter.ts", "adapter: maps the counterpart's agent-store listing shape"],
  ["adapters/interop/scm/git-host-url-adapter.ts", "interop adapter: recognizes external Git hostnames and repository path layouts"],
  ["adapters/interop/agent/subagent-type-adapter.ts", "interop adapter: maps counterpart subagent type and state-mapping messages at the boundary"],
  ["adapters/interop/agent/task-client-protocol-adapter.ts", "interop adapter: maps Slate subagent launch and outcome contracts to counterpart messages"],
  ["adapters/interop/agent/smart-mode-classifier-context-adapter.ts", "interop adapter: decodes redacted conversation inputs and builds the counterpart classifier message envelope"],
  ["adapters/interop/agent/interaction-tool-call-adapter.ts", "interop adapter: merges, stamps, and redacts generated tool-call messages at the interaction boundary"],
  ["adapters/interop/agent/await-tool-protocol-adapter.ts", "interop adapter: constructs and projects counterpart await, executor, and tool-call messages"],
  ["adapters/interop/agent/get-mcp-tools-protocol-adapter.ts", "interop adapter: maps Slate MCP catalog views to and from counterpart executor and tool-call messages"],
  ["adapters/interop/agent/remote-hooks-protocol-adapter.ts", "interop adapter: builds and projects generated hook executor messages at the workspace boundary"],
  ["adapters/interop/agent/compaction-skill-message-adapter.ts", "interop adapter: projects external redacted conversation messages and summary markers into Slate skill-retention policy"],
  ["adapters/interop/agent/recording-file-name-adapter.ts", "interop adapter: maps Slate recording-name decisions to the counterpart rejection enum"],
  ["adapters/interop/agent/local-ls-exec-adapter.ts", "interop adapter: executes a local listing while projecting tree and result values into the external Agent LS messages"],
  ["adapters/interop/analytics/action-audit-backend-adapter.ts", "interop adapter: serializes Slate audit records into generated dashboard events and submits request batches"],
  ["adapters/interop/agent/shell-block-result-adapter.ts", "interop adapter: encodes Slate shell-block decisions as the counterpart executor result"],
  ["adapters/interop/agent/smart-mode-classifier-controls-adapter.ts", "interop adapter: projects counterpart request-context classifier settings into Slate controls"],
  ["adapters/interop/agent/smart-mode-classifier-measurement-adapter.ts", "interop adapter: projects generated classifier arguments and results into Slate measurement observations"],
  ["adapters/interop/agent/shell-command-action-adapter.ts", "interop adapter: maps generated shell messages and provider-specific transcript fields to a Slate action port"],
  ["adapters/interop/agent/thread-session-kind-adapter.ts", "interop adapter: maps external named-session kind strings into Slate thread-session categories"],
  ["adapters/interop/automation/automations-cloud-sync-client-adapter.ts", "interop adapter: binds generated automation service calls to the host cloud-sync port"],
  ["adapters/interop/agent/plan-edit-policy-adapter.ts", "interop adapter: maps counterpart agent mode and managed canvas paths to Slate edit-policy inputs"],
  ["adapters/interop/agent/selected-documentation-hydration-adapter.ts", "interop adapter: maps counterpart selected-document records to Slate document references"],
  ["adapters/interop/agent/selected-invocation-context-hydration-adapter.ts", "interop adapter: decodes counterpart invocation-context blobs at the wire boundary"],
  ["adapters/interop/agent/agent-notes-context-adapter.ts", "interop adapter: maps counterpart agent modes to Slate-owned notes-context controls"],
  ["adapters/interop/agent/turn-agent-run-projection-adapter.ts", "interop adapter: clones and redacts counterpart Agent turn state and action at the runner boundary"],
  ["adapters/interop/agent/runner-conversation-state-adapter.ts", "interop adapter: validates and copies the counterpart Agent conversation-state message for the runner"],
  ["adapters/interop/agent/read-tool-prompt-adapter.ts", "interop adapter: maps model-specific read argument and tool-name conventions to a Slate prompt profile"],
  ["adapters/interop/agent/read-tool-protocol-adapter.ts", "interop adapter: converts Slate read contracts to and from counterpart executor and transcript messages"],
  ["adapters/interop/agent/read-exec-operation-adapter.ts", "interop adapter: binds ordinary and privacy-filtered read operations to the counterpart executor message cases"],
  ["adapters/interop/agent/send-message-tool-protocol-adapter.ts", "interop adapter: constructs generated message payloads and tool-call envelopes for the send operation"],
  ["adapters/interop/agent/interrupted-tool-resolution-adapter.ts", "interop adapter: decodes generated redacted interrupted-call resolutions and projects their results"],
  ["adapters/interop/agent/plan-file-read-adapter.ts", "interop adapter: encodes plan-file reads as generated executor requests and projects text results"],
  ["adapters/interop/agent/background-shell-operation-adapter.ts", "interop adapter: binds background-shell start and input operations to their generated executor message cases"],
  ["adapters/interop/agent/shell-operation-adapter.ts", "interop adapter: binds the foreground shell operation to its generated executor message cases"],
  ["adapters/interop/agent/write-operation-adapter.ts", "interop adapter: binds file writes to the generated executor request and result cases"],
  ["adapters/interop/agent/adopt-operation-adapter.ts", "interop adapter: binds adopted-work execution to its generated executor request and result cases"],
  ["adapters/interop/agent/agent-store-conflict-operation-adapter.ts", "interop adapter: binds agent-store conflict execution to its generated executor request and result cases"],
  ["adapters/interop/agent/canvas-diagnostics-operation-adapter.ts", "interop adapter: binds canvas diagnostics to their generated executor request and result cases"],
  ["adapters/interop/agent/conversation-search-operation-adapter.ts", "interop adapter: binds conversation search to its generated executor request and result cases"],
  ["adapters/interop/agent/delete-operation-adapter.ts", "interop adapter: binds path deletion to its generated executor request and result cases"],
  ["adapters/interop/agent/diagnostics-operation-adapter.ts", "interop adapter: binds executor diagnostics to their generated request and result cases"],
  ["adapters/interop/agent/fetch-operation-adapter.ts", "interop adapter: binds fetch to its generated executor request and result cases"],
  ["adapters/interop/agent/git-diff-operation-adapter.ts", "interop adapter: binds git-diff requests to their generated executor message cases"],
  ["adapters/interop/agent/hook-executor-adapter.ts", "interop adapter: binds hook execution to its generated executor request and result cases"],
  ["adapters/interop/agent/ls-operation-adapter.ts", "interop adapter: binds directory listing to its generated executor request and result cases"],
  ["adapters/interop/agent/mcp-allowlist-precheck-operation-adapter.ts", "interop adapter: binds MCP allowlist checks to their generated executor request and result cases"],
  ["adapters/interop/agent/mini-swe-bash-operation-adapter.ts", "interop adapter: binds the delegated Bash operation to generated executor message cases"],
  ["adapters/interop/agent/pi-bash-operation-adapter.ts", "interop adapter: binds Pi Bash to its generated executor request and result cases"],
  ["adapters/interop/agent/pi-edit-operation-adapter.ts", "interop adapter: binds Pi edit to its generated executor request and result cases"],
  ["adapters/interop/agent/pi-find-operation-adapter.ts", "interop adapter: binds Pi find to its generated executor request and result cases"],
  ["adapters/interop/agent/pi-grep-operation-adapter.ts", "interop adapter: binds Pi grep to its generated executor request and result cases"],
  ["adapters/interop/agent/pi-ls-operation-adapter.ts", "interop adapter: binds Pi ls to its generated executor request and result cases"],
  ["adapters/interop/agent/pi-read-operation-adapter.ts", "interop adapter: binds Pi read to its generated executor request and result cases"],
  ["adapters/interop/agent/agent-file-write-exec-adapter.ts", "interop adapter: binds Slate file-write execution to the counterpart request and result cases"],
  ["adapters/interop/agent/screen-recording-exec-adapter.ts", "interop adapter: binds screen recording to generated executor request and result cases"],
  ["adapters/interop/agent/request-context-exec-adapter.ts", "interop adapter: binds request-context execution to generated request and result cases"],
  ["adapters/interop/agent/shell-allowlist-precheck-exec-adapter.ts", "interop adapter: binds shell precheck execution to generated request and result cases"],
  ["adapters/interop/agent/shell-control-exec-adapter.ts", "interop adapter: binds shell control to generated executor request and result cases"],
  ["adapters/interop/agent/shell-stream-exec-adapter.ts", "interop adapter: binds shell streaming resources to generated executor cases"],
  ["adapters/interop/agent/subagent-await-exec-adapter.ts", "interop adapter: binds subagent waits to generated executor request and result cases"],
  ["adapters/interop/agent/subagent-control-exec-adapter.ts", "interop adapter: binds subagent control to generated executor request and result cases"],
  ["adapters/interop/agent/web-fetch-allowlist-precheck-exec-adapter.ts", "interop adapter: binds web-fetch precheck to generated executor request and result cases"],
  ["adapters/interop/box/workspace-archive-layout-adapter.ts", "interop adapter: holds external workspace and browser-profile exclusion patterns"],
  ["adapters/interop/shell/powershell-state-wrapper-adapter.ts", "interop adapter: constructs the supported shell runtime's state-restore script and command envelope"],
  ["adapters/interop/browser/browser-driver-source-adapter.ts", "interop adapter: supplies the browser-runtime script and state contract executed outside the host"],
  ["adapters/interop/workspace/legacy-worktree-path-adapter.ts", "interop adapter: recognizes the former desktop worktree path segment during workspace reads"],
  ["adapters/interop/agent/grep-operation-adapter.ts", "interop adapter: binds grep requests to their generated executor message cases"],
  ["adapters/interop/agent/model-persistence-guidance-adapter.ts", "interop adapter: maps counterpart model-version flags to Slate's long-running-work guidance capability"],
  ["adapters/interop/agent/git-workflow-model-capability-adapter.ts", "interop adapter: maps counterpart model and prompt-version flags to Slate's Git-guidance capability"],
  ["adapters/interop/agent/skill-path-layout-adapter.ts", "interop adapter: recognizes skill-file locations used by supported external workspace layouts"],
  ["adapters/interop/automation/platform-communication-tool-policy-adapter.ts", "interop adapter: keeps provider tool names and external server identifiers at the communication boundary"],
  ["adapters/interop/agent/user-rule-profile-adapter.ts", "interop adapter: maps counterpart model and experiment tags to Slate-owned user-rule profiles"],
  ["adapters/interop/agent/box-store-service-adapter.ts", "interop adapter: translates counterpart box-store presign, multipart and listing messages to the Slate object-store port"],
  ["adapters/interop/agent/testing-prompt-profile-adapter.ts", "interop adapter: maps external model and tool catalog fields to the Slate testing prompt profile"],
  ["adapters/interop/agent/user-message-action-input-adapter.ts", "interop adapter: decodes redacted counterpart messages and derives host action policy from counterpart modes and model markers"],
  ["adapters/interop/agent/execute-plan-action-adapter.ts", "interop adapter: decodes counterpart plan actions and maps Slate plan decisions to generated agent, todo and executor messages"],
  ["adapters/interop/agent/computer-use-executor-adapter.ts", "interop adapter: constructs counterpart computer-use requests and projects its screenshot result to the Slate handoff port"],
  ["adapters/interop/agent/remote-box-resource-adapter.ts", "interop adapter: extracts the counterpart command and computer-action fields used by Slate resource policy"],
  ["adapters/interop/agent/video-attachment-adapter.ts", "interop adapter: maps stored video messages and workspace writes to Slate video attachment values"],
  ["adapters/interop/agent/watch-video-eligibility-adapter.ts", "interop adapter: maps the host background-source enum to Slate watch-video capability inputs"],
  ["adapters/interop/agent/background-task-completion-adapter.ts", "interop adapter: decodes stored task-completion messages and constructs the generated simulated user message"],
  ["adapters/interop/agent/request-scope-telemetry-adapter.ts", "interop adapter: normalizes external client and request metadata into bounded host tags"],
  ["adapters/interop/agent/mode-processing-adapter.ts", "interop adapter: maps the counterpart mode enum at the Slate mode-policy boundary"],
  ["adapters/interop/agent/summarize-action-adapter.ts", "interop adapter: maps provider summary markers and redacted summary records to Slate policy"],
  ["adapters/interop/agent/shell-prompt-profile-adapter.ts", "interop adapter: translates external prompt-version labels into Slate shell capabilities"],
  ["adapters/interop/agent/invocation-platforms-adapter.ts", "interop adapter: projects generated invocation metadata into Slate conversation, pull-request and editor context"],
  ["adapters/interop/analytics/analytics-client.ts", "interop adapter: maps Slate event batches and credentials to the counterpart analytics service"],
  ["adapters/interop/agent/agent-loop-presentation-adapter.ts", "interop adapter: wraps Slate loop decisions in the counterpart error and reminder envelopes"],
  ["adapters/interop/agent/box-mcp-exec-adapter.ts", "interop adapter: sends generated MCP messages to box resources and projects their responses"],
  ["adapters/interop/agent/background-agent-source-adapter.ts", "interop adapter: maps generated background-source values to Slate agent categories"],
  ["adapters/interop/agent/command-classifier-result-adapter.ts", "interop adapter: converts Slate command-classifier outcomes to generated client messages"],
  ["adapters/interop/agent-store/agent-store-id-adapter.ts", "interop adapter: validates external agent-store source, share and store identifier shapes"],
  ["adapters/interop/agent/async-ask-question-completion-adapter.ts", "interop adapter: projects generated completion context into Slate continuation inputs and host updates"],
  ["adapters/interop/agent/mcp-exec-resource-adapter.ts", "interop adapter: binds generated MCP operation messages to the Slate execution-resource port"],
  ["adapters/interop/agent/mcp-meta-tool-options-adapter.ts", "interop adapter: projects discovered tool names and Slate tool policy into generated MCP option messages"],
  ["adapters/interop/agent/mcp-provider-identity-adapter.ts", "interop adapter: maps provider identifiers and states into Slate MCP policy inputs"],
  ["adapters/interop/agent/mcp-catalog-install-adapter.ts", "interop adapter: converts Slate catalog installs to account writer identifiers and fields"],
  ["adapters/interop/agent/ls-directory-tree-adapter.ts", "interop adapter: projects generated directory listings and terminal records to Slate tree values"],
  ["adapters/interop/inference/inference-usage-adapter.ts", "interop adapter: reads provider-reported token usage and records only the fields present"],
  ["adapters/interop/agent/box-window-shell-result-adapter.ts", "interop adapter: executes generated shell requests and projects result variants into Slate window command outcomes"],
  ["adapters/interop/agent/readonly-exec-refusal-adapter.ts", "interop adapter: builds generated permission-denied results for read-only executor policies"],
  ["adapters/interop/agent/hook-config-adapter.ts", "interop adapter: validates the external hook configuration shape and projects its errors"],
  ["adapters/interop/agent/mcp-prompt-tag-adapter.ts", "interop adapter: recognizes the connected MCP prompt marker names"],
  ["adapters/interop/agent/runner-agent-adapters.ts", "interop adapter: maps runner ports to generated request-context, subagent, and client-side update messages"],
  ["adapters/interop/telemetry/privacy-mode-dashboard-adapter.ts", "interop adapter: constructs the counterpart privacy-mode request and maps its enum into Slate's telemetry value"],
  ["adapters/interop/agent/interaction-update-adapter.ts", "interop adapter: constructs generated interaction-update messages and converts Slate token counts to the wire representation"],
  ["adapters/interop/telemetry/privacy-mode-wire-adapter.ts", "interop adapter: translates account privacy enum values to Slate policy categories"],
  ["adapters/interop/agent/sandbox-workspace-path-adapter.ts", "interop adapter: keeps external editor and agent workspace paths at the sandbox boundary"],
  ["adapters/interop/agent/agent-error-details-adapter.ts", "interop adapter: decodes remote failure details into the Slate error contract"],
  ["adapters/interop/agent/document-attachment-adapter.ts", "interop adapter: maps selected document messages and workspace writes to Slate attachment inputs"],
  ["adapters/interop/plugin-marketplace/legacy-skill-reference-adapter.ts", "interop adapter: normalizes marketplace skill source paths and legacy pointer markers"],
  ["adapters/interop/agent/production-box-generated-adapter.ts", "interop adapter: binds external generated box services and messages to the Slate box port"],
  ["adapters/interop/agent/local-exec-codec-adapter.ts", "interop adapter: decodes generated local-exec client and control frames into the host's own codec contract"],
  ["adapters/interop/agent/exec-message-adapter.ts", "interop adapter: encodes and decodes the generated exec RPC envelopes"],
  ["adapters/interop/agent/request-context-adapter.ts", "interop adapter: translates generated request-context messages and redaction at the service boundary"],
  ["adapters/interop/agent/write-operation-adapter.ts", "interop adapter: maps Slate file write requests and outcomes to the generated executor operation"],
  ["adapters/interop/experiments/experiment-bootstrap-adapter.ts", "interop adapter: translates Slate experiment bootstrap requests to the counterpart service protocol"],
  ["adapters/interop/telemetry/trace-runtime-adapter.ts", "interop adapter: maps Slate span contracts to the telemetry runtime API"],
  ["adapters/interop/agent/interaction-query-adapter.ts", "interop adapter: maps Slate-owned interaction request and answer values to generated host messages"],
  ["adapters/interop/agent/redacted-interaction-updates-adapter.ts", "interop adapter: projects privacy-aware Slate update values into the host redacted interaction envelope"],
  ["adapters/interop/agent/redacted-interaction-listener-adapter.ts", "interop adapter: crosses the generated interaction query and update messages at the privacy boundary"],
  ["adapters/interop/agent/todo-schema-adapter.ts", "interop adapter: maps Slate task records to persisted counterpart task messages and redacted storage"],
  ["adapters/interop/agent/todo-tool-adapter.ts", "interop adapter: maps Slate task policy inputs and results to counterpart runner calls and model profile names"],
  ["adapters/interop/agent/plan-file-uri-adapter.ts", "interop adapter: keeps the counterpart's virtual plan-document URI format outside Slate plan policy"],
  ["adapters/interop/agent/user-info-input-adapter.ts", "interop adapter: translates counterpart mode and model metadata into Slate user-info profile and section choices"],
  ["adapters/interop/agent/shell-result-format-adapter.ts", "interop adapter: projects counterpart shell result and sandbox enums into Slate-owned formatter input"],
  ["adapters/interop/agent/agent-conversation-protobuf-adapter.ts", "interop adapter: retains and hydrates the legacy generated conversation checkpoint format at the agent-store boundary"],
  ["adapters/interop/agent/git-action-prompt-adapter.ts", "interop adapter: projects selected git-action and simulated-reason messages into Slate-owned prompt choices"],
  ["adapters/interop/agent/skill-publish-dashboard-adapter.ts", "interop adapter: maps Slate skill publish commands to counterpart dashboard RPC messages"],
  ["adapters/interop/inference/routed-provider-session-adapter.ts", "interop adapter: handles external provider credentials, request protocols and stream responses"],
  ["adapters/interop/inference/slate-inference-session-adapter.ts", "interop adapter: projects Slate session requests to generated inference and attached-media services"],
  ["adapters/interop/agent/workspace-file-write-adapter.ts", "interop adapter: constructs counterpart write-executor messages from Slate workspace-file writes"],
  ["adapters/interop/cursor-backend/mcp-dashboard-client-adapter.ts", "interop adapter: constructs the counterpart dashboard client behind Slate MCP service ports"],
  ["adapters/interop/mcp/host-service-adapter.ts", "interop adapter: maps counterpart account, catalog and auth responses to Slate MCP host views"],
  ["adapters/interop/telemetry/analytics-client-adapter.ts", "interop adapter: constructs the counterpart analytics client and projects optional log authentication"],
  ["adapters/interop/agent/hook-context-adapter.ts", "interop adapter: maps Slate hook context entries to and from the counterpart hook-context message"],
  ["adapters/interop/agent/box-environment-transport-adapter.ts", "interop adapter: copies Slate box environment values into the counterpart control request"],
  ["adapters/interop/agent/box-shell-command-adapter.ts", "interop adapter: projects Slate command inputs into the counterpart shell execution message"],
  ["adapters/interop/agent/box-file-write-adapter.ts", "interop adapter: maps Slate box file writes to counterpart executor requests and result cases"],
  ["adapters/interop/agent/rule-scope-boundary-adapter.ts", "interop adapter: maps counterpart rule type and directory conventions to a Slate rule-scope location"],
  ["adapters/interop/agent/subagent-model-id-adapter.ts", "interop adapter: maps Slate subagent model tiers to supported catalog ids and renamed legacy values"],
  ["adapters/interop/agent/auto-review-classifier-adapter.ts", "interop adapter: encodes Slate review inputs and projects counterpart classifier outcomes"],
  ["adapters/interop/agent/ask-question-result-adapter.ts", "interop adapter: projects generated ask-question results into Slate outcome formatting and receipt policy"],
  ["adapters/interop/agent/auto-review-backend-executor-adapter.ts", "interop adapter: binds Slate auto-review decisions to the backend classifier protocol"],
  ["adapters/interop/agent/meta-agent-notes-adapter.ts", "interop adapter: maps persisted agent modes to Slate notes-folder policy"],
  ["adapters/interop/agent/project-conversation-adapter.ts", "interop adapter: maps generated project-message markers and modes to Slate conversation-boundary policy"],
  ["adapters/interop/agent/box-secrets-adapter.ts", "interop adapter: maps Slate secret policy to the box runtime environment and redaction key"],
  ["adapters/interop/agent/meta-agent-notes-adapter.ts", "interop adapter: maps generated agent modes to Slate notes-folder policy"],
  ["adapters/interop/agent/skill-source-path-adapter.ts", "interop adapter: maps external skill folder layouts to Slate source categories"],
  ["adapters/interop/agent/slate-web-tools-adapter.ts", "interop adapter: maps generated search and fetch services to Slate web results"],
  ["adapters/interop/agent/transcript-occurrence-codec-adapter.ts", "interop adapter: decodes generated transcript turns, messages and steps"],
  ["adapters/interop/agent/production-transcript-mirror-adapter.ts", "interop adapter: binds the production transcript mirror to generated conversation constructors"],
  ["adapters/interop/agent/multitask-subagent-config-adapter.ts", "interop adapter: encodes Slate executor-worker settings as the generated subagent configuration"],
  ["shared/node/egress-tunnel/websocket-client.ts", "thin external WebSocket client boundary; no Slate product behavior belongs in the wrapper"],
  ["adapters/interop/egress-tunnel/websocket-client-adapter.ts", "interop adapter: maps the external ws constructor to the egress tunnel socket port"],
  ["adapters/interop/agent/selected-ui-elements-adapter.ts", "interop adapter: projects counterpart UI element messages into Slate-owned prompt inputs"],
  ["adapters/interop/agent/recent-agents-adapter.ts", "interop adapter: maps counterpart recent-agent messages into Slate-owned transcript references"],
  ["adapters/interop/agent/selected-browsers-adapter.ts", "interop adapter: projects counterpart browser messages into Slate-owned tab references"],
  ["adapters/interop/agent/selected-subagents-adapter.ts", "interop adapter: maps counterpart selected-subagent records into Slate-owned names"],
  ["adapters/interop/agent/selected-console-logs-adapter.ts", "interop adapter: projects counterpart console log messages into prompt-owned log lines"],
  ["adapters/interop/agent/multitask-action-reason-adapter.ts", "interop adapter: maps counterpart simulated reasons into Slate multitask actions"],
  ["packages/agent-exec/shell-hook-approval.ts", "interop shim moved into the adapter tree; its behavior is limited to constructing and copying the counterpart wire message"],
  ["adapters/interop/agent/shell-hook-approval-adapter.ts", "interop adapter: copies counterpart shell hook approval messages and creates the force-prompt variant"],
  ["packages/plugin-install/origin-git-auth.ts", "interop adapter: encodes token authentication as Git per-origin configuration"],
  ["adapters/interop/git/origin-auth-config-adapter.ts", "interop adapter: encodes token authentication as Git per-origin configuration"],
  ["shared/connect-errors.ts", "interop adapter: classifies counterpart Connect error codes and retry metadata"],
  ["adapters/interop/connect/connect-error-adapter.ts", "interop adapter: classifies counterpart Connect error codes and retry metadata"],
  ["host/ports/mcp-state-executor.ts", "interop adapter: groups discovered MCP tools into the counterpart state-executor response"],
  ["adapters/interop/mcp/mcp-state-executor-adapter.ts", "interop adapter: groups discovered MCP tools into the counterpart state-executor response"],
  ["adapters/interop/agent/selected-video-path-adapter.ts", "interop adapter: maps counterpart selected-video attachments to Slate path-trust and preview data"],
  ["packages/shell-exec/sandbox/cache-env.ts", "interop adapter: maps external tool cache environment variables to per-session sandbox paths"],
  ["adapters/interop/shell/sandbox-cache-environment-adapter.ts", "interop adapter: maps external tool cache environment variables to per-session sandbox paths"],
  ["adapters/interop/agent/automation-memory-mount-adapter.ts", "interop adapter: narrows counterpart mounted-store messages to the automation memory mount boundary"],
  ["shared/node/mcp/mcp-image-assets.ts", "interop adapter: translates counterpart MCP image-result variants and appends persisted-image references to the result"],
  ["adapters/interop/mcp/mcp-image-result-adapter.ts", "interop adapter: translates counterpart MCP image-result variants and appends persisted-image references to the result"],
  ["adapters/interop/mcp/mcp-argument-projection-adapter.ts", "interop adapter: projects generated MCP argument values to plain JSON values"],
  ["shared/node/mcp/mcp-result-factory.ts", "interop adapter: constructs counterpart MCP result messages from result operations"],
  ["adapters/interop/mcp/mcp-result-factory.ts", "interop adapter: constructs counterpart MCP result messages from result operations"],
  ["adapters/interop/mcp/connector-auth-tag-adapter.ts", "interop adapter: maps external MCP connector names to bounded telemetry tags"],
  ["host/mcp/host-mcp-auth-completion.ts", "interop adapter: maps external MCP auth-completion events to host wait and transcript actions"],
  ["adapters/interop/mcp/auth-completion-adapter.ts", "interop adapter: maps external MCP auth-completion events to host wait and transcript actions"],
  ["host/automations/listener-integrations.ts", "interop adapter: translates external listener platform names and scope failures to host contracts"],
  ["adapters/interop/automation-listeners/listener-integrations-adapter.ts", "interop adapter: translates external listener platform names and scope failures to host contracts"],
  ["packages/agent/context-processing-pr-hydration.ts", "interop adapter: decodes counterpart pull-request and diff-selection messages stored as blobs"],
  ["adapters/interop/agent/pull-request-hydration-adapter.ts", "interop adapter: decodes counterpart pull-request and diff-selection messages stored as blobs"],
  ["packages/chat-inference/token-limit-error-classification.ts", "interop adapter: recognizes counterpart inference error messages and maps them to Slate token-limit errors"],
  ["adapters/interop/chat-inference-proto/token-limit-error-classifier-adapter.ts", "interop adapter: recognizes counterpart inference error messages and maps them to Slate token-limit errors"],
  ["packages/cursor-plugins/git-subprocess-env.ts", "interop adapter: runs the external Git client with non-interactive environment and configuration"],
  ["packages/agent-exec/serialization.ts", "interop adapter: translates executor operations through counterpart protobuf envelopes"],
  ["packages/cursor-plugins/mcp-placeholder-variables.ts", "interop adapter: reads external marketplace manifest placeholders and loader-owned environment names"],
  ["packages/agent-core/redacted-interaction-listener.ts", "interop adapter: translates generated interaction messages across the redaction boundary"],
  ["coordinator/client-side-tool-v2-relay.ts", "interop adapter: enforces the counterpart renderer tool relay's sequence and replay envelope"],
  ["host/transcript/client-side-tool-v2-producer.ts", "interop adapter: creates counterpart renderer tool messages and their wire envelope"],
  ["shared/rpc/client-side-tool-v2-transport.ts", "interop adapter: encodes and decodes counterpart client-side tool protobuf messages"],
  ["packages/agent-store-sync/sync-client-config.ts", "adapter data: counterpart client values required for agent-store interoperability"],
  ["shared/node/cursor-backend/account-mcp.ts", "adapter: external account MCP service requests"],
  ["shared/node/cursor-backend/backend-mcp-exec.ts", "adapter: external backend MCP execution protocol"],
  ["shared/node/cursor-backend/cursor-generate-image.ts", "adapter: external image-generation service messages"],
  ["shared/node/cursor-backend/cursor-inference.ts", "adapter: the counterpart inference transport and endpoint resolution"],
  ["shared/node/cursor-backend/rpc-tracing.ts", "adapter: tracing metadata for external Connect RPC calls"],
  ["host/automations/slate-automation-cloud-trigger.ts", "interop adapter: maps Slate-owned automation triggers to the counterpart cloud trigger schema"],
  ["host/agents/isolation/conversation-blob-gc.ts", "interop adapter: walks counterpart agent protobuf descriptors to find referenced blob records"],
  ["host/transcript/agent-transcript/trace-format.ts", "interop adapter: projects counterpart conversation messages into transcript trace entries"],
  ["host/transcript/client-side-tool-v2-projection.ts", "interop adapter: projects counterpart agent tool messages into generated renderer protocol messages"],
  ["host/transcript/client-side-tool-v2-inventory.ts", "interop adapter inventory: records generated renderer variants supported by the counterpart protocol"],
  ["packages/agent-exec/agent-tools-file.ts", "interop adapter: writes agent tool output through the counterpart WriteArgs and OutputLocation messages"],
  ["packages/chat-inference-proto/", "adapter: maps Slate conversation and model inputs to counterpart inference messages"],
  ["shared/node/marketplace/cursor-marketplace-client.ts", "interop adapter: sends counterpart plugin-marketplace dashboard requests"],
  ["adapters/interop/plugin-marketplace/dashboard-client-adapter.ts", "interop adapter: sends counterpart plugin-marketplace dashboard requests"],
  ["adapters/interop/plugin-marketplace/mcp-marketplace-adapter.ts", "interop adapter: projects dashboard plugin records and published source links into Slate-owned marketplace inputs"],
  ["adapters/interop/plugin-marketplace/installed-plugin-dashboard-adapter.ts", "interop adapter: constructs external dashboard request messages and projects service responses into the Slate plugin-dashboard port"],
  ["adapters/interop/plugin-marketplace/plugin-manifest-adapter.ts", "interop adapter: parses external plugin and marketplace manifest formats into plugin-install values"],
  ["adapters/interop/cursor-backend/summary-origin-marker-adapter.ts", "interop adapter: reads the counterpart provider's summary-origin marker"],
  ["packages/agent/context/image-data-hydration.ts", "interop adapter: maps generated selected-image variants to the host blob store"],
  ["adapters/interop/agent/selected-image-blob-adapter.ts", "interop adapter: maps generated selected-image variants to the host blob store"],
  ["adapters/interop/agent/protobuf-blob-serde-adapter.ts", "interop adapter: packs generated protobuf messages into the host blob-store interface"],
  ["adapters/interop/agent/selected-context-skills-adapter.ts", "interop adapter: decodes counterpart selected-context skill and rule fields"],
  ["packages/agent/tools/mcp/mcp-error-classification.ts", "interop adapter: maps counterpart MCP transport errors to host tool categories"],
  ["adapters/interop/agent/mcp-error-classification-adapter.ts", "interop adapter: maps counterpart MCP transport errors to host tool categories"],
  ["adapters/interop/agent/agent-conversation-state-serdes-adapter.ts", "interop adapter: binds generated conversation-state message codecs to blob storage"],
  ["host/local-exec/sentry.ts", "interop adapter: binds the daemon crash reporter behind the host privacy gate"],
  ["adapters/interop/telemetry/local-exec-crash-reporter-adapter.ts", "interop adapter: binds the daemon crash reporter behind the host privacy gate"],
];

const read = (file) => readFile(file, "utf8").catch(() => null);
const readBinary = (file) => readFile(file).catch(() => null);

/** The tokens of a file's code: comments and whitespace gone, strings and identifiers kept as they are written. */
export function codeTokens(code) {
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  return withoutComments.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d[\d_.]*|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? [];
}

const pairDigestCache = new Map();

function digestPair(left, right) {
  const cacheKey = `${left.length}:${left}${right.length}:${right}`;
  let digest = pairDigestCache.get(cacheKey);
  if (digest === undefined) {
    // A truncated digest keeps the checked-in manifest compact. A collision can only merge pair counts and raise the
    // measured overlap, so it can conservatively block a rewrite claim but can never make a copied file pass.
    digest = createHash("sha256").update(cacheKey).digest().subarray(0, 8).toString("base64url");
    pairDigestCache.set(cacheKey, digest);
  }
  return digest;
}

function digestTokens(tokens) {
  return createHash("sha256").update(tokens.join(" ")).digest("hex");
}

/** A non-readable baseline fingerprint: token-pair digests and counts, never source tokens. */
export function fingerprintCode(code) {
  const tokens = codeTokens(code);
  const pairCounts = new Map();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const digest = digestPair(tokens[index], tokens[index + 1]);
    pairCounts.set(digest, (pairCounts.get(digest) ?? 0) + 1);
  }
  return {
    baselinePairs: Math.max(0, tokens.length - 1),
    tokenSequenceHash: digestTokens(tokens),
    pairCounts: Object.fromEntries([...pairCounts].sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function overlapOfFingerprint(fingerprint, ourText) {
  const sourceTexts = Array.isArray(ourText) ? ourText : [ourText];
  const ourPairs = new Map();
  for (const sourceText of sourceTexts) {
    const tokens = codeTokens(sourceText);
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      const digest = digestPair(tokens[index], tokens[index + 1]);
      ourPairs.set(digest, (ourPairs.get(digest) ?? 0) + 1);
    }
  }
  let common = 0;
  for (const [digest, count] of Object.entries(fingerprint.pairCounts)) {
    common += Math.min(count, ourPairs.get(digest) ?? 0);
  }
  const identical = sourceTexts.length === 1 && digestTokens(codeTokens(sourceTexts[0])) === fingerprint.tokenSequenceHash;
  return {
    overlap: fingerprint.baselinePairs === 0 ? 0 : common / fingerprint.baselinePairs,
    baselinePairs: fingerprint.baselinePairs,
    identical,
  };
}

/** Consecutive pairs of words, which is what a copy keeps even when it is re-indented or re-ordered. */
function pairs(tokens) {
  const counts = new Map();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const key = `${tokens[index]} ${tokens[index + 1]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function overlapOf(baselineText, ourText) {
  const sourceTexts = Array.isArray(ourText) ? ourText : [ourText];
  const baselinePairs = pairs(codeTokens(baselineText));
  const ourPairs = new Map();
  for (const sourceText of sourceTexts) {
    for (const [key, count] of pairs(codeTokens(sourceText))) {
      ourPairs.set(key, (ourPairs.get(key) ?? 0) + count);
    }
  }
  let total = 0;
  let common = 0;
  for (const [key, count] of baselinePairs) {
    total += count;
    common += Math.min(count, ourPairs.get(key) ?? 0);
  }
  const identical = sourceTexts.length === 1 && codeTokens(baselineText).join(" ") === codeTokens(sourceTexts[0]).join(" ");
  return { overlap: total === 0 ? 0 : common / total, baselinePairs: total, identical };
}

const bandOf = (result) => (result.identical ? "identical" : result.overlap >= 0.95 ? ">= 0.95" : result.overlap >= 0.8 ? ">= 0.80" : "< 0.80");
const bandRank = (result) => (result.identical === true ? 0 : result.overlap >= 0.95 ? 1 : result.overlap >= 0.8 ? 2 : 3);
const exemptReason = (port) => EXEMPT.find(([prefix]) => port === prefix || port.startsWith(prefix))?.[1];
export const exemptSourceReason = (sourcePath) => EXEMPT.find(([prefix]) => sourcePath === prefix || sourcePath.startsWith(prefix))?.[1];

export function overlapForOwnedSources(baselineText, sourcePaths, sourceTexts) {
  const compared = [];
  const sourceExemptions = [];
  for (let index = 0; index < sourceTexts.length; index += 1) {
    const sourcePath = sourcePaths[index] ?? "";
    const reason = exemptSourceReason(sourcePath);
    if (reason === undefined) compared.push(sourceTexts[index]);
    else sourceExemptions.push({ path: sourcePath, reason });
  }
  return {
    ...overlapOf(baselineText, compared),
    sourceExemptions,
  };
}

export function overlapForOwnedFingerprints(fingerprint, sourcePaths, sourceTexts) {
  const compared = [];
  const sourceExemptions = [];
  for (let index = 0; index < sourceTexts.length; index += 1) {
    const sourcePath = sourcePaths[index] ?? "";
    const reason = exemptSourceReason(sourcePath);
    if (reason === undefined) compared.push(sourceTexts[index]);
    else sourceExemptions.push({ path: sourcePath, reason });
  }
  return {
    ...overlapOfFingerprint(fingerprint, compared),
    sourceExemptions,
  };
}

/** Sort measured files by similarity risk first, then measured baseline size (pairs are one less than tokens). */
export function compareRiskFirst(left, right) {
  return bandRank(left) - bandRank(right)
    || (right.baselinePairs ?? -1) - (left.baselinePairs ?? -1)
    || right.lines - left.lines
    || left.port.localeCompare(right.port);
}

async function load({ requireLedger = false } = {}) {
  const layoutText = await read(path.join(referenceDir, "tools", "port-layout.json"));
  const checklistText = await read(path.join(referenceDir, "rewrite-checklist.json"));
  const ledgerText = await read(path.join(referenceDir, "rewrite-ledger.json"));
  const recordsText = await read(path.join(root, "scripts", "rewrite-records.json"));
  const removalsText = await read(path.join(root, "scripts", "rewrite-removals.json"));
  let landed;
  let rewritable;
  let referenceLedgerEntries;
  let baselineFingerprints;
  let usingLocalReference = false;

  if (layoutText !== null && checklistText !== null) {
    if (requireLedger && ledgerText === null) {
      throw new Error(`rewrite ledger is unavailable under ${referenceDir}; refusing to treat an empty ledger as a passing gate`);
    }
    const layout = JSON.parse(layoutText);
    const checklist = JSON.parse(checklistText);
    rewritable = new Set(layout.files.map((file) => file.port));
    referenceLedgerEntries = (ledgerText === null ? { entries: {} } : JSON.parse(ledgerText)).entries;
    landed = [];
    for (const module of checklist.modules) {
      for (const entry of module.entries) {
        if (entry.done !== true) continue;
        landed.push({ port: entry.port, reference: entry.reference, lines: entry.lines, module: module.name, rewritten: entry.rewritten });
      }
    }
    usingLocalReference = true;
  } else {
    const snapshotBytes = await readBinary(fingerprintManifestPath);
    if (snapshotBytes === null) {
      throw new Error(`rewrite baseline is unavailable under ${referenceDir}, and ${path.relative(root, fingerprintManifestPath)} is missing; mount the read-only reference locally or generate the hash-only CI snapshot`);
    }
    let snapshot;
    try {
      snapshot = JSON.parse(gunzipSync(snapshotBytes).toString("utf8"));
    } catch (error) {
      throw new Error(`rewrite fingerprint snapshot is unreadable: ${String(error)}`);
    }
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.landed) || !Array.isArray(snapshot.rewritable) ||
      typeof snapshot.ledgerEntries !== "object" || snapshot.ledgerEntries === null ||
      typeof snapshot.fingerprints !== "object" || snapshot.fingerprints === null) {
      throw new Error("rewrite fingerprint snapshot has an unsupported shape");
    }
    landed = snapshot.landed;
    rewritable = new Set(snapshot.rewritable);
    referenceLedgerEntries = snapshot.ledgerEntries;
    baselineFingerprints = new Map(Object.entries(snapshot.fingerprints));
  }

  if (requireLedger && referenceLedgerEntries === undefined) {
    throw new Error("rewrite claims are missing; refusing to treat an empty ledger as a passing gate");
  }
  if (requireLedger && recordsText === null) {
    throw new Error("tracked rewrite records are missing; refusing to omit claims made in this branch");
  }
  if (requireLedger && removalsText === null) {
    throw new Error("rewrite removal disposition list is missing; refusing to ignore removed files");
  }
  const ledgerEntries = referenceLedgerEntries;
  // A claim only counts when the file is actually being called rewritten: a withdrawn one is back in the queue, an
  // exempt one was never a rewrite (an adapter, a generated file, or our own file with no baseline), and a floor one was
  // rewritten as far as its interface allows and is recorded with that number and reason instead of as a plain rewrite.
  const claimOf = ([, record]) => record.claim;
  const ledger = new Map(Object.entries(ledgerEntries).filter((entry) => claimOf(entry) !== "withdrawn" && claimOf(entry) !== "exempt" && claimOf(entry) !== "floor").map(([port]) => [port, "rewritten"]));
  const floors = new Map(Object.entries(ledgerEntries).filter((entry) => claimOf(entry) === "floor").map(([port, record]) => [port, record]));
  const rewriteRecords = new Map(Object.entries((recordsText === null ? { entries: {} } : JSON.parse(recordsText)).entries));
  const rewriteRecordProblemsFound = [];
  for (const [port, record] of rewriteRecords) {
    const previous = ledgerEntries[port];
    const mayReplace = mayReplaceExistingRewriteRecord(previous, record);
    if (previous !== undefined && !mayReplace) {
      rewriteRecordProblemsFound.push(port + "  tracked record cannot replace the existing reference-ledger claim without its required refresh evidence");
      continue;
    }
    if (record.claim === "rewritten") {
      ledger.set(port, "rewritten");
      floors.delete(port);
    } else if (record.claim === "floor") {
      ledger.delete(port);
      floors.set(port, record);
    }
  }
  const removalEntries = (removalsText === null ? { entries: {} } : JSON.parse(removalsText)).entries;
  const removals = new Map(Object.entries(removalEntries));
  withdrawClaimsForRemovedPorts(removals.keys(), ledger, floors);
  return {
    landed,
    rewritable,
    ledger,
    floors,
    removals,
    rewriteRecords,
    rewriteRecordProblemsFound,
    baselineFingerprints,
    referenceLedgerEntries,
    usingLocalReference,
  };
}

/** Where our file for a landed entry lives: a renamed port records its own source path on the entry. */
export function sourceOf(entry) {
  const source = String(entry.rewritten ?? "").replace(/^source\//, "") || entry.port;
  if (source === "host/boxes/box-remote-accessor.ts") {
    return "adapters/interop/agent/box-remote-exec-accessor-adapter.ts";
  }
  if (source === "host/runner/tools/communicate-tool.ts") {
    return "adapters/interop/agent/communicate-tool-adapter.ts";
  }
  if (source === "packages/local-exec/sandbox-conversion.ts") {
    return "adapters/interop/agent/sandbox-policy-adapter.ts";
  }
  if (source === "packages/agent/tools/composer-subagent-resolution.ts") {
    return "packages/agent/tools/subagent-model-resolution.ts";
  }
  if (source === "packages/agent/prompts/composer-git-rule-gate.ts") {
    return "packages/agent/prompts/git-workflow-rule-policy.ts";
  }
  if (source === "host/mcp/box-mcp-exec.ts") {
    return "adapters/interop/agent/box-mcp-exec-adapter.ts";
  }
  if (source === "packages/utils/git-hosts.ts") {
    return "adapters/interop/scm/git-host-url-adapter.ts";
  }
  if (source === "host/extensions/inference/cursor-session.ts") {
    return "host/extensions/inference/slate-inference-session.ts";
  }
  if (source === "shared/node/marketplace/cursor-marketplace-logo-registry.ts") {
    return "shared/node/marketplace/marketplace-logo-registry.ts";
  }
  if (source === "coordinator/client-side-tool-v2-relay.ts") {
    return "adapters/interop/agent/client-side-tool-v2-relay-adapter.ts";
  }
  if (source === "host/transcript/client-side-tool-v2-producer.ts") {
    return "adapters/interop/agent/client-side-tool-v2-producer-adapter.ts";
  }
  if (source === "shared/rpc/client-side-tool-v2-transport.ts") {
    return "adapters/interop/agent/client-side-tool-v2-transport-adapter.ts";
  }
  if (source === "host/transcript/client-side-tool-v2-projection.ts") {
    return "adapters/interop/agent/client-side-tool-v2-projection-adapter.ts";
  }
  if (source === "host/transcript/client-side-tool-v2-inventory.ts") {
    return "adapters/interop/agent/client-side-tool-v2-inventory-adapter.ts";
  }
  if (source === "packages/plugin-install/mcp-placeholder-variables.ts") {
    return "adapters/interop/plugin-marketplace/mcp-placeholder-variable-adapter.ts";
  }
  if (source === "packages/plugin-install/git-subprocess-env.ts") {
    return "adapters/interop/plugin-marketplace/git-subprocess-adapter.ts";
  }
  if (source === "packages/agent-core/redacted-interaction-listener.ts") {
    return "adapters/interop/agent/redacted-interaction-listener-adapter.ts";
  }
  if (source === "packages/agent-core/conversation-actions/receiver-contract.ts") {
    return "packages/agent-core/conversation-actions/action-inbox.ts";
  }
  if (source === "packages/agent/context/image-data-hydration.ts") {
    return "adapters/interop/agent/selected-image-blob-adapter.ts";
  }
  if (source === "packages/agent/tools/mcp/mcp-error-classification.ts") {
    return "adapters/interop/agent/mcp-error-classification-adapter.ts";
  }
  if (source === "host/local-exec/sentry.ts") {
    return "adapters/interop/telemetry/local-exec-crash-reporter-adapter.ts";
  }
  if (source === "packages/agent/selected-context-skills.ts") {
    return "packages/agent/skill-attachment-policy.ts";
  }
  if (source === "shared/node/marketplace/cursor-marketplace-client.ts") {
    return "adapters/interop/plugin-marketplace/dashboard-client-adapter.ts";
  }
  if (source === "shared/node/mcp/mcp-image-assets.ts") {
    return "adapters/interop/mcp/mcp-image-result-adapter.ts";
  }
  if (source === "shared/node/mcp/mcp-result-factory.ts") {
    return "adapters/interop/mcp/mcp-result-factory.ts";
  }
  if (source === "packages/chat-inference/token-limit-error-classification.ts") {
    return "adapters/interop/chat-inference-proto/token-limit-error-classifier-adapter.ts";
  }
  if (source === "packages/agent/context/pr-hydration.ts") {
    return "adapters/interop/agent/pull-request-hydration-adapter.ts";
  }
  if (source === "host/automations/listener-integrations.ts") {
    return "adapters/interop/automation-listeners/listener-integrations-adapter.ts";
  }
  if (source === "packages/shell-exec/sandbox/cache-env.ts") {
    return "adapters/interop/shell/sandbox-cache-environment-adapter.ts";
  }
  if (source === "host/mcp/host-mcp-auth-completion.ts") {
    return "adapters/interop/mcp/auth-completion-adapter.ts";
  }
  if (source === "host/ports/mcp-state-executor.ts") {
    return "adapters/interop/mcp/mcp-state-executor-adapter.ts";
  }
  if (source === "shared/connect-errors.ts") {
    return "adapters/interop/connect/connect-error-adapter.ts";
  }
  if (source === "packages/plugin-install/origin-git-auth.ts") {
    return "adapters/interop/git/origin-auth-config-adapter.ts";
  }
  if (source === "packages/hooks/validators/hook-responses.ts") {
    return "adapters/interop/hooks/foreign-hook-response-adapter.ts";
  }
  if (source === "packages/local-exec/tests/common.ts") {
    return "packages/local-exec/runtime-permission-policy.ts";
  }
  if (source === "packages/proto/blob-reference-metadata.ts" || source === "host/agents/isolation/blob-reference-metadata.ts") {
    return "adapters/interop/agent/blob-reference-metadata.ts";
  }
  if (source === "host/agents/isolation/conversation-blob-gc.ts") {
    return "adapters/interop/agent/conversation-blob-reachability-adapter.ts";
  }
  if (source === "host/transcript/agent-transcript/trace-format.ts") {
    return "adapters/interop/agent/conversation-message-trace-adapter.ts";
  }
  if (source === "packages/agent-exec/agent-tools-file.ts") {
    return "adapters/interop/agent/agent-tools-file-adapter.ts";
  }
  if (source === "packages/agent-exec/exec-serialization.ts") {
    return "adapters/interop/agent/exec-message-adapter.ts";
  }
  if (source === "packages/agent-exec/pi-write.ts") {
    return "packages/agent-exec/agent-file-write.ts";
  }
  if (source === "packages/agent/context/cursor-commands-context.ts") {
    return "packages/agent/context/attached-commands-context.ts";
  }
  if (source === "packages/agent/utils/mode-guidance.ts") {
    return "packages/agent/utils/mode-switch-reminder.ts";
  }
  if (source === "packages/agent/context/github-pr-context.ts") {
    return "packages/agent/context/pull-request-invocation-context.ts";
  }
  if (source === "packages/shell-exec/dump_powershell_state.ts") {
    return "adapters/interop/shell/powershell-state-wrapper-adapter.ts";
  }
  if (source === "packages/agent/tools/core/worktree-paths.ts") {
    return "adapters/interop/workspace/legacy-worktree-path-adapter.ts";
  }
  if (source === "host/runner/tools/slate-browser-driver-source.ts") {
    return "adapters/interop/browser/browser-driver-source-adapter.ts";
  }
  if (source === "packages/agent-exec/shell-hook-approval.ts") {
    return "adapters/interop/agent/shell-hook-approval-adapter.ts";
  }
  if (source === "shared/node/egress-tunnel/websocket-client.ts") {
    return "adapters/interop/egress-tunnel/websocket-client-adapter.ts";
  }
  if (source === "host/automations/slate-automation-cloud-trigger.ts") {
    return "adapters/interop/cursor-backend/slate-automation-cloud-trigger-adapter.ts";
  }
  return source
    .replace(/^packages\/proto\//, "adapters/interop/proto/")
    .replace(/^packages\/redacted-protos\//, "adapters/interop/redacted-protos/")
    .replace(/^packages\/chat-inference-proto\//, "adapters/interop/chat-inference-proto/")
    .replace(/^shared\/node\/cursor-backend\//, "adapters/interop/cursor-backend/");
}

const SPLIT_SOURCE_GROUPS = new Map([
  ["host/extensions/session/agent-session.ts", [
    "host/extensions/session/session-summary-cache.ts",
    "host/extensions/session/session-subresources.ts",
    "host/extensions/session/session-store-projection.ts",
    "host/extensions/session/session-transcript-reader.ts",
    "host/extensions/session/session-state-operations.ts",
    "host/extensions/session/session-profile-operations.ts",
  ]],
  ["packages/agent/prompts/claude-helpers.ts", [
    "adapters/interop/agent/thread-session-kind-adapter.ts",
  ]],
  ["packages/agent/prompts/composer2-cloud-testing-sections.ts", [
    "adapters/interop/agent/thread-session-kind-adapter.ts",
  ]],
  ["packages/utils/model-utils.ts", [
    "adapters/interop/inference/model-capability-adapter.ts",
    "adapters/interop/inference/tool-marker-adapter.ts",
  ]],
  ["packages/hooks/claude-code-types.ts", [
    "adapters/interop/hooks/foreign-hook-config-adapter.ts",
  ]],
  ["packages/agent/tools/all-tools.ts", [
    "adapters/interop/agent/tool-family-adapter.ts",
  ]],
  ["packages/agent/utils/prompt-token-breakdown.ts", [
    "packages/agent/utils/prompt-usage-contracts.ts",
    "adapters/interop/agent/redacted-prompt-token-details-adapter.ts",
  ]],
  ["packages/agent/utils/prompt-context-usage-tree.ts", [
    "packages/agent/utils/prompt-usage-contracts.ts",
    "adapters/interop/agent/redacted-prompt-token-details-adapter.ts",
  ]],
  ["packages/shell-exec/sandbox/hardcoded-policy.ts", [
    "adapters/interop/agent/sandbox-workspace-path-adapter.ts",
  ]],
  ["packages/redaction/privacy-mode.ts", [
    "adapters/interop/telemetry/privacy-mode-wire-adapter.ts",
  ]],
  ["packages/constants/mcp.ts", [
    "adapters/interop/mcp/google-workspace-oauth-provider-adapter.ts",
  ]],
  ["packages/agent/tools/mcp/builtin-tools.ts", [
    "adapters/interop/agent/mcp-builtins-adapter.ts",
  ]],
  ["packages/agent/tools/mcp/mcp-result-boundary.ts", [
    "adapters/interop/agent/mcp-result-adapter.ts",
  ]],
  ["packages/agent/tools/core/web-fetch.ts", [
    "adapters/interop/agent/web-fetch-tool-adapter.ts",
  ]],
  ["packages/agent/tools/core/web-search.ts", [
    "adapters/interop/agent/web-search-tool-adapter.ts",
  ]],
  ["packages/agent-exec/subagent.ts", [
    "adapters/interop/agent/subagent-exec-adapter.ts",
  ]],
  ["packages/local-exec/mcp-file-system-writer.ts", [
    "adapters/interop/agent/mcp-file-system-options-adapter.ts",
  ]],
  ["packages/agent/tools/core/edit/post-write-result-decoration.ts", [
    "adapters/interop/agent/canvas-diagnostics-operation-adapter.ts",
  ]],
  ["host/runner/slate-action-audit.ts", [
    "adapters/interop/agent/navigation-probe-shell-adapter.ts",
  ]],
  ["host/runner/slate-shell-auto-review-enrichment.ts", [
    "adapters/interop/agent/shell-auto-review-read-adapter.ts",
  ]],
  ["host/transcript/agent-transcript/index.ts", [
    "adapters/interop/agent/transcript-summary-archive-adapter.ts",
  ]],
  ["packages/local-exec/read.ts", [
    "adapters/interop/agent/local-read-executor-adapter.ts",
  ]],
  ["packages/agent-client/errors.ts", [
    "packages/agent-client/error-contract.ts",
    "adapters/interop/agent/agent-error-details-adapter.ts",
  ]],
  ["packages/agent/tools/core/ask-question/index.ts", [
    "packages/agent/tools/core/ask-question/outcome-format.ts",
    "adapters/interop/agent/ask-question-result-adapter.ts",
  ]],
  ["packages/agent/actions/ask-question-completion.ts", [
    "adapters/interop/agent/ask-question-result-adapter.ts",
  ]],
  ["packages/agent/tools/composer-subagent-resolution.ts", [
    "adapters/interop/agent/subagent-model-id-adapter.ts",
  ]],
  ["packages/agent/tools/subagent-composer-model-ids.ts", [
    "adapters/interop/agent/subagent-model-id-adapter.ts",
  ]],
  ["packages/agent/prompts/prompt-suggestion.ts", [
    "packages/agent/prompts/prompt-suggestion-contracts.ts",
    "packages/agent/prompts/prompt-suggestion-guidance.ts",
  ]],
  ["coordinator/gateway/box-vnc-proxy.ts", [
    "coordinator/gateway/box-vnc-proxy-contracts.ts",
    "coordinator/gateway/box-vnc-url-projection.ts",
    "coordinator/gateway/box-vnc-status-projection.ts",
  ]],
  ["packages/agent/utils/prompt-context-usage-snapshot.ts", [
    "packages/agent/utils/usage-snapshot-contracts.ts",
    "packages/agent/utils/usage-snapshot-cache.ts",
    "adapters/interop/agent/prompt-context-usage-snapshot-adapter.ts",
  ]],
  ["host/boxes/box-store-sync/extension.ts", [
    "host/boxes/box-store-sync/box-store-sync-extension-composition.ts",
    "host/boxes/box-store-sync/box-store-sync-extension-policies.ts",
  ]],
  ["host/local-exec/extension.ts", [
    "host/local-exec/local-exec-extension-contracts.ts",
    "host/local-exec/local-exec-extension-api.ts",
    "host/local-exec/local-exec-extension-lifecycle.ts",
  ]],
  ["host/extensions/auto-review/extension.ts", [
    "host/extensions/auto-review/auto-review-extension-composition.ts",
  ]],
  ["host/extensions/session/extension.ts", [
    "host/extensions/session/session-extension-composition.ts",
    "host/extensions/session/session-extension-contracts.ts",
  ]],
  ["host/extensions/inference/extension.ts", [
    "host/extensions/inference/inference-extension-composition.ts",
    "host/extensions/inference/inference-extension-contracts.ts",
  ]],
  ["host/memory/extension.ts", [
    "host/memory/memory-extension-composition.ts",
    "host/memory/memory-extension-contracts.ts",
  ]],
  ["host/memory/production.ts", [
    "host/memory/memory-production-contracts.ts",
    "host/memory/memory-synthesis-production.ts",
  ]],
  ["host/slate-multitask.ts", [
    "host/slate-multitask-guidance.ts",
  ]],
  ["host/runner/box-reference-docs.ts", [
    "host/runner/box-reference-doc-content.ts",
    "host/runner/box-reference-doc-provisioning.ts",
  ]],
  ["packages/agent/actions/meta-agent-notes.ts", [
    "packages/agent/actions/meta-agent-notes-contracts.ts",
    "packages/agent/actions/meta-agent-notes-policy.ts",
  ]],
  ["host/runner/slate-auto-review-classifier-run.ts", [
    "host/runner/auto-review-classifier-contracts.ts",
    "adapters/interop/agent/auto-review-classifier-adapter.ts",
  ]],
  ["packages/agent/utils/cursor-rule-matching.ts", [
    "packages/agent/utils/rule-matching-policy.ts",
    "adapters/interop/agent/rule-scope-boundary-adapter.ts",
  ]],
  ["host/extensions/content-search/extension.ts", [
    "host/extensions/content-search/content-search-gate-lifecycle.ts",
    "host/extensions/content-search/content-search-extension-api.ts",
  ]],
  ["packages/agent/prompts/user-info-mcp-meta-instructions.ts", [
    "packages/agent/prompts/mcp-meta-tool-instruction-contracts.ts",
    "packages/agent/prompts/mcp-meta-tool-resource-access.ts",
    "packages/agent/prompts/mcp-meta-tool-dynamic-instructions.ts",
    "packages/agent/prompts/mcp-meta-tool-server-instructions.ts",
  ]],
  ["shared/send-message-preview.ts", [
    "shared/send-message-preview-contracts.ts",
    "shared/send-message-preview-connectors.ts",
    "shared/send-message-preview-projector.ts",
  ]],
  ["shared/webauthn-gateway.ts", [
    "shared/webauthn-gateway-contracts.ts",
    "shared/webauthn-origin-policy.ts",
  ]],
  ["host/boxes/box-file-transfer.ts", [
    "host/boxes/box-file-transfer-contracts.ts",
    "host/boxes/box-shell-failure-policy.ts",
    "adapters/interop/agent/box-file-write-adapter.ts",
  ]],
  ["host/extensions/host-upgrade/host-bundle-source.ts", [
    "host/extensions/host-upgrade/host-bundle-source-contracts.ts",
    "host/extensions/host-upgrade/host-bundle-location.ts",
    "host/extensions/host-upgrade/host-bundle-version-catalog.ts",
    "host/extensions/host-upgrade/host-bundle-download.ts",
  ]],
  ["packages/utils/webp-codec.ts", [
    "packages/utils/webp-contracts.ts",
    "packages/utils/webp-codec-registry.ts",
    "packages/utils/webp-header.ts",
  ]],
  ["packages/agent-kv/blob-store.ts", [
    "packages/agent-kv/blob-store-contracts.ts",
    "packages/agent-kv/blob-content-address.ts",
    "packages/agent-kv/in-memory-blob-store.ts",
  ]],
  ["packages/agent/utils/event-tracking.ts", [
    "packages/agent/utils/agent-event-tracker-contracts.ts",
    "packages/agent/utils/agent-event-tracker-context.ts",
    "packages/agent/utils/skill-application-tracking.ts",
  ]],
  ["packages/agent/context-processing-code-selection-renderer.ts", [
    "packages/agent/context/code-selection-context-contracts.ts",
    "packages/agent/context/code-selection-content-projections.ts",
  ]],
  ["packages/agent/self-summary/self-summary.ts", [
    "packages/agent/self-summary/self-summary-message-window.ts",
    "packages/agent/self-summary/self-summary-trigger-policy.ts",
    "adapters/interop/cursor-backend/summary-origin-marker-adapter.ts",
  ]],
  ["host/extensions/inference/cursor-session.ts", [
    "adapters/interop/inference/slate-inference-session-adapter.ts",
  ]],
  ["host/extensions/session/production.ts", [
    "host/extensions/session/session-production-store.ts",
    "host/extensions/session/session-production-maintenance.ts",
    "host/extensions/session/session-production-handoff.ts",
    "adapters/interop/agent/computer-use-executor-adapter.ts",
  ]],
  ["host/runner/remote-box-resources.ts", [
    "adapters/interop/agent/remote-box-resource-adapter.ts",
    "adapters/interop/agent/computer-use-executor-adapter.ts",
  ]],
  ["packages/agent-core/interaction-queries.ts", [
    "adapters/interop/agent/interaction-query-adapter.ts",
    "adapters/interop/agent/redacted-interaction-listener-adapter.ts",
  ]],
  ["packages/agent-core/redacted-interaction-updates.ts", [
    "adapters/interop/agent/redacted-interaction-updates-adapter.ts",
  ]],
  ["packages/agent/utils/request-id.ts", [
    "packages/agent/utils/invocation-id.ts",
    "adapters/interop/agent/request-scope-telemetry-adapter.ts",
  ]],
  ["packages/agent/mode-processing.ts", [
    "adapters/interop/agent/mode-processing-adapter.ts",
  ]],
  ["packages/agent/prompts/multitask-mode-user-reminder.ts", [
    "adapters/interop/agent/mode-processing-adapter.ts",
  ]],
  ["packages/agent/prompts/gpt-helpers.ts", [
    "adapters/interop/agent/model-persistence-guidance-adapter.ts",
  ]],
  ["packages/agent/prompts/user-info-git-rule-gates.ts", [
    "adapters/interop/agent/git-workflow-model-capability-adapter.ts",
  ]],
  ["packages/agent/prompts/user-info-rule-helpers.ts", [
    "adapters/interop/agent/skill-path-layout-adapter.ts",
  ]],
  ["packages/agent/automations/platform-communication-tools.ts", [
    "adapters/interop/automation/platform-communication-tool-policy-adapter.ts",
  ]],
  ["packages/agent/actions/summarize-action-handler.ts", [
    "packages/agent/actions/summarize-action-contracts.ts",
    "packages/agent/actions/summarize-action-system-prompt.ts",
    "packages/agent/actions/summarize-action-state.ts",
    "adapters/interop/agent/mode-processing-adapter.ts",
    "adapters/interop/agent/summarize-action-adapter.ts",
  ]],
  ["packages/agent/actions/async-ask-question-completion-action-handler.ts", [
    "adapters/interop/agent/async-ask-question-completion-adapter.ts",
  ]],
  ["packages/agent/actions/background-task-completion-action-handler.ts", [
    "packages/agent/actions/background-task-completion-contracts.ts",
  ]],
  ["packages/agent/actions/goal-continuation-action-handler.ts", [
    "packages/agent/actions/goal-continuation-contracts.ts",
  ]],
  ["packages/agent/actions/subscription-notification-action-handler.ts", [
    "packages/agent/actions/subscription-notification-contracts.ts",
  ]],
  ["packages/agent/actions/user-message-action/interrupted-tool-reconstruction.ts", [
    "adapters/interop/agent/interrupted-tool-resolution-adapter.ts",
  ]],
  ["packages/agent/tools/core/create-plan/backend-plan-utils.ts", [
    "adapters/interop/agent/plan-file-read-adapter.ts",
  ]],
  ["packages/agent-exec/mcp.ts", [
    "adapters/interop/agent/mcp-exec-resource-adapter.ts",
    "adapters/interop/agent/mcp-provider-identity-adapter.ts",
  ]],
  ["host/boxes/generated-production.ts", [
    "host/boxes/production-box-access-policies.ts",
    "adapters/interop/agent/production-box-generated-adapter.ts",
  ]],
  ["host/boxes/box-windows.ts", [
    "adapters/interop/agent/box-window-shell-result-adapter.ts",
  ]],
  ["host/extensions/inference/inference-service.ts", [
    "adapters/interop/inference/inference-usage-adapter.ts",
  ]],
  ["packages/agent-exec/readonly-resource-accessor.ts", [
    "adapters/interop/agent/readonly-exec-refusal-adapter.ts",
  ]],
  ["packages/agent-exec/background-shell.ts", [
    "adapters/interop/agent/background-shell-operation-adapter.ts",
  ]],
  ["packages/agent-exec/adopt.ts", [
    "adapters/interop/agent/adopt-operation-adapter.ts",
  ]],
  ["packages/agent-exec/agent-store-conflict.ts", [
    "adapters/interop/agent/agent-store-conflict-operation-adapter.ts",
  ]],
  ["packages/agent-exec/canvas-diagnostics.ts", [
    "adapters/interop/agent/canvas-diagnostics-operation-adapter.ts",
  ]],
  ["packages/agent-exec/conversation-search.ts", [
    "adapters/interop/agent/conversation-search-operation-adapter.ts",
  ]],
  ["packages/agent-exec/delete.ts", [
    "adapters/interop/agent/delete-operation-adapter.ts",
  ]],
  ["packages/agent-exec/diagnostics.ts", [
    "adapters/interop/agent/diagnostics-operation-adapter.ts",
  ]],
  ["packages/agent-exec/fetch.ts", [
    "adapters/interop/agent/fetch-operation-adapter.ts",
  ]],
  ["packages/agent-exec/git-diff.ts", [
    "adapters/interop/agent/git-diff-operation-adapter.ts",
  ]],
  ["packages/agent-exec/grep.ts", [
    "adapters/interop/agent/grep-operation-adapter.ts",
  ]],
  ["packages/agent-exec/hook-executor.ts", [
    "adapters/interop/agent/hook-executor-adapter.ts",
  ]],
  ["packages/agent-exec/ls.ts", [
    "adapters/interop/agent/ls-operation-adapter.ts",
  ]],
  ["packages/agent-exec/mcp-allowlist-precheck.ts", [
    "adapters/interop/agent/mcp-allowlist-precheck-operation-adapter.ts",
  ]],
  ["packages/agent-exec/mini-swe-agent-bash.ts", [
    "adapters/interop/agent/mini-swe-bash-operation-adapter.ts",
  ]],
  ["packages/agent-exec/pi-bash.ts", [
    "adapters/interop/agent/pi-bash-operation-adapter.ts",
  ]],
  ["packages/agent-exec/pi-edit.ts", [
    "adapters/interop/agent/pi-edit-operation-adapter.ts",
  ]],
  ["packages/agent-exec/pi-find.ts", [
    "adapters/interop/agent/pi-find-operation-adapter.ts",
  ]],
  ["packages/agent-exec/pi-grep.ts", [
    "adapters/interop/agent/pi-grep-operation-adapter.ts",
  ]],
  ["packages/agent-exec/pi-ls.ts", [
    "adapters/interop/agent/pi-ls-operation-adapter.ts",
  ]],
  ["packages/agent-exec/pi-read.ts", [
    "adapters/interop/agent/pi-read-operation-adapter.ts",
  ]],
  ["packages/agent-exec/pi-write.ts", [
    "adapters/interop/agent/agent-file-write-exec-adapter.ts",
  ]],
  ["packages/agent-exec/record-screen.ts", [
    "adapters/interop/agent/screen-recording-exec-adapter.ts",
  ]],
  ["packages/agent-exec/request-context.ts", [
    "adapters/interop/agent/request-context-exec-adapter.ts",
  ]],
  ["packages/agent-exec/shell-allowlist-precheck.ts", [
    "adapters/interop/agent/shell-allowlist-precheck-exec-adapter.ts",
  ]],
  ["packages/agent-exec/shell-control.ts", [
    "adapters/interop/agent/shell-control-exec-adapter.ts",
  ]],
  ["packages/agent-exec/shell-stream.ts", [
    "adapters/interop/agent/shell-stream-exec-adapter.ts",
  ]],
  ["packages/agent-exec/subagent-await.ts", [
    "adapters/interop/agent/subagent-await-exec-adapter.ts",
  ]],
  ["packages/agent-exec/subagent-control.ts", [
    "adapters/interop/agent/subagent-control-exec-adapter.ts",
  ]],
  ["packages/agent-exec/web-fetch-allowlist-precheck.ts", [
    "adapters/interop/agent/web-fetch-allowlist-precheck-exec-adapter.ts",
  ]],
  ["packages/constants/slate-box-archive.ts", [
    "adapters/interop/box/workspace-archive-layout-adapter.ts",
  ]],
  ["packages/agent-exec/shell.ts", [
    "adapters/interop/agent/shell-operation-adapter.ts",
  ]],
  ["packages/agent-exec/write.ts", [
    "adapters/interop/agent/write-operation-adapter.ts",
  ]],
  ["host/mcp/legacy-live-references.ts", [
    "adapters/interop/plugin-marketplace/legacy-skill-reference-adapter.ts",
  ]],
  ["host/mcp/extension.ts", [
    "host/mcp/plugin-skills-lifecycle.ts",
  ]],
  ["packages/hooks/validators/hooksConfig.ts", [
    "adapters/interop/agent/hook-config-adapter.ts",
  ]],
  ["host/transcript/send-acceptance.ts", [
    "host/transcript/send-acceptance-transcript.ts",
    "host/transcript/send-acceptance-roster.ts",
    "host/transcript/send-acceptance-echoes.ts",
    "host/transcript/send-acceptance-tracing.ts",
  ]],
  ["packages/agent/diff-processing.ts", [
    "packages/agent/diff-processing-budget.ts",
    "packages/agent/diff-processing-contracts.ts",
    "packages/agent/diff-processing-summary.ts",
    "packages/agent/diff-processing-truncation.ts",
  ]],
  ["packages/agent-exec/remote.ts", [
    "adapters/interop/agent/exec-message-adapter.ts",
  ]],
  ["packages/agent-exec/read.ts", [
    "adapters/interop/agent/read-exec-operation-adapter.ts",
  ]],
  ["packages/agent/utils/request-context.ts", [
    "adapters/interop/agent/request-context-adapter.ts",
  ]],
  ["packages/agent/prompts/user-info-section.ts", [
    "packages/agent/prompts/user-info-section-parts.ts",
  ]],
  ["shared/node/mcp/mcp-catalog-flow.ts", [
    "adapters/interop/agent/mcp-catalog-install-adapter.ts",
  ]],
  ["packages/utils/image-resize.ts", [
    "packages/utils/image-resize-byte-budget.ts",
    "packages/utils/image-resize-dimensions.ts",
    "packages/utils/image-resize-webp.ts",
  ]],
  ["packages/utils/path-utils.ts", [
    "packages/utils/path-resolution.ts",
    "packages/utils/worktree-path-guard.ts",
  ]],
  ["packages/agent/prompts/user-info-git-prompt-sections.ts", [
    "packages/agent/prompts/git-commit-safety-section.ts",
    "packages/agent/prompts/git-pull-request-section.ts",
  ]],
  ["packages/agent/tools/core/ls/formatters.ts", [
    "packages/agent/tools/core/ls/directory-tree-contracts.ts",
    "packages/agent/tools/core/ls/directory-tree-renderer.ts",
    "packages/agent/tools/core/ls/directory-tree-terminal-metadata.ts",
    "adapters/interop/agent/ls-directory-tree-adapter.ts",
  ]],
  ["packages/agent/context-processing-document.ts", [
    "packages/agent/context/document-attachment-contracts.ts",
    "adapters/interop/agent/document-attachment-adapter.ts",
  ]],
  ["packages/agent/utils/prompt-tag-parsing.ts", [
    "packages/agent/utils/prompt-tag-range-parser.ts",
    "adapters/interop/agent/mcp-prompt-tag-adapter.ts",
  ]],
  ["packages/context/core.ts", [
    "packages/context/context-contracts.ts",
    "packages/context/context-node.ts",
  ]],
  ["packages/agent/utils/scoped-rule-filtering.ts", [
    "packages/agent/utils/rule-scope-frontmatter.ts",
  ]],
  ["host/host-paths.ts", [
    "host/host-data-layout.ts",
    "host/host-data-root-alias.ts",
    "host/host-path-projections.ts",
  ]],
  ["packages/agent/tools/core/shell/prompts/dsv3.ts", [
    "adapters/interop/agent/shell-prompt-profile-adapter.ts",
  ]],
  ["packages/agent/context-processing-invocation-platforms.ts", [
    "adapters/interop/agent/invocation-platforms-adapter.ts",
  ]],
  ["shared/node/analytics/product-analytics.ts", [
    "adapters/interop/analytics/analytics-client.ts",
  ]],
  ["packages/agent/loop-detection/agent-loop-detector.ts", [
    "adapters/interop/agent/agent-loop-presentation-adapter.ts",
  ]],
  ["shared/node/experiments/statsig-bootstrap.ts", [
    "adapters/interop/experiments/experiment-bootstrap-adapter.ts",
  ]],
  ["packages/context/otel.ts", [
    "adapters/interop/telemetry/trace-runtime-adapter.ts",
  ]],
  ["host/boxes/production.ts", [
    "host/boxes/production-box-operations.ts",
    "host/boxes/production-box-environment.ts",
    "host/boxes/production-box-standalone.ts",
  ]],
  ["host/telemetry/lifecycle-telemetry.ts", [
    "host/telemetry/lifecycle-event-names.ts",
    "host/telemetry/host-lifecycle-telemetry.ts",
    "host/telemetry/box-runtime-telemetry.ts",
  ]],
  ["host/extensions/codebase-telemetry/codebase-telemetry-service.ts", [
    "host/extensions/codebase-telemetry/codebase-telemetry-session.ts",
  ]],
  ["packages/agent/tools/core/edit/common.ts", [
    "adapters/interop/agent/write-operation-adapter.ts",
  ]],
  ["host/runner/production-turn-run-shell-adapter.ts", [
    "adapters/interop/agent/runner-conversation-state-adapter.ts",
    "host/runner/production-turn-run-lease.ts",
  ]],
  ["host/automations/extension.ts", [
    "adapters/interop/automation/automations-cloud-sync-client-adapter.ts",
    "host/automations/automation-extension-policies.ts",
  ]],
  ["packages/agent/actions/shell-command-action-handler.ts", [
    "adapters/interop/agent/shell-command-action-adapter.ts",
  ]],
  ["packages/agent/utils/smart-mode-classifier-measurement.ts", [
    "adapters/interop/agent/smart-mode-classifier-measurement-adapter.ts",
  ]],
  ["shared/node/mcp/mcp-marketplace.ts", [
    "shared/node/mcp/mcp-marketplace-contracts.ts",
    "shared/node/mcp/mcp-marketplace-projection.ts",
    "shared/node/mcp/mcp-marketplace-fetch.ts",
    "adapters/interop/plugin-marketplace/mcp-marketplace-adapter.ts",
  ]],
  ["packages/agent/prompts/deprecated-do-not-use/shared.ts", [
    "packages/agent/prompts/mcp-file-system-instructions.ts",
  ]],
  ["packages/agent/context-processing-video-path.ts", [
    "adapters/interop/agent/selected-video-path-adapter.ts",
  ]],
  ["shared/observability/connector-auth-telemetry.ts", [
    "adapters/interop/mcp/connector-auth-tag-adapter.ts",
  ]],
  ["packages/agent/prompts/bugbot/automations.ts", [
    "adapters/interop/agent/automation-memory-mount-adapter.ts",
  ]],
  ["shared/node/mcp/mcp-image-assets.ts", [
    "shared/node/mcp/saved-image-notice.ts",
  ]],
  ["host/runner/slate-auto-review-tool-escalations.ts", [
    "host/runner/slate-auto-review-tool-escalations-contracts.ts",
    "host/runner/slate-auto-review-tool-escalation-projections.ts",
  ]],
  ["host/telemetry/webauthn-proxy-telemetry.ts", [
    "host/telemetry/webauthn-proxy-contracts.ts",
    "host/telemetry/webauthn-proxy-error-policy.ts",
    "host/telemetry/webauthn-proxy-projection.ts",
  ]],
  ["host/runner/large-output-spill.ts", [
    "host/runner/large-output-spill-policy.ts",
  ]],
  ["host/boxes/box-store-sync/slate-box-store-files.ts", [
    "adapters/interop/agent/box-store-service-adapter.ts",
  ]],
  ["host/mcp/mcp-service.ts", [
    "adapters/interop/cursor-backend/mcp-dashboard-client-adapter.ts",
    "adapters/interop/mcp/host-service-adapter.ts",
  ]],
  ["packages/agent/prompts/testing/parent.ts", [
    "adapters/interop/agent/testing-prompt-profile-adapter.ts",
  ]],
  ["packages/agent/actions/user-message-action/user-message-action-handler.ts", [
    "adapters/interop/agent/user-message-action-input-adapter.ts",
    "packages/agent/actions/user-message-action/user-info-refresh-plan.ts",
    "packages/agent/actions/user-message-action/user-info-refresh-evaluation.ts",
    "packages/agent/actions/user-message-action/prepended-user-turns.ts",
  ]],
  ["packages/agent/actions/execute-plan-action-handler.ts", [
    "packages/agent/actions/execute-plan-contracts.ts",
    "packages/agent/actions/execute-plan-frontmatter.ts",
    "packages/agent/actions/execute-plan-plan-file.ts",
    "adapters/interop/agent/execute-plan-action-adapter.ts",
    "adapters/interop/agent/plan-file-uri-adapter.ts",
  ]],
  ["packages/agent/prompts/user-info-component.ts", [
    "packages/agent/prompts/user-info-profile-contract.ts",
    "packages/agent/prompts/user-info-data-contracts.ts",
    "adapters/interop/agent/user-info-input-adapter.ts",
  ]],
  ["packages/agent/tools/core/shell/formatters.ts", [
    "adapters/interop/agent/shell-result-format-adapter.ts",
  ]],
  ["packages/agent-kv/agent-store.ts", [
    "packages/agent-kv/agent-conversation-store-contracts.ts",
    "adapters/interop/agent/agent-conversation-protobuf-adapter.ts",
  ]],
  ["packages/agent/diff-tab-git-action-prompt.ts", [
    "packages/agent/git-action-prompt-contracts.ts",
    "adapters/interop/agent/git-action-prompt-adapter.ts",
  ]],
  ["host/telemetry/host-telemetry-service.ts", [
    "host/telemetry/host-telemetry-contracts.ts",
    "host/telemetry/host-console-bridge.ts",
    "host/telemetry/host-telemetry-events.ts",
  ]],
  ["host/skills/skill-publish.ts", [
    "host/skills/skill-publish-contracts.ts",
    "adapters/interop/agent/skill-publish-dashboard-adapter.ts",
  ]],
  ["packages/agent/simulated-message-prompts.ts", [
    "adapters/interop/agent/git-action-prompt-adapter.ts",
  ]],
  ["packages/agent/context-processing-simulated-message.ts", [
    "adapters/interop/agent/git-action-prompt-adapter.ts",
  ]],
  ["coordinator/main.ts", [
    "coordinator/main-policies.ts",
    "coordinator/main-gateway-events.ts",
    "coordinator/main-lifecycle.ts",
  ]],
  ["packages/agent-summarization/durable-blocks.ts", [
    "adapters/interop/agent/plan-file-uri-adapter.ts",
  ]],
  ["host/extensions/inference/provider-session.ts", [
    "adapters/interop/inference/routed-provider-session-adapter.ts",
  ]],
  ["host/cloud-agents/cloud-agent-tool.ts", [
    "host/cloud-agents/cloud-agent-tool-contracts.ts",
    "host/cloud-agents/cloud-agent-model-catalog.ts",
  ]],
  ["packages/agent-store-sync/token-caching-client.ts", [
    "packages/agent-store-sync/agent-store-sync-contracts.ts",
    "packages/agent-store-sync/agent-store-target-resolution.ts",
    "packages/agent-store-sync/agent-store-token-cache.ts",
  ]],
  ["packages/agent/context-processing.ts", [
    "adapters/interop/agent/workspace-file-write-adapter.ts",
    "packages/agent/context/external-link-enrichment.ts",
  ]],
  ["packages/agent/context-processing-image-file.ts", [
    "adapters/interop/agent/workspace-file-write-adapter.ts",
  ]],
  ["packages/agent/context-processing-code-selection.ts", [
    "adapters/interop/agent/workspace-file-write-adapter.ts",
  ]],
  ["packages/agent/context-processing-video-data.ts", [
    "packages/agent/context/video-attachment-contracts.ts",
    "packages/agent/context/video-path-processing.ts",
    "packages/agent/context/watch-video-eligibility.ts",
    "adapters/interop/agent/video-attachment-adapter.ts",
    "adapters/interop/agent/selected-video-path-adapter.ts",
    "adapters/interop/agent/watch-video-eligibility-adapter.ts",
    "adapters/interop/agent/workspace-file-write-adapter.ts",
  ]],
  ["host/extensions/session/connector-secret-store.ts", [
    "host/extensions/session/connector-secret-store-contracts.ts",
    "host/extensions/session/connector-secret-store-policy.ts",
  ]],
  ["packages/cursor-plugins/skill-plugin-synthesizer.ts", [
    "packages/plugin-install/skill-package-contracts.ts",
    "packages/plugin-install/skill-package-layout.ts",
  ]],
  ["packages/agent/tools/tool-call-id-tagging.ts", [
    "packages/agent/tools/tool-result-reference-contracts.ts",
    "packages/agent/tools/tool-result-reference-projection.ts",
  ]],
  ["packages/agent-summarization/deterministic-summary-builder.ts", [
    "packages/agent-summarization/transcript-snapshot-contracts.ts",
    "packages/agent-summarization/transcript-snapshot-policy.ts",
    "packages/agent-summarization/transcript-context-guidance.ts",
  ]],
  ["packages/agent/actions/user-message-action/synthetic-user-message.ts", [
    "packages/agent/actions/user-message-action/notification-message-classifier.ts",
    "adapters/interop/cursor-backend/summary-origin-marker-adapter.ts",
  ]],
  ["host/memory/project-membership.ts", [
    "host/memory/project-membership-contracts.ts",
    "host/memory/project-membership-policy.ts",
  ]],
  ["host/runner/auto-review-gate.ts", [
    "host/runner/auto-review-gate-contracts.ts",
    "host/runner/auto-review-gate-policy.ts",
  ]],
  ["host/boxes/box-capabilities.ts", [
    "host/boxes/box-capability-contracts.ts",
    "host/boxes/box-capability-observation.ts",
    "host/boxes/box-capability-operations.ts",
  ]],
  ["host/extensions/session/session-paths.ts", [
    "host/extensions/session/session-path-contracts.ts",
    "host/extensions/session/session-path-resolver.ts",
    "host/extensions/session/session-root-gc-policy.ts",
    "host/extensions/session/session-filesystem-probe.ts",
  ]],
  ["host/extensions/session/pending-card-sweeps.ts", [
    "host/extensions/session/pending-card-sweep-contracts.ts",
    "host/extensions/session/pending-card-sweep-policy.ts",
  ]],
  ["coordinator/oauth/mcp-oauth-callback-listener.ts", [
    "coordinator/oauth/mcp-oauth-callback-contracts.ts",
    "coordinator/oauth/mcp-oauth-callback-response.ts",
  ]],
  ["host/attachments/generate-image-resource-accessor.ts", [
    "host/attachments/image-resource-contracts.ts",
    "host/attachments/image-resource-path-policy.ts",
  ]],
  ["shared/local-exec-process-identity.ts", [
    "shared/local-exec-process-contracts.ts",
    "shared/local-exec-process-policy.ts",
  ]],
  ["packages/shell-exec/ripgrep.ts", [
    "packages/shell-exec/ripgrep-environment-policy.ts",
  ]],
  ["packages/shell-exec/platform-shell.ts", [
    "packages/shell-exec/platform-shell-contracts.ts",
    "packages/shell-exec/platform-shell-policy.ts",
  ]],
  ["packages/agent/tools/subagent-forced-model-resolution.ts", [
    "packages/agent/tools/subagent-forced-model-contracts.ts",
    "packages/agent/tools/subagent-forced-model-policy.ts",
  ]],
  ["packages/agent/tools/core/read/read.ts", [
    "adapters/interop/agent/read-tool-prompt-adapter.ts",
    "packages/agent/tools/core/read/read-contract.ts",
    "packages/agent/tools/core/read/read-renderer.ts",
    "adapters/interop/agent/read-tool-protocol-adapter.ts",
  ]],
  ["packages/agent/prompts/user-info-composer2-rules.ts", [
    "adapters/interop/agent/user-rule-profile-adapter.ts",
  ]],
  ["packages/agent/tools/core/subagent/subagent-config.ts", [
    "adapters/interop/agent/subagent-type-adapter.ts",
  ]],
  ["host/extensions/registry.ts", [
    "host/extensions/extension-startup-order.ts",
    "host/extensions/extension-registry-assembly.ts",
    "host/extensions/extension-registry-startup.ts",
  ]],
  ["packages/agent/utils/overridable-config.ts", [
    "packages/agent/utils/config-override-reader.ts",
  ]],
  ["host/extensions/auto-review/slate-auto-review-awaiting.ts", [
    "host/extensions/auto-review/auto-review-awaiting-contracts.ts",
    "host/extensions/auto-review/auto-review-awaiting-policy.ts",
  ]],
  ["packages/agent/utils/overridable-config.ts", [
    "packages/agent/utils/config-override-reader.ts",
  ]],
  ["host/telemetry/host-lifecycle-progress.ts", [
    "host/telemetry/host-lifecycle-contracts.ts",
    "host/telemetry/host-lifecycle-report-policy.ts",
  ]],
  ["host/attachments/box-staging.ts", [
    "host/attachments/box-staging-contracts.ts",
    "host/attachments/box-staging-policy.ts",
  ]],
  ["packages/agent-kv/serde.ts", [
    "packages/agent-kv/serde-contracts.ts",
    "packages/agent-kv/byte-hex-codec.ts",
    "adapters/interop/agent/protobuf-blob-serde-adapter.ts",
  ]],
  ["packages/agent/serde.ts", [
    "adapters/interop/agent/agent-conversation-state-serdes-adapter.ts",
  ]],
  ["packages/agent/context-processing-selected-context.ts", [
    "packages/agent/skill-attachment-contracts.ts",
    "adapters/interop/agent/selected-context-skills-adapter.ts",
  ]],
  ["packages/utils/path-matchers.ts", [
    "packages/utils/managed-project-path-contracts.ts",
    "packages/utils/managed-project-path-policy.ts",
    "packages/utils/filename-safety.ts",
  ]],
  ["host/extensions/local-tool-permission/extension.ts", [
    "host/extensions/local-tool-permission/local-tool-permission-extension-contracts.ts",
    "host/extensions/local-tool-permission/local-tool-permission-extension-runtime.ts",
  ]],
  ["host/extensions/session/channel-store.ts", [
    "host/extensions/session/channel-store-labels.ts",
    "host/extensions/session/channel-store-config.ts",
  ]],
  ["packages/agent/tools/subagent-registry.ts", [
    "packages/agent/tools/subagent-registry-contracts.ts",
    "packages/agent/tools/subagent-registry-links.ts",
  ]],
  ["packages/agent-store-sync/object-probe.ts", [
    "packages/agent-store-sync/object-probe-contracts.ts",
    "packages/agent-store-sync/object-probe-fetch.ts",
    "packages/agent-store-sync/object-probe-presign.ts",
    "packages/agent-store-sync/object-probe-result.ts",
  ]],
  ["host/auth/user-full-name-service.ts", [
    "host/auth/user-full-name-policy.ts",
  ]],
  ["host/boxes/box-store-sync/chrome-session-watcher.ts", [
    "host/boxes/box-store-sync/chrome-session-watcher-contracts.ts",
    "host/boxes/box-store-sync/chrome-session-watcher-state.ts",
  ]],
  ["host/notifications/mobile-push-notifier.ts", [
    "host/notifications/mobile-push-policy.ts",
    "host/notifications/mobile-push-projection.ts",
    "shared/mobile-push-contracts.ts",
  ]],
  ["host/extensions/managed-setup/extension.ts", [
    "host/extensions/managed-setup/extension-contracts.ts",
    "host/extensions/managed-setup/auth-lifecycle.ts",
  ]],
  ["shared/observability/log-ship-cadence.ts", [
    "shared/observability/log-ship-contracts.ts",
    "shared/observability/log-ship-policy.ts",
    "shared/observability/log-ship-schedule.ts",
    "shared/observability/log-ship-batch.ts",
  ]],
  ["host/transcript/roster-search.ts", [
    "host/transcript/roster-search-contracts.ts",
    "host/transcript/roster-search-indexed.ts",
    "host/transcript/roster-search-linear.ts",
    "host/transcript/roster-search-media.ts",
  ]],
  ["host/extensions/source-map/source-map-service.ts", [
    "host/extensions/source-map/source-map-contracts.ts",
    "host/extensions/source-map/source-map-codec.ts",
    "host/extensions/source-map/source-map-storage.ts",
  ]],
  ["host/groups/xuser.ts", [
    "host/groups/shared-room-contracts.ts",
    "host/groups/shared-room-policy.ts",
    "host/groups/shared-room-guardrails.ts",
    "host/groups/shared-room-message-projection.ts",
    "host/groups/shared-room-turn-prompts.ts",
  ]],
  ["host/automations/listener-connect-watcher.ts", [
    "host/automations/listener-connect-watcher-contracts.ts",
    "host/automations/listener-connect-watcher-policy.ts",
  ]],
  ["host/transcript/group-chat-orchestrator.ts", [
    "host/transcript/group-chat-orchestrator-contracts.ts",
    "host/transcript/group-chat-member-turn.ts",
    "host/transcript/group-chat-rounds.ts",
  ]],
  ["host/boxes/box-store-sync/request-coalescer.ts", [
    "host/boxes/box-store-sync/request-coalescer-contracts.ts",
    "host/boxes/box-store-sync/request-coalescer-batch.ts",
    "host/boxes/box-store-sync/request-coalescer-execution.ts",
  ]],
  ["packages/agent/tools/tool-execution-timeout.ts", [
    "packages/agent/tools/tool-execution-timeout-errors.ts",
    "packages/agent/tools/tool-execution-timeout-messages.ts",
    "packages/agent/tools/tool-execution-timeout-policy.ts",
  ]],
  ["host/ports/telemetry.ts", [
    "host/ports/telemetry-catalog.ts",
    "host/ports/telemetry-error-detail.ts",
    "host/ports/telemetry-noop.ts",
  ]],
  ["host/telemetry/analytics-service.ts", [
    "host/telemetry/analytics-service-contracts.ts",
  ]],
  ["host/telemetry/event-loop-telemetry.ts", [
    "host/telemetry/event-loop-telemetry-contracts.ts",
    "host/telemetry/event-loop-telemetry-policy.ts",
    "host/telemetry/event-loop-window-metrics.ts",
  ]],
  ["packages/local-exec/tests/common.ts", [
    "packages/local-exec/runtime-ignore-policy.ts",
  ]],
  ["packages/local-exec/computer-use/display.ts", [
    "packages/local-exec/computer-use/display-contracts.ts",
    "packages/local-exec/computer-use/display-resolution-policy.ts",
  ]],
  ["packages/agent/git-diff-processing.ts", [
    "packages/agent/git-diff-attachment-contracts.ts",
    "packages/agent/git-diff-file-blocks.ts",
  ]],
  ["shared/node/cursor-token.ts", [
    "shared/node/slate-token-claims.ts",
    "shared/node/slate-token-identity.ts",
    "shared/node/slate-token-expiration.ts",
    "shared/node/slate-backend-configuration.ts",
    "shared/node/slate-token-refresh-policy.ts",
  ]],
  ["shared/node/mcp/builtin-mcp.ts", [
    "shared/node/mcp/box-computer-runtime-contracts.ts",
    "shared/node/mcp/box-computer-runtime-policy.ts",
    "shared/node/mcp/box-computer-environment.ts",
  ]],
  ["host/telemetry/local-exec-telemetry.ts", [
    "host/telemetry/local-exec-telemetry-contracts.ts",
    "host/telemetry/local-exec-refusal-policy.ts",
  ]],
  ["host/extensions/session/session-recovery.ts", [
    "host/extensions/session/session-recovery-contracts.ts",
    "host/extensions/session/session-recovery-error.ts",
    "host/extensions/session/session-recovery-entry-matching.ts",
    "host/extensions/session/session-recovery-blob-cache.ts",
    "host/extensions/session/session-recovery-agent-files.ts",
  ]],
  ["shared/node/mcp/mcp-display-runtime.ts", [
    "shared/node/mcp/mcp-display-contracts.ts",
    "shared/node/mcp/mcp-account-display-policy.ts",
    "shared/node/mcp/mcp-server-status-projection.ts",
  ]],
  ["packages/agent-store-sync/backoff-scheduler.ts", [
    "packages/agent-store-sync/retry-schedule-contracts.ts",
    "packages/agent-store-sync/retry-schedule-policy.ts",
  ]],
  ["host/runner/start-of-turn-ack-reminder-middleware.ts", [
    "host/runner/opening-message-reminder-policy.ts",
  ]],
  ["packages/cursor-plugins/git-remote-ref-resolve.ts", [
    "packages/plugin-install/git-ref-resolution-contracts.ts",
    "packages/plugin-install/git-ref-resolution-policy.ts",
  ]],
  ["packages/agent-kv/typed-blob-store.ts", [
    "packages/agent-kv/typed-blob-store-contracts.ts",
    "packages/agent-kv/observed-blob-store.ts",
    "packages/agent-kv/blob-store-observation.ts",
    "packages/agent-kv/cloud-mirror-blob-write.ts",
  ]],
  ["host/extensions/session/agent-db-transcript-pages.ts", [
    "host/extensions/session/agent-transcript-page-contracts.ts",
    "host/extensions/session/agent-transcript-page-projections.ts",
  ]],
  ["packages/agent/context-processing-hydration.ts", [
    "packages/agent/context/attachment-hydration-contracts.ts",
    "packages/agent/context/attachment-hydration-policy.ts",
  ]],
  ["packages/agent-summarization/token-estimate.ts", [
    "packages/agent-summarization/token-estimate-contracts.ts",
    "packages/agent-summarization/token-estimate-character-policy.ts",
  ]],
  ["gateway/gateway-command-error.ts", [
    "gateway/gateway-error-contracts.ts",
    "gateway/gateway-error-classification-policy.ts",
    "gateway/gateway-error-telemetry-projection.ts",
  ]],
  ["shared/node/experiments/slate-model-config.ts", [
    "shared/node/experiments/slate-model-config-contracts.ts",
    "shared/node/experiments/slate-model-config-constants.ts",
    "shared/node/experiments/slate-model-config-policy.ts",
  ]],
  ["host/extensions/wallpaper/wallpaper-service.ts", [
    "host/extensions/wallpaper/wallpaper-schedule-contracts.ts",
    "host/extensions/wallpaper/wallpaper-schedule-policy.ts",
  ]],
  ["host/boxes/box-store-sync/box-store-hydration.ts", [
    "host/boxes/box-store-sync/box-store-hydration-contracts.ts",
    "host/boxes/box-store-sync/box-store-hydration-policy.ts",
    "host/boxes/box-store-sync/box-store-hydration-marker.ts",
  ]],
  ["host/boxes/box-store-sync/box-copy-in.ts", [
    "host/boxes/box-store-sync/copy-in-contracts.ts",
    "host/boxes/box-store-sync/copy-in-source-policy.ts",
    "host/boxes/box-store-sync/copy-in-reporting.ts",
  ]],
  ["host/extensions/managed-setup/managed-skills-service.ts", [
    "host/extensions/managed-setup/managed-skills-service-contracts.ts",
    "host/extensions/managed-setup/managed-skills-service-projection.ts",
  ]],
  ["host/transcript/box-request-entries.ts", [
    "host/transcript/box-request-entries-contracts.ts",
    "host/transcript/box-request-entry-projection.ts",
  ]],
  ["host/telemetry/automation-fire-telemetry.ts", [
    "host/telemetry/automation-fire-contracts.ts",
    "host/telemetry/automation-fire-policy.ts",
    "host/telemetry/automation-fire-telemetry-projection.ts",
  ]],
  ["host/transcript/transcript-entry-ids.ts", [
    "host/transcript/transcript-entry-id-contracts.ts",
    "host/transcript/transcript-entry-id-counts.ts",
    "host/transcript/transcript-entry-id-policy.ts",
  ]],
  ["host/runner/slate-agent-profile-prompt.ts", [
    "host/runner/slate-agent-profile-prompt-contracts.ts",
    "host/runner/slate-agent-profile-update-codec.ts",
    "host/runner/slate-agent-profile-snapshot-policy.ts",
  ]],
  ["shared/node/paths.ts", [
    "shared/node/path-boundary-policy.ts",
    "shared/node/realpath-containment.ts",
  ]],
  ["packages/agent/tools/mcp/smart-mode-approval.ts", [
    "packages/agent/tools/mcp/smart-mode-approval-contracts.ts",
    "packages/agent/tools/mcp/smart-mode-approval-fingerprint.ts",
  ]],
  ["host/runner/turn-memory.ts", [
    "host/runner/turn-memory-contracts.ts",
    "host/runner/turn-memory-extraction.ts",
    "host/runner/turn-memory-settlement.ts",
  ]],
  ["host/transcript/slate-upgrade-resume-store.ts", [
    "host/transcript/upgrade-resume-store-contracts.ts",
    "host/transcript/upgrade-resume-store-codec.ts",
  ]],
  ["packages/agent/context-processing-terminal.ts", [
    "packages/agent/context/terminal-context-contracts.ts",
    "packages/agent/context/terminal-context-policy.ts",
    "packages/agent/context/terminal-context-rendering.ts",
  ]],
  ["packages/cursor-config/permissions-file-provider.ts", [
    "packages/config/permissions-file-contracts.ts",
    "packages/config/permissions-file-decoder.ts",
  ]],
  ["packages/agent-exec/agent-store-conflict-notice.ts", [
    "packages/agent-exec/agent-store-conflict-notice-contracts.ts",
    "packages/agent-exec/agent-store-conflict-notice-operations.ts",
    "packages/agent-exec/agent-store-conflict-notice-stub.ts",
  ]],
  ["host/extensions/session/session-mutations.ts", [
    "host/extensions/session/session-mutations-contracts.ts",
    "host/extensions/session/session-avatar-mutation.ts",
    "host/extensions/session/session-missing-db-recovery.ts",
  ]],
  ["host/runner/tools/box-help-tool.ts", [
    "host/runner/tools/box-help-tool-contracts.ts",
    "host/runner/tools/box-help-domain.ts",
    "host/runner/tools/box-help-message-projection.ts",
    "host/runner/tools/box-help-messages.ts",
  ]],
  ["host/extensions/local-tool-permission/local-tool-permission-controller.ts", [
    "host/extensions/local-tool-permission/local-tool-permission-controller-contracts.ts",
    "host/extensions/local-tool-permission/local-tool-permission-refusal-memory.ts",
    "host/extensions/local-tool-permission/local-tool-pending-ask-queue.ts",
  ]],
  ["host/automations/automation-store.ts", [
    "host/automations/automation-store-contracts.ts",
    "host/automations/automation-store-codecs.ts",
    "host/automations/automation-store-files.ts",
    "host/automations/automation-store-service.ts",
  ]],
  ["host/cloud-agents/cloud-agents-service.ts", [
    "host/cloud-agents/cloud-agent-manager-contracts.ts",
    "host/cloud-agents/cloud-agent-view-mappers.ts",
    "host/cloud-agents/cloud-agent-manager-queries.ts",
    "host/cloud-agents/cloud-agent-manager-launch.ts",
    "adapters/interop/cursor-backend/slate-cloud-agent-client-adapter.ts",
  ]],
  ["host/workflows/workflow-store.ts", [
    "host/workflows/workflow-store-contracts.ts",
    "host/workflows/workflow-store-sources.ts",
    "host/workflows/workflow-store-migration.ts",
    "host/workflows/workflow-store-imports.ts",
  ]],
  ["host/automations/automation-trigger.ts", [
    "host/automations/automation-trigger-contracts.ts",
    "host/automations/automation-trigger-parse.ts",
    "host/automations/automation-trigger-matching.ts",
    "host/automations/automation-trigger-context.ts",
  ]],
  ["host/automations/backend-relay-source.ts", [
    "host/automations/backend-relay-contracts.ts",
    "host/automations/backend-relay-events.ts",
    "host/automations/backend-relay-status.ts",
  ]],
  ["host/attachments/safe-link-preview-fetch.ts", [
    "host/attachments/safe-link-preview-contracts.ts",
    "host/attachments/safe-link-preview-target.ts",
    "host/attachments/safe-link-preview-transport.ts",
  ]],
  ["host/runner/conversation-state.ts", [
    "host/runner/conversation-state-contracts.ts",
    "host/runner/conversation-user-state.ts",
    "host/runner/conversation-usage.ts",
    "host/runner/conversation-prompt-usage.ts",
    "host/runner/conversation-summary-policy.ts",
  ]],
  ["host/runner/agent-adapters.ts", [
    "adapters/interop/agent/runner-agent-adapters.ts",
    "host/runner/request-context-result.ts",
    "host/runner/subagent-session-coordinator.ts",
    "host/runner/forwarding-interaction-updates.ts",
  ]],
  ["host/telemetry/structured-log-telemetry.ts", [
    "adapters/interop/telemetry/analytics-client-adapter.ts",
    "host/telemetry/turn-telemetry-session.ts",
  ]],
  ["host/runner/slate-agent-runner.ts", [
    "adapters/interop/agent/runner-conversation-state-adapter.ts",
    "host/runner/runner-turn-attempt.ts",
    "host/runner/runner-service-bindings.ts",
    "host/runner/runner-fallback-step-loop.ts",
    "host/runner/runner-identity.ts",
  ]],
  ["host/runner/turn-agent-composition.ts", [
    "host/runner/turn-subagent-configs.ts",
    "adapters/interop/agent/turn-agent-run-projection-adapter.ts",
  ]],
  ["host/slate-activity.ts", [
    "host/slate-activity-contracts.ts",
    "host/slate-activity-transitions.ts",
    "host/slate-activity-shell-paths.ts",
    "host/slate-activity-tool-projection.ts",
  ]],
  ["host/rooms/xuser-remote-turns.ts", [
    "host/rooms/xuser-remote-turn-contracts.ts",
    "host/rooms/xuser-remote-turn-inbound.ts",
    "host/rooms/xuser-remote-turn-outbound.ts",
  ]],
  ["host/local-exec/local-exec-daemon-protocol.ts", [
    "host/local-exec/local-exec-daemon-contracts.ts",
    "host/local-exec/local-exec-daemon-files.ts",
    "host/local-exec/local-exec-daemon-discovery.ts",
  ]],
  ["host/local-exec/local-tool-approvals.ts", [
    "host/local-exec/local-tool-approval-contracts.ts",
    "host/local-exec/local-tool-approval-write-lane.ts",
    "host/local-exec/local-tool-approval-files.ts",
    "host/local-exec/local-tool-approval-ledger.ts",
  ]],
  ["host/rooms/xuser-relay.ts", [
    "host/rooms/xuser-relay-contracts.ts",
    "host/rooms/xuser-relay-http-api.ts",
    "host/rooms/xuser-relay-polling.ts",
    "host/rooms/xuser-relay-room-routes.ts",
  ]],
  ["host/rooms/xuser-entry-publisher.ts", [
    "host/rooms/xuser-entry-publisher-contracts.ts",
    "host/rooms/xuser-remote-agent-id.ts",
    "host/rooms/xuser-entry-images.ts",
    "host/rooms/xuser-entry-serializer.ts",
    "host/rooms/xuser-entry-projection.ts",
    "host/rooms/xuser-entry-delivery.ts",
    "host/rooms/xuser-entry-queue.ts",
  ]],
  ["host/extensions/session/conversation-size-limits.ts", [
    "host/extensions/session/conversation-size-limits-contracts.ts",
    "host/extensions/session/conversation-size-limits-config.ts",
    "host/extensions/session/conversation-size-garbage-collection.ts",
    "host/extensions/session/conversation-size-maintenance.ts",
  ]],
  ["host/agents/agent-avatar.ts", [
    "host/agents/agent-avatar-contracts.ts",
    "host/agents/agent-avatar-format.ts",
    "host/agents/agent-avatar-paths.ts",
    "host/agents/agent-avatar-reading.ts",
  ]],
  ["shared/os-notification.ts", [
    "shared/os-notification-contracts.ts",
    "shared/os-notification-snapshot.ts",
    "shared/os-notification-content.ts",
    "shared/os-notification-policy.ts",
    "shared/os-notification-decider.ts",
  ]],
  ["shared/deep-link.ts", [
    "shared/deep-link-contracts.ts",
    "shared/deep-link-input-policy.ts",
    "shared/deep-link-query-policy.ts",
    "shared/deep-link-canonical.ts",
    "shared/deep-link-route-parser.ts",
    "shared/deep-link-url-parser.ts",
  ]],
  ["host/send-trace-host.ts", [
    "host/send-trace-contracts.ts",
    "host/send-trace-registry.ts",
    "host/send-trace-remote-parent.ts",
    "host/send-trace-turn-policy.ts",
    "host/send-trace-turn-context.ts",
    "host/send-trace-turn.ts",
    "host/send-trace-phase.ts",
  ]],
  ["coordinator/gateway/gateway-reachability.ts", [
    "coordinator/gateway/gateway-reachability-contracts.ts",
    "coordinator/gateway/gateway-http-outcome.ts",
    "coordinator/gateway/gateway-fetch-classifier.ts",
    "coordinator/gateway/gateway-stream-classifier.ts",
    "coordinator/gateway/gateway-base-url-kind.ts",
  ]],
  ["host/extensions/content-search/search-index-db.ts", [
    "host/extensions/content-search/search-index-db-contracts.ts",
    "host/extensions/content-search/search-index-db-schema.ts",
    "host/extensions/content-search/search-index-db-query.ts",
    "host/extensions/content-search/search-index-db-projection.ts",
    "host/extensions/content-search/search-index-db-search.ts",
  ]],
  ["host/automations/slate-trigger-hub.ts", [
    "host/automations/slate-trigger-hub-contracts.ts",
    "host/automations/slate-trigger-hub-listeners.ts",
    "host/automations/slate-trigger-hub-source-sync.ts",
    "host/automations/slate-trigger-hub-event-dispatch.ts",
    "host/automations/slate-trigger-hub-engine.ts",
  ]],
  ["coordinator/oauth/mcp-oauth-loopback-registry.ts", [
    "coordinator/oauth/mcp-oauth-loopback-contracts.ts",
    "coordinator/oauth/mcp-oauth-loopback-address.ts",
    "coordinator/oauth/mcp-oauth-loopback-server.ts",
    "coordinator/oauth/mcp-oauth-loopback-dispatch.ts",
  ]],
  ["host/runner/bot-block-detection.ts", [
    "host/runner/bot-block-contracts.ts",
    "host/runner/bot-block-signatures.ts",
    "host/runner/bot-block-matchers.ts",
    "host/runner/bot-block-url.ts",
    "host/runner/bot-block-classifier.ts",
    "host/runner/bot-block-auditor.ts",
  ]],
  ["host/boxes/box-store-sync/chrome-session-stage.ts", [
    "host/boxes/box-store-sync/chrome-session-stage-contracts.ts",
    "host/boxes/box-store-sync/chrome-session-stage-retry.ts",
    "host/boxes/box-store-sync/chrome-session-stage-file.ts",
    "host/boxes/box-store-sync/chrome-session-stage-run.ts",
  ]],
  ["host/runner/tools/send-message-schema.ts", [
    "host/runner/tools/send-message-schema-contracts.ts",
    "host/runner/tools/send-message-field-policy.ts",
    "host/runner/tools/send-message-refinement.ts",
    "host/runner/tools/send-message-zod-fields.ts",
    "host/runner/tools/send-message-zod-schema.ts",
  ]],
  ["host/runner/tools/send-message-encoding.ts", [
    "host/runner/tools/send-message-encoding-contracts.ts",
    "host/runner/tools/send-message-markdown.ts",
    "host/runner/tools/send-message-protobuf.ts",
    "adapters/interop/agent/send-message-tool-protocol-adapter.ts",
    "host/runner/tools/send-message-product-summaries.ts",
    "host/runner/tools/send-message-box-media.ts",
  ]],
  ["host/runner/tools/send-message-tool.ts", [
    "adapters/interop/agent/send-message-tool-protocol-adapter.ts",
  ]],
  ["host/skills/plugin-skills-cache.ts", [
    "host/skills/plugin-skills-cache-contracts.ts",
    "host/skills/plugin-skills-cache-paths.ts",
    "host/skills/plugin-skills-cache-records.ts",
    "host/skills/plugin-skills-cache-read.ts",
    "host/skills/plugin-skills-cache-write.ts",
  ]],
  ["shared/node/mcp/mcp-instructions-and-toggles.ts", [
    "shared/node/mcp/mcp-instructions-contracts.ts",
    "shared/node/mcp/mcp-instructions-state.ts",
    "shared/node/mcp/mcp-tool-management.ts",
  ]],
  ["coordinator/local-exec/daemon-files.ts", [
    "coordinator/local-exec/daemon-files-contracts.ts",
    "coordinator/local-exec/daemon-files-paths.ts",
    "coordinator/local-exec/daemon-discovery-read.ts",
    "coordinator/local-exec/daemon-files-write.ts",
    "coordinator/local-exec/daemon-discovery-retirement.ts",
  ]],
  ["packages/local-exec/ls.ts", [
    "packages/local-exec/ls-contracts.ts",
    "packages/local-exec/ls-tree-builder.ts",
    "adapters/interop/agent/local-ls-exec-adapter.ts",
  ]],
  ["packages/agent/utils/mcp-meta-tool-options.ts", [
    "adapters/interop/agent/mcp-meta-tool-options-adapter.ts",
  ]],
  ["host/extensions/action-audit/action-audit-backend.ts", [
    "adapters/interop/analytics/action-audit-backend-adapter.ts",
  ]],
  ["packages/cursor-config/auth/login.ts", [
    "packages/config/auth/login-contracts.ts",
    "packages/config/auth/login-link.ts",
    "packages/config/auth/login-polling.ts",
    "packages/config/auth/login-api-key.ts",
    "packages/config/auth/login-manager.ts",
  ]],
  ["host/extensions/session/session-materialization.ts", [
    "host/extensions/session/session-materialization-contracts.ts",
    "host/extensions/session/session-mint-queue.ts",
    "host/extensions/session/session-store-materializer.ts",
    "host/extensions/session/session-directory-index.ts",
  ]],
  ["host/extensions/session/session-summaries.ts", [
    "host/extensions/session/session-summary-contracts.ts",
    "host/extensions/session/session-summary-db-extras.ts",
    "host/extensions/session/session-summary-minimal.ts",
    "host/extensions/session/session-summary-footprint.ts",
    "host/extensions/session/session-summary-builder.ts",
  ]],
  ["host/extensions/action-audit/action-audit-service.ts", [
    "host/extensions/action-audit/action-audit-contracts.ts",
    "host/extensions/action-audit/action-audit-policy.ts",
    "host/extensions/action-audit/action-audit-local-jsonl.ts",
    "host/extensions/action-audit/action-audit-outbox.ts",
    "host/extensions/action-audit/action-audit-local-write-lane.ts",
    "host/extensions/action-audit/action-audit-flush-controller.ts",
  ]],
  ["host/extensions/secrets/secrets-service.ts", [
    "host/extensions/secrets/secrets-service-contracts.ts",
    "host/extensions/secrets/secrets-store.ts",
    "host/extensions/secrets/secrets-generation-waiters.ts",
    "host/extensions/secrets/secrets-apply-loop.ts",
    "host/extensions/secrets/secrets-applier.ts",
  ]],
  ["host/extensions/auto-review/auto-review-service.ts", [
    "host/extensions/auto-review/auto-review-service-contracts.ts",
    "host/extensions/auto-review/auto-review-approval-registry.ts",
    "host/extensions/auto-review/auto-review-approval-updates.ts",
  ]],
  ["host/automations/automation.ts", [
    "host/automations/automation-contracts.ts",
    "host/automations/automation-text.ts",
    "host/automations/automation-system-prompt.ts",
    "host/automations/automation-wake-prompt.ts",
    "host/automations/automation-status-prompt.ts",
  ]],
  ["shared/observability/sentry.ts", [
    "shared/observability/sentry-contracts.ts",
    "shared/observability/sentry-envelope-values.ts",
    "shared/observability/sentry-envelope-policy.ts",
    "shared/observability/sentry-send-gate.ts",
    "shared/observability/sentry-spool-store.ts",
    "shared/observability/sentry-account-sync.ts",
    "shared/observability/sentry-event-id-ring.ts",
  ]],
  ["host/workflows/workflow-library.ts", [
    "host/workflows/workflow-library-contracts.ts",
    "host/workflows/workflow-library-paths.ts",
    "host/workflows/workflow-library-read.ts",
    "host/workflows/workflow-library-write.ts",
    "host/workflows/workflow-library-migration.ts",
    "host/workflows/workflow-library-identifiers.ts",
  ]],
  ["coordinator/routed-mcp-bridge.ts", [
    "coordinator/routed-mcp-bridge-contracts.ts",
    "coordinator/routed-mcp-shapes.ts",
    "coordinator/routed-mcp-tool-policy.ts",
    "coordinator/routed-mcp-result-projection.ts",
    "coordinator/routed-mcp-http.ts",
  ]],
  ["host/rooms/xuser-departure-obligations.ts", [
    "host/rooms/xuser-departure-contracts.ts",
    "host/rooms/xuser-departure-resolution.ts",
    "host/rooms/xuser-departure-room-state.ts",
    "host/rooms/xuser-departure-flush.ts",
  ]],
  ["host/boxes/box-store-sync/workspace-ignore.ts", [
    "host/boxes/box-store-sync/workspace-ignore-contracts.ts",
    "host/boxes/box-store-sync/workspace-ignore-patterns.ts",
    "host/boxes/box-store-sync/workspace-ignore-policy.ts",
    "host/boxes/box-store-sync/workspace-ignore-loader.ts",
  ]],
  ["host/extensions/notify-bus/notify-bus-client.ts", [
    "host/extensions/notify-bus/notify-bus-contracts.ts",
    "host/extensions/notify-bus/notify-bus-frame.ts",
    "host/extensions/notify-bus/notify-bus-sse.ts",
  ]],
  ["host/extensions/session/conversation-recovery.ts", [
    "host/extensions/session/conversation-recovery-contracts.ts",
    "host/extensions/session/conversation-recovery-transcript.ts",
    "host/extensions/session/conversation-recovery-roots.ts",
  ]],
  ["host/extensions/session/box-handoff-service.ts", [
    "host/extensions/session/box-handoff-contracts.ts",
    "host/extensions/session/box-handoff-decision.ts",
    "host/extensions/session/box-handoff-snapshot.ts",
    "host/extensions/session/box-handoff-telemetry.ts",
  ]],
  ["shared/media/video-dimensions.ts", [
    "shared/media/video-dimensions-boxes.ts",
    "shared/media/video-dimensions-track.ts",
  ]],
  ["host/attachments/video-playback-rendition.ts", [
    "host/attachments/video-playback-contracts.ts",
    "host/attachments/video-playback-cache-path.ts",
    "host/attachments/video-playback-transcode.ts",
    "host/attachments/video-playback-cache.ts",
  ]],
  ["host/agents/isolation/conversation-blob-store.ts", [
    "host/agents/isolation/conversation-blob-store-contracts.ts",
    "host/agents/isolation/conversation-blob-identifiers.ts",
    "host/agents/isolation/conversation-blob-write-history.ts",
    "host/agents/isolation/conversation-blob-legacy-adoption.ts",
    "host/agents/isolation/conversation-blob-stale-roots.ts",
    "host/agents/isolation/conversation-blob-collector.ts",
  ]],
  ["host/agents/isolation/agent-worker-pool.ts", [
    "host/agents/isolation/agent-worker-protocol.ts",
  ]],
  ["host/boxes/forever-box/disk-pressure.ts", [
    "host/boxes/forever-box/disk-pressure-reminder-ledger.ts",
    "host/boxes/forever-box/disk-pressure-reminder-persistence.ts",
    "host/boxes/forever-box/disk-pressure-watch.ts",
  ]],
  ["host/local-exec/gateway-local-exec-slate-box.ts", [
    "host/local-exec/gateway-local-exec-contracts.ts",
    "host/local-exec/gateway-local-exec-manager.ts",
    "host/local-exec/gateway-local-exec-box.ts",
    "host/local-exec/gateway-local-exec-computers.ts",
  ]],
  ["host/local-exec/production.ts", [
    "adapters/interop/agent/local-exec-codec-adapter.ts",
  ]],
  ["host/extensions/host-upgrade/host-upgrade-service.ts", [
    "host/extensions/host-upgrade/host-upgrade-service-contracts.ts",
    "host/extensions/host-upgrade/host-upgrade-marker-forwarder.ts",
    "host/extensions/host-upgrade/host-upgrade-update-coordinator.ts",
    "host/extensions/host-upgrade/host-upgrade-update-watch.ts",
  ]],
  ["host/extensions/host-upgrade/host-bundle-upgrade.ts", [
    "host/extensions/host-upgrade/host-bundle-upgrade-contracts.ts",
    "host/extensions/host-upgrade/host-bundle-command.ts",
    "host/extensions/host-upgrade/host-bundle-upgrade-command-values.ts",
    "host/extensions/host-upgrade/host-bundle-upgrade-state.ts",
    "host/extensions/host-upgrade/host-bundle-fetch-stage.ts",
    "host/extensions/host-upgrade/host-bundle-error-detail.ts",
    "host/extensions/host-upgrade/host-bundle-watch-policy.ts",
  ]],
  ["host/transcript/mirror/transcript-mirror.ts", [
    "host/transcript/mirror/transcript-mirror-contracts.ts",
    "host/transcript/mirror/transcript-mirror-files.ts",
    "host/transcript/mirror/transcript-mirror-write-lanes.ts",
    "host/transcript/mirror/transcript-mirror-outcomes.ts",
  ]],
  ["gateway/gateway-server.ts", [
    "gateway/gateway-server-contracts.ts",
    "gateway/gateway-server-http.ts",
    "gateway/gateway-server-routes.ts",
  ]],
  ["shared/observability/structured-log-transport.ts", [
    "shared/observability/structured-log-transport-contracts.ts",
    "shared/observability/structured-log-transport-values.ts",
    "shared/observability/structured-log-buffer.ts",
    "shared/observability/structured-log-drop-ledger.ts",
  ]],
  ["shared/node/egress-tunnel/exit-client.ts", [
    "shared/node/egress-tunnel/exit-client-contracts.ts",
    "shared/node/egress-tunnel/egress-frame-codec.ts",
    "shared/node/egress-tunnel/egress-target-policy.ts",
    "shared/node/egress-tunnel/egress-tunnel-exit-client.ts",
  ]],
  ["host/boxes/shared-desktop-slate-box.ts", [
    "host/boxes/shared-desktop-contracts.ts",
    "host/boxes/shared-desktop-assignments.ts",
    "host/boxes/shared-desktop-capabilities.ts",
    "host/boxes/shared-desktop-window-manager.ts",
  ]],
  ["host/boxes/loopback-slate-box.ts", [
    "host/boxes/loopback-box-contracts.ts",
    "host/boxes/loopback-daemon-readiness.ts",
    "host/boxes/loopback-box-windows.ts",
    "host/boxes/loopback-box-file-access.ts",
    "box-exec/terminal-paths.ts",
  ]],
  ["host/skills/plugin-skills.ts", [
    "host/skills/plugin-skills-contracts.ts",
    "host/skills/plugin-skill-records.ts",
    "host/skills/plugin-skills-loader.ts",
    "adapters/interop/plugin-marketplace/installed-plugin-dashboard-adapter.ts",
    "host/skills/plugin-skills-service.ts",
  ]],
  ["host/extensions/codebase-telemetry/privacy-mode.ts", [
    "adapters/interop/telemetry/privacy-mode-dashboard-adapter.ts",
  ]],
  ["packages/agent-core/interaction-updates.ts", [
    "packages/agent-core/interaction-update-contracts.ts",
    "adapters/interop/agent/interaction-update-adapter.ts",
  ]],
  ["shared/automation-schedule.ts", [
    "shared/automation-schedule-contracts.ts",
    "shared/automation-schedule-core.ts",
    "shared/automation-schedule-description.ts",
  ]],
  ["shared/node/experiments/cursor-experiments.ts", [
    "shared/node/experiments/slate-experiment-service-engine.ts",
    "shared/node/experiments/slate-experiment-contracts.ts",
    "shared/node/experiments/slate-experiment-policies.ts",
    "shared/node/experiments/slate-experiment-snapshot.ts",
    "shared/node/experiments/slate-experiment-client.ts",
  ]],
  ["host/rooms/xuser-sharing-service.ts", ["host/rooms/xuser-sharing-contracts.ts"]],
  ["host/rooms/extension.ts", [
    "host/rooms/xuser-sharing-extension-contracts.ts",
    "host/rooms/xuser-sharing-extension-lifecycle.ts",
    "host/rooms/xuser-sharing-extension-api.ts",
    "host/rooms/xuser-sharing-extension-service.ts",
  ]],
  ["host/boxes/box-store-sync/box-store-sync.ts", [
    "host/boxes/box-store-sync/box-store-sync-contracts.ts",
    "host/boxes/box-store-sync/box-store-sync-observability.ts",
    "host/boxes/box-store-sync/box-store-sync-engine.ts",
  ]],
  ["host/boxes/box-store-sync/box-store-transfer.ts", [
    "host/boxes/box-store-sync/box-store-transfer-contracts.ts",
    "host/boxes/box-store-sync/box-store-transfer-primitives.ts",
    "host/boxes/box-store-sync/box-store-transfer-service.ts",
  ]],
  ["packages/cursor-plugins/loader.ts", [
    "packages/plugin-install/plugin-loader-contracts.ts",
    "packages/plugin-install/plugin-file-fetcher.ts",
    "packages/plugin-install/plugin-document-loader.ts",
    "packages/plugin-install/marketplace-plugin-loader.ts",
    "adapters/interop/plugin-marketplace/plugin-origin.ts",
  ]],
  ["packages/local-exec/shell-stream.ts", [
    "packages/local-exec/shell-stream-contracts.ts",
    "packages/local-exec/shell-stream-analysis.ts",
    "packages/local-exec/shell-stream-policy.ts",
    "packages/local-exec/shell-stream-events.ts",
    "packages/local-exec/shell-stream-handoff.ts",
    "packages/local-exec/shell-stream-foreground-runs.ts",
    "adapters/interop/agent/local-shell-stream-executor-adapter.ts",
  ]],
  ["host/runner/shell-terminal-watch.ts", [
    "adapters/interop/agent/shell-terminal-watch-adapter.ts",
  ]],
  ["shared/workflow-model.ts", [
    "shared/workflow-model-contracts.ts",
    "shared/workflow-model-values.ts",
    "shared/workflow-frontmatter.ts",
    "shared/workflow-model-projections.ts",
    "shared/workflow-model-references.ts",
  ]],
  ["host/local-exec/local-exec-bridge.ts", [
    "host/local-exec/local-exec-bridge-contracts.ts",
    "host/local-exec/local-exec-provider-directory.ts",
    "host/local-exec/local-exec-response-channels.ts",
  ]],
  ["host/local-exec/local-exec-daemon.ts", [
    "host/local-exec/local-exec-daemon-run-contracts.ts",
    "host/local-exec/local-exec-daemon-connection.ts",
    "host/local-exec/local-exec-daemon-discovery-publisher.ts",
    "host/local-exec/local-exec-daemon-policy.ts",
  ]],
  ["host/boxes/box-store-sync/box-store-sync-service.ts", [
    "host/boxes/box-store-sync/box-store-sync-service-api.ts",
    "host/boxes/box-store-sync/box-store-sync-service-contracts.ts",
    "host/boxes/box-store-sync/box-store-sync-service-categories.ts",
    "host/boxes/box-store-sync/box-store-sync-service-reporter.ts",
    "host/boxes/box-store-sync/box-store-sync-service-runtime.ts",
    "host/boxes/box-store-sync/box-store-sync-service-store.ts",
  ]],
  ["host/boxes/box-store-sync/box-store-pack.ts", [
    "host/boxes/box-store-sync/box-store-pack-index.ts",
    "host/boxes/box-store-sync/box-store-pack-files.ts",
    "host/boxes/box-store-sync/box-store-pack-planner.ts",
  ]],
  ["host/boxes/box-transfer.ts", [
    "host/boxes/box-transfer-contracts.ts",
    "host/boxes/box-transfer-paths.ts",
    "host/boxes/box-transfer-failures.ts",
    "host/boxes/box-transfer-copy.ts",
    "host/boxes/box-transfer-concurrency.ts",
    "host/boxes/box-transfer-batches.ts",
  ]],
  ["host/boxes/forever-box/forever-box-service.ts", [
    "host/boxes/forever-box/forever-box-service-contracts.ts",
    "host/boxes/forever-box/forever-box-image-updates.ts",
    "host/boxes/forever-box/forever-box-status-overlay.ts",
  ]],
  ["host/boxes/forever-box/host-box.ts", [
    "host/boxes/forever-box/host-box-contracts.ts",
    "host/boxes/forever-box/host-box-status-state.ts",
  ]],
  ["host/memory/agent-state.ts", [
    "host/memory/agent-state-contracts.ts",
    "host/memory/agent-state-memory.ts",
    "host/memory/agent-state-workflows.ts",
    "host/memory/agent-state-profile.ts",
    "host/memory/agent-state-projects.ts",
    "host/memory/agent-state-avatar.ts",
  ]],
  ["host/runner/background-work.ts", [
    "host/runner/background-work-contracts.ts",
    "host/runner/background-work-registry.ts",
    "host/runner/background-work-terminal.ts",
    "host/runner/background-work-watchers.ts",
  ]],
  ["host/extensions/content-search/search-index-writer.ts", [
    "host/extensions/content-search/search-index-writer-contracts.ts",
    "host/extensions/content-search/search-index-row-projector.ts",
    "host/extensions/content-search/search-index-write-statements.ts",
    "host/extensions/content-search/search-index-transcript-reader.ts",
  ]],
  ["host/extensions/session/session-maintenance.ts", [
    "host/extensions/session/session-maintenance-contracts.ts",
    "host/extensions/session/session-maintenance-common.ts",
    "host/extensions/session/session-maintenance-checkpoint.ts",
    "host/extensions/session/session-maintenance-transcript.ts",
    "host/extensions/session/session-maintenance-repair.ts",
  ]],
  ["packages/cursor-plugins/mcp-parser.ts", [
    "packages/plugin-install/mcp-parser-contracts.ts",
    "packages/plugin-install/mcp-parser-expansion.ts",
    "packages/plugin-install/mcp-parser-document.ts",
    "packages/plugin-install/mcp-parser-resolution.ts",
  ]],
  ["packages/cursor-plugins/manifest-parser.ts", [
    "packages/plugin-install/plugin-path-policy.ts",
  ]],
  ["packages/local-exec/shell-core.ts", [
    "packages/local-exec/shell-core-contracts.ts",
    "packages/local-exec/shell-core-environment.ts",
    "packages/local-exec/shell-core-sandbox-policy.ts",
    "packages/local-exec/shell-core-output-capture.ts",
  ]],
  ["packages/cursor-plugins/git-url-parsing.ts", [
    "packages/plugin-install/git-url-parsing-contracts.ts",
    "packages/plugin-install/git-url-normalize.ts",
    "packages/plugin-install/git-url-provider.ts",
    "packages/plugin-install/git-url-scm.ts",
  ]],
  ["packages/cursor-config/auth/mdm-sign-in-policy.ts", [
    "packages/config/auth/mdm-sign-in-policy-contracts.ts",
    "packages/config/auth/mdm-sign-in-policy-values.ts",
    "packages/config/auth/mdm-sign-in-policy-sources.ts",
    "packages/config/auth/mdm-sign-in-policy-cache.ts",
  ]],
  ["host/slate-host.ts", [
    "host/slate-host-production.ts",
    "host/box-ready-reporter.ts",
    "host/host-health.ts",
    "host/host-event-feeds.ts",
  ]],
  ["host/host-runner-composition.ts", [
    "host/runner/host-runner-permission-surfaces.ts",
    "host/runner/production-turn-settle-host.ts",
    "host/runner/host-runner-turn-scope.ts",
    "host/runner/host-runner-capabilities.ts",
  ]],
  ["host/host-lock.ts", ["host/host-lock-files.ts", "host/host-lock-processes.ts"]],
  ["shared/local-tool-permission-machinery.ts", [
    "shared/local-tool-permission-contracts.ts",
    "shared/local-tool-permission-coverage.ts",
    "shared/local-tool-permission-gate.ts",
    "shared/local-tool-permission-messages.ts",
    "shared/local-tool-permission-requests.ts",
  ]],
  ["packages/cursor-plugins/inline-plugin-synthesizer.ts", [
    "packages/plugin-install/inline-plugin-contracts.ts",
    "packages/plugin-install/inline-plugin-platform.ts",
    "packages/plugin-install/inline-plugin-yaml.ts",
    "packages/plugin-install/inline-plugin-writer.ts",
  ]],
  ["packages/agent/actions/user-message-action/conversation-history.ts", [
    "packages/agent/actions/user-message-action/conversation-history-content.ts",
  ]],
  ["packages/local-exec/grep-output.ts", [
    "packages/local-exec/grep-output-contracts.ts",
    "packages/local-exec/grep-output-records.ts",
    "packages/local-exec/grep-output-content.ts",
  ]],
  ["host/storage/sqlite-recovery.ts", [
    "host/storage/sqlite-recovery-files.ts",
    "host/storage/sqlite-recovery-quarantine.ts",
    "host/storage/sqlite-recovery-salvage.ts",
  ]],
  ["host/cloud-agents/cloud-agent-request-composition.ts", [
    "host/cloud-agents/cloud-agent-request-contracts.ts",
    "host/cloud-agents/cloud-agent-request-model.ts",
    "host/cloud-agents/cloud-agent-repository.ts",
    "host/cloud-agents/cloud-agent-repo-selection.ts",
    "host/cloud-agents/cloud-agent-environment-routing.ts",
  ]],
  ["shared/node/experiments/feature-flag-overrides.ts", [
    "shared/node/experiments/feature-flag-override-state.ts",
    "shared/node/experiments/feature-flag-override-storage.ts",
  ]],
  ["packages/agent/tools/lenient-array.ts", [
    "packages/agent/tools/lenient-array-json.ts",
    "packages/agent/tools/lenient-array-repair.ts",
  ]],
  ["host/rooms/xuser-wire-normalization.ts", [
    "host/rooms/xuser-wire-contracts.ts",
    "host/rooms/xuser-wire-images.ts",
    "host/rooms/xuser-wire-mirror-entry.ts",
    "host/rooms/xuser-wire-records.ts",
    "host/rooms/xuser-wire-turn-messages.ts",
  ]],
  ["shared/node/mcp/mcp-account-slot-lifecycle.ts", [
    "shared/node/mcp/mcp-account-slot-contracts.ts",
    "shared/node/mcp/mcp-account-slot-resolution.ts",
    "shared/node/mcp/mcp-account-slot-commit.ts",
  ]],
  ["host/extensions/session/session-roster.ts", [
    "host/extensions/session/session-roster-contracts.ts",
    "host/extensions/session/session-roster-list.ts",
    "host/extensions/session/session-roster-item.ts",
  ]],
  ["shared/node/mcp/mcp-listing-summaries.ts", [
    "shared/node/mcp/mcp-listing-summary-contracts.ts",
    "shared/node/mcp/mcp-listing-summary-projectors.ts",
  ]],
  ["shared/node/mcp/mcp-definition-source.ts", [
    "shared/node/mcp/mcp-definition-source-cache.ts",
    "shared/node/mcp/mcp-definition-source-contracts.ts",
    "shared/node/mcp/mcp-definition-source-identity.ts",
    "shared/node/mcp/mcp-definition-source-projections.ts",
  ]],
  ["host/extensions/inference/slate-labeling.ts", [
    "host/extensions/inference/slate-labeling-contracts.ts",
    "host/extensions/inference/slate-labeling-client.ts",
    "host/extensions/inference/slate-labeling-diagnostics.ts",
    "host/extensions/inference/slate-followup-labeling.ts",
    "host/extensions/inference/slate-post-turn-labeling.ts",
  ]],
  ["host/extensions/session/session-profile-files.ts", [
    "host/extensions/session/session-profile-contracts.ts",
    "host/extensions/session/session-profile-update.ts",
    "host/extensions/session/session-avatar-reads.ts",
  ]],
  ["host/extensions/wallpaper/box-wallpaper-commands.ts", [
    "host/extensions/wallpaper/wallpaper-command-contracts.ts",
    "host/extensions/wallpaper/wallpaper-command-runner.ts",
    "host/extensions/wallpaper/wallpaper-display-discovery.ts",
    "host/extensions/wallpaper/wallpaper-tone-plan.ts",
  ]],
  ["packages/agent-summarization/prompt-truncation.ts", [
    "packages/agent-summarization/prompt-truncation-allocation.ts",
    "packages/agent-summarization/prompt-truncation-contracts.ts",
    "packages/agent-summarization/prompt-truncation-user-query.ts",
  ]],
  ["host/transcript/slate-ack-obligation-store.ts", [
    "host/transcript/ack-obligation-records.ts",
    "host/transcript/ack-obligation-file.ts",
  ]],
  ["packages/agent/tools/core/subagent/ci-investigator-subagent.ts", [
    "packages/agent/tools/core/subagent/ci-investigator-contracts.ts",
    "packages/agent/tools/core/subagent/ci-investigator-prompt.ts",
  ]],
  ["packages/cursor-plugins/git-sparse-clone.ts", [
    "packages/plugin-install/sparse-clone-path-policy.ts",
    "packages/plugin-install/sparse-clone-support.ts",
    "packages/plugin-install/sparse-clone-repository.ts",
  ]],
  ["coordinator/telemetry/transport-stage-recorder.ts", [
    "coordinator/telemetry/transport-stage-recorder-contracts.ts",
    "coordinator/telemetry/transport-stage-egress.ts",
    "coordinator/telemetry/transport-stage-echo-ledger.ts",
  ]],
  ["coordinator/control-port-client.ts", [
    "coordinator/control-port-client-contracts.ts",
    "coordinator/control-port-call-ledger.ts",
    "coordinator/control-port-client-lifecycle.ts",
  ]],
  ["coordinator/renderer-port-server.ts", [
    "coordinator/renderer-port-server-contracts.ts",
    "coordinator/renderer-port-request-ledger.ts",
  ]],
  ["packages/agent/prompts/user-info-rule-sections.ts", [
    "packages/agent/prompts/rule-sections-contracts.ts",
    "packages/agent/prompts/rule-sections-projection.ts",
    "packages/agent/prompts/rule-sections-renderers.ts",
  ]],
  ["packages/agent/prompts/user-info-auxiliary-sections.ts", [
    "packages/agent/prompts/user-info-notes-section.ts",
  ]],
  ["packages/agent/context-processing-documentation-hydration.ts", [
    "adapters/interop/agent/selected-documentation-hydration-adapter.ts",
  ]],
  ["packages/agent/context-processing-invocation-hydration.ts", [
    "adapters/interop/agent/selected-invocation-context-hydration-adapter.ts",
  ]],
  ["packages/agent/context-processing-invocation.ts", [
    "adapters/interop/agent/invocation-platforms-adapter.ts",
  ]],
  ["packages/agent/context-processing-agent-notes.ts", [
    "adapters/interop/agent/agent-notes-context-adapter.ts",
  ]],
  ["packages/agent/context-processing-ui-elements.ts", [
    "adapters/interop/agent/selected-ui-elements-adapter.ts",
  ]],
  ["packages/agent/context-processing-recent-agents.ts", [
    "adapters/interop/agent/recent-agents-adapter.ts",
  ]],
  ["packages/agent/context-processing-selected-browsers.ts", [
    "adapters/interop/agent/selected-browsers-adapter.ts",
  ]],
  ["packages/agent/context-processing-selected-subagents.ts", [
    "adapters/interop/agent/selected-subagents-adapter.ts",
  ]],
  ["packages/agent/context-processing-console-logs.ts", [
    "adapters/interop/agent/selected-console-logs-adapter.ts",
  ]],
  ["packages/agent/multitask-action-prompt.ts", [
    "adapters/interop/agent/multitask-action-reason-adapter.ts",
  ]],
  ["host/boxes/box-env.ts", [
    "adapters/interop/agent/box-environment-transport-adapter.ts",
  ]],
  ["host/boxes/box-shell-command.ts", [
    "adapters/interop/agent/box-shell-command-adapter.ts",
  ]],
  ["host/auth/auth-service.ts", [
    "host/auth/auth-service-contracts.ts",
    "host/auth/auth-renewal-events.ts",
    "host/auth/auth-credential-source.ts",
    "host/auth/inference-credential-store.ts",
  ]],
  ["shared/media/attachment-summary.ts", [
    "shared/media/attachment-summary-contracts.ts",
    "shared/media/attachment-summary-mime.ts",
    "shared/media/attachment-summary-path.ts",
  ]],
  ["host/attachments/link-preview-image-bounds.ts", [
    "host/attachments/link-preview-image-contracts.ts",
    "host/attachments/link-preview-image-data.ts",
    "host/attachments/link-preview-image-ico.ts",
  ]],
  ["host/rooms/xuser-turn-dedupe-store.ts", [
    "host/rooms/xuser-turn-dedupe-contracts.ts",
    "host/rooms/xuser-turn-dedupe-file.ts",
    "host/rooms/xuser-turn-dedupe-memory.ts",
  ]],
  ["packages/agent-summarization/pipeline.ts", [
    "packages/agent-summarization/pipeline-contracts.ts",
    "packages/agent-summarization/pipeline-tail-validation.ts",
  ]],
  ["packages/shell-exec/sandbox/helper-protocol.ts", [
    "packages/shell-exec/sandbox/helper-protocol-contracts.ts",
    "packages/shell-exec/sandbox/helper-network-policy.ts",
    "packages/shell-exec/sandbox/helper-command-projection.ts",
    "packages/shell-exec/sandbox/helper-child-process.ts",
  ]],
  ["shared/host-settings-field.ts", [
    "shared/host-settings-field-contracts.ts",
    "shared/host-settings-field-session.ts",
    "shared/host-settings-field-port.ts",
  ]],
  ["host/extensions/state-backstop/state-backstop-service.ts", [
    "host/extensions/state-backstop/state-backstop-contracts.ts",
    "host/extensions/state-backstop/state-backstop-file.ts",
    "host/extensions/state-backstop/state-backstop-object-store.ts",
    "host/extensions/state-backstop/state-backstop-config.ts",
    "host/extensions/state-backstop/state-backstop-snapshot-runner.ts",
  ]],
  ["host/extensions/session/session-conversation-state.ts", [
    "host/extensions/session/session-conversation-state-contracts.ts",
    "host/extensions/session/session-conversation-database-reads.ts",
    "host/extensions/session/session-conversation-session-reads.ts",
  ]],
  ["host/extensions/teach-recording/extension.ts", [
    "host/extensions/teach-recording/teach-recording-extension-contracts.ts",
    "host/extensions/teach-recording/teach-recording-queue-key.ts",
  ]],
  ["host/extensions/managed-setup/managed-skills-cache.ts", [
    "host/extensions/managed-setup/managed-skills-cache-contracts.ts",
    "host/extensions/managed-setup/managed-skills-cache-paths.ts",
    "host/extensions/managed-setup/managed-skills-cache-files.ts",
  ]],
  ["packages/agent/context-processing-path-trust.ts", [
    "packages/agent/context/path-trust-contracts.ts",
    "packages/agent/context/path-trust-guards.ts",
    "packages/agent/context/path-trust-policy.ts",
  ]],
  ["packages/agent/prompts/cloud-meta-agent/self-document.ts", [
    "packages/agent/prompts/cloud-meta-agent/self-document-block.ts",
    "packages/agent/prompts/cloud-meta-agent/self-document-message-content.ts",
  ]],
  ["shared/node/egress-tunnel/egress-tunnel-controller.ts", [
    "shared/node/egress-tunnel/egress-tunnel-config.ts",
    "shared/node/egress-tunnel/egress-tunnel-controller-contracts.ts",
  ]],
  ["packages/agent/git-pr-processing.ts", [
    "packages/agent/git-pr-processing-contracts.ts",
  ]],
  ["host/transcript/extension.ts", [
    "host/transcript/transcript-extension-contracts.ts",
    "host/transcript/transcript-extension-services.ts",
    "host/transcript/transcript-extension-host-events.ts",
  ]],
  ["host/extensions/notify-bus/extension.ts", [
    "host/extensions/notify-bus/notify-bus-handlers.ts",
    "host/extensions/notify-bus/notify-bus-gate-runtime.ts",
  ]],
  ["host/extensions/experiments/extension.ts", [
    "host/extensions/experiments/experiments-extension-api.ts",
    "host/extensions/experiments/experiments-extension-lifecycle.ts",
  ]],
  ["host/extensions/host-upgrade/extension.ts", [
    "host/extensions/host-upgrade/host-upgrade-settings.ts",
    "host/extensions/host-upgrade/host-upgrade-extension-composition.ts",
  ]],
  ["packages/agent/utils/agent-config.ts", [
    "packages/agent/utils/agent-config-contracts.ts",
  ]],
  ["packages/agent/prompts/user-info-git-status.ts", [
    "packages/agent/prompts/git-status-projection.ts",
  ]],
  ["host/mcp/production.ts", [
    "host/mcp/mcp-production-contracts.ts",
    "host/mcp/mcp-production-plugin-skills-port.ts",
  ]],
  ["packages/agent/utils/ip.ts", [
    "packages/agent/utils/ip-address-classification.ts",
  ]],
  ["host/agents/agent-clone.ts", [
    "host/agents/agent-clone-contracts.ts",
    "host/agents/agent-clone-policy.ts",
    "host/agents/agent-clone-file-copy.ts",
  ]],
  ["packages/local-exec/forced-egress.ts", [
    "packages/local-exec/forced-egress-config.ts",
    "packages/local-exec/forced-egress-policy.ts",
  ]],
  ["packages/metrics/index.ts", [
    "packages/metrics/metrics-context.ts",
    "packages/metrics/metrics-instruments.ts",
    "packages/metrics/metrics-contracts.ts",
  ]],
  ["packages/agent/tools/core/read/notebook-format.ts", [
    "packages/agent/tools/core/read/notebook-output-projection.ts",
  ]],
  ["host/connectors/channel-attachment.ts", [
    "host/connectors/channel-attachment-address.ts",
    "host/connectors/channel-attachment-file.ts",
    "host/connectors/channel-attachment-contracts.ts",
  ]],
]);

/**
 * A repo-local record may refresh an existing claim only when it states why the source was remeasured.
 * @param {{claim?: unknown, rewritten?: unknown, floorReason?: unknown} | undefined} previous
 * @param {{claim?: unknown, refreshReason?: unknown, replaceExemption?: unknown}} record
 */
export function mayReplaceExistingRewriteRecord(previous, record) {
  if (previous === undefined) return true;
  const previousClaim = previous.claim ?? (
    typeof previous.rewritten === "string" ? "rewritten" :
    typeof previous.floorReason === "string" ? "floor" :
    undefined
  );
  if (previousClaim === undefined || previousClaim === "withdrawn") return true;
  if (previousClaim === "floor" && record.claim === "rewritten") return true;
  const refreshReason = typeof record.refreshReason === "string" ? record.refreshReason.trim() : "";
  if (previousClaim === "exempt") {
    return record.replaceExemption === true &&
      refreshReason.length > 0 &&
      (record.claim === "rewritten" || record.claim === "floor");
  }
  return refreshReason.length > 0 &&
    (previousClaim === "rewritten" || previousClaim === "floor") &&
    (record.claim === "rewritten" || record.claim === "floor");
}

export function sourcePathsOf(entry) {
  return [sourceOf(entry), ...(SPLIT_SOURCE_GROUPS.get(entry.port) ?? [])];
}

/** Resolve a ledger port before a source alias, since one source file may satisfy multiple ports. */
export function findFileResult(results, query) {
  return results.find((entry) => entry.port === query) ?? results.find((entry) =>
    entry.source === query || entry.sourcePaths?.includes(query),
  );
}

/** A removal disposition retires any old rewrite/floor claim for the same path. */
export function withdrawClaimsForRemovedPorts(ports, ledger, floors) {
  for (const port of ports) {
    ledger.delete(port);
    floors.delete(port);
  }
}

export function removalProblems({ port, record, result, importers, claimed, floor }) {
  const problems = [];
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    problems.push(port + "  removed without a reason");
  }
  if (typeof record.evidence !== "string" || record.evidence.trim().length === 0) {
    problems.push(port + "  removed without behavior evidence");
  }
  if (result === undefined) {
    problems.push(port + "  removal entry is not in the landed checklist");
  } else if (result.missing !== "source") {
    problems.push(port + "  removal entry still has a source file or cannot be measured");
  }
  if (importers.length > 0) {
    problems.push(port + "  removed source still has importers: " + importers.join(", "));
  }
  if (claimed) problems.push(port + "  removed source is also marked rewritten");
  if (floor) problems.push(port + "  removed source is also marked at the floor");
  return problems;
}

/**
 * @param {{
 *   port: string,
 *   record: {claim?: unknown, overlap?: unknown, evidence?: unknown, refreshReason?: unknown, floorReason?: unknown, replaceExemption?: unknown},
 *   result?: {missing?: unknown, overlap?: number, identical?: boolean, exempt?: unknown, sourceExemptions?: unknown},
 *   threshold: number,
 * }} input
 */
export function rewriteRecordProblems({ port, record, result, threshold }) {
  const problems = [];
  if (record.claim !== "rewritten" && record.claim !== "floor") {
    problems.push(port + "  tracked record has an unsupported claim");
  }
  if (typeof record.evidence !== "string" || record.evidence.trim().length === 0) {
    problems.push(port + "  tracked record is missing behavior evidence");
  }
  if (record.refreshReason !== undefined && (typeof record.refreshReason !== "string" || record.refreshReason.trim().length === 0)) {
    problems.push(port + "  refreshed record is missing its reason");
  }
  if (typeof record.overlap !== "number" || !Number.isFinite(record.overlap) || record.overlap < 0 || record.overlap > 1) {
    problems.push(port + "  tracked record is missing a valid measured overlap");
  }
  if (record.claim === "floor" && (typeof record.floorReason !== "string" || record.floorReason.trim().length === 0)) {
    problems.push(port + "  floor record is missing its reason");
  }
  if (result === undefined) {
    problems.push(port + "  tracked record is not in the landed checklist");
    return problems;
  }
  if (result.missing !== undefined) {
    problems.push(port + "  tracked record cannot be measured (missing " + result.missing + ")");
    return problems;
  }
  if (record.replaceExemption === true && (
    result.exempt !== undefined ||
    (Array.isArray(result.sourceExemptions) && result.sourceExemptions.length > 0)
  )) {
    problems.push(port + "  exemption remeasurement still includes generated or interop-owned source");
  }
  if (typeof record.overlap === "number" && Math.abs(record.overlap - result.overlap) > 0.01) {
    problems.push(port + "  tracked record says " + record.overlap + ", measured " + result.overlap.toFixed(3));
  }
  if (record.claim === "rewritten" && (result.identical === true || result.overlap >= threshold)) {
    problems.push(port + "  tracked rewrite claim still overlaps the baseline at or above " + threshold);
  }
  if (record.claim === "floor" && result.overlap < threshold) {
    problems.push(port + "  measured " + result.overlap.toFixed(3) + ", below " + threshold + ": it can be recorded as rewritten");
  }
  return problems;
}

async function importersOfSource(sourcePath) {
  const target = path.resolve(root, "source", sourcePath);
  const importers = [];
  const specifierPattern = /(?:from\s*|import\s*(?:\(\s*)?)[\"']([^\"']+)[\"']/g;

  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const contents = await read(absolute);
      if (contents === null) continue;
      for (const match of contents.matchAll(specifierPattern)) {
        const specifier = match[1];
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        if (path.resolve(path.dirname(absolute), specifier) === target) {
          importers.push(path.relative(root, absolute).split(path.sep).join("/"));
          break;
        }
      }
    }
  };

  await walk(path.join(root, "source"));
  await walk(path.join(root, "tests"));
  return importers.sort();
}

/** Every landed file's numbers, read once so the report, the queue and the gate all speak about the same set. */
async function measure({ landed, removals, baselineFingerprints, usingLocalReference }) {
  const results = [];
  for (const entry of landed) {
    const reason = exemptReason(entry.port);
    const removal = removals.get(entry.port);
    const baseline = usingLocalReference
      ? (await read(path.join(baselineDir, entry.port))) ?? (await read(path.join(baselineDir, entry.reference)))
      : null;
    const fingerprint = baselineFingerprints?.get(entry.port);
    const sourcePaths = sourcePathsOf(entry);
    const sources = await Promise.all(sourcePaths.map((source) => read(path.join(root, "source", source))));
    const sourceMissing = sources.some((source) => source === null);
    if ((baseline === null && fingerprint === undefined) || sourceMissing) {
      results.push({
        ...entry,
        source: sourcePaths.join(", "),
        sourcePaths,
        missing: sourceMissing ? "source" : "baseline",
        exempt: reason,
        ...(removal === undefined ? {} : { removed: removal }),
      });
      continue;
    }
    const sourceTexts = sources;
    results.push({
      ...entry,
      source: sourcePaths.join(", "),
      sourcePaths,
      ...(baseline === null
        ? overlapForOwnedFingerprints(fingerprint, sourcePaths, sourceTexts)
        : overlapForOwnedSources(baseline, sourcePaths, sourceTexts)),
      exempt: reason,
      ...(removal === undefined ? {} : { removed: removal }),
    });
  }
  return results;
}

/** Save only port metadata and one-way token-pair hashes so CI can remeasure without carrying source text. */
async function createFingerprintManifest(state) {
  if (!state.usingLocalReference) {
    throw new Error("fingerprint snapshot generation needs the local read-only reference; refusing to re-fingerprint a prior snapshot");
  }
  const fingerprints = {};
  for (const entry of state.landed) {
    const baseline = (await read(path.join(baselineDir, entry.port))) ?? (await read(path.join(baselineDir, entry.reference)));
    if (baseline === null) throw new Error(`cannot fingerprint missing baseline for ${entry.port}`);
    fingerprints[entry.port] = fingerprintCode(baseline);
  }
  const ledgerEntries = Object.fromEntries(Object.entries(state.referenceLedgerEntries).map(([port, record]) => [port, {
    ...(record.claim === undefined ? {} : { claim: record.claim }),
    ...(record.overlap === undefined ? {} : { overlap: record.overlap }),
    ...(record.floorReason === undefined ? {} : { floorReason: record.floorReason }),
  }]));
  return {
    schemaVersion: 1,
    landed: state.landed.map(({ port, reference, lines, module, rewritten }) => ({ port, reference, lines, module, rewritten })),
    rewritable: [...state.rewritable].sort(),
    ledgerEntries,
    fingerprints,
  };
}

if (command === "file") {
    const result = findFileResult(await measure(await load()), argument);
  if (result === undefined) {
    console.log(`${argument}: not landed`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === "snapshot") {
  const state = await load({ requireLedger: true });
  const manifest = await createFingerprintManifest(state);
  const compressed = gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 9 });
  await writeFile(fingerprintManifestPath, compressed);
  console.log(`wrote ${Object.keys(manifest.fingerprints).length} hash-only baseline fingerprints for ${manifest.landed.length} ports to ${path.relative(root, fingerprintManifestPath)} (${compressed.byteLength} bytes; source text excluded)`);
  process.exit(0);
}

const state = isCli ? await load({ requireLedger: command === "check" }) : null;
const results = state === null ? [] : await measure(state);

if (command === "check") {
  const violations = results.filter((result) => result.exempt === undefined && state.ledger.has(result.port) && !state.rewriteRecords.has(result.port) && (result.identical === true || result.overlap >= threshold));
  const missingClaims = results.filter((result) => result.missing !== undefined && state.ledger.has(result.port) && !state.rewriteRecords.has(result.port));
  const unmeasuredLanded = results.filter((result) =>
    result.missing !== undefined && result.exempt === undefined && !state.removals.has(result.port),
  );
  const orphanClaims = [...state.ledger.keys()].filter((port) => !state.rewriteRecords.has(port) && !results.some((result) => result.port === port));
  for (const violation of violations) {
    console.log(`VIOLATION ${violation.port}  overlap ${violation.overlap.toFixed(3)}${violation.identical ? " (identical)" : ""} — recorded as rewritten, still reproduces the baseline`);
  }
  // A floor claim is only allowed where it is true: it must say why, and it must actually sit at or above the threshold.
  const floorProblems = [];
  for (const [port, record] of state.floors) {
    if (state.rewriteRecords.has(port)) continue;
    const result = results.find((entry) => entry.port === port);
    if (result?.missing !== undefined) {
      floorProblems.push(port + "  claimed at the floor but cannot be measured (missing " + result.missing + ")");
      continue;
    }
    if (result === undefined) {
      floorProblems.push(`${port}  claimed at the floor but is not a landed file`);
      continue;
    }
    if (typeof record.floorReason !== "string" || record.floorReason.trim().length === 0) floorProblems.push(`${port}  claimed at the floor without saying why`);
    if (result.overlap < threshold) floorProblems.push(`${port}  measured ${result.overlap.toFixed(3)}, below ${threshold}: it can be recorded as rewritten`);
    if (result.exempt !== undefined) floorProblems.push(`${port}  is exempt from the gate, so it cannot also be at the floor`);
    if (typeof record.overlap !== "number") floorProblems.push(`${port}  claimed at the floor without its measured overlap`);
    else if (Math.abs(record.overlap - result.overlap) > 0.01) floorProblems.push(`${port}  recorded at ${record.overlap}, measured ${result.overlap.toFixed(3)}`);
  }
  for (const problem of floorProblems) console.log(`FLOOR ${problem}`);
  const trackedRecordProblems = [...state.rewriteRecordProblemsFound];
  for (const [port, record] of state.rewriteRecords) {
    trackedRecordProblems.push(...rewriteRecordProblems({
      port,
      record,
      result: results.find((entry) => entry.port === port),
      threshold,
    }));
  }
  for (const problem of trackedRecordProblems) console.log("RECORD " + problem);
  for (const result of missingClaims) console.log("GATE " + result.port + "  recorded as rewritten but cannot be measured (missing " + result.missing + ")");
  for (const result of unmeasuredLanded) console.log("GATE " + result.port + "  landed source cannot be measured (missing " + result.missing + "); record an intentional removal or restore the source");
  for (const port of orphanClaims) console.log("GATE " + port + "  recorded as rewritten but is not landed");
  const removalProblemsFound = [];
  for (const [port, record] of state.removals) {
    const result = results.find((entry) => entry.port === port);
    const importers = result === undefined ? [] : await importersOfSource(sourceOf(result));
    removalProblemsFound.push(...removalProblems({
      port,
      record,
      result,
      importers,
      claimed: state.ledger.has(port),
      floor: state.floors.has(port),
    }));
  }
  for (const problem of removalProblemsFound) console.log("REMOVED " + problem);
  const rewritten = state.ledger.size;
  const failed = violations.length + floorProblems.length + trackedRecordProblems.length + missingClaims.length + unmeasuredLanded.length + orphanClaims.length + removalProblemsFound.length;
  console.log(failed === 0
    ? "check: " + rewritten + " rewrite claims under " + threshold + ", " + state.floors.size + " floors, " + state.removals.size + " removals; nothing to fix"
    : "check: " + failed + " problem(s) before the ledger may stand as it is");
  process.exit(failed === 0 ? 0 : 1);
}

const counts = new Map();
for (const result of results) {
  const band = state.removals.has(result.port) ? "removed (no product behavior)" : result.exempt !== undefined ? "exempt (adapter/generated)" : result.missing !== undefined ? `no ${result.missing}` : bandOf(result);
  counts.set(band, (counts.get(band) ?? 0) + 1);
}

if (command === "report") {
  const order = ["identical", ">= 0.95", ">= 0.80", "< 0.80", "exempt (adapter/generated)", "removed (no product behavior)", "no baseline", "no source"];
  console.log(`landed ${results.length} files; token overlap against the baseline\n`);
  for (const band of order) console.log(`  ${String(counts.get(band) ?? 0).padStart(5)}  ${band}`);
  for (const removed of results.filter((entry) => state.removals.has(entry.port))) {
    console.log("REMOVED " + removed.port + "  " + state.removals.get(removed.port).reason);
  }
  for (const unmeasured of results.filter((entry) =>
    entry.missing !== undefined && entry.exempt === undefined && !state.removals.has(entry.port),
  )) {
    console.log("UNMEASURED " + unmeasured.port + "  missing " + unmeasured.missing);
  }
  const recorded = results.filter((result) => state.ledger.has(result.port)).length;
  console.log(`\nclaims standing: ${recorded}; still reproducing the baseline at or above ${threshold}: ${results.filter((result) => result.exempt === undefined && state.ledger.has(result.port) && (result.identical === true || result.overlap >= threshold)).length}`);
  const offenders = results
    .filter((result) => result.exempt === undefined && result.identical === true)
    .sort(compareRiskFirst)
    .slice(0, limit);
  if (offenders.length > 0) console.log(`\nidentical to the baseline, largest first (baseline token-pairs):\n${offenders.map((result) => `  ${String(result.baselinePairs).padStart(7)}  ${result.port}`).join("\n")}`);
  const near = results.filter((result) => result.exempt === undefined && result.identical !== true && result.overlap >= 0.95).sort(compareRiskFirst).slice(0, limit);
  if (near.length > 0) console.log(`\n>= 0.95, largest first (baseline token-pairs):\n${near.map((result) => `  ${String(result.baselinePairs).padStart(7)}  ${result.overlap.toFixed(3)}  ${result.port}`).join("\n")}`);
  const floors = results.filter((result) => state.floors.has(result.port)).sort(compareRiskFirst);
  if (floors.length > 0) {
    console.log(`\nat the floor (rewritten as far as the interface allows):\n${floors.map((result) => `  ${String(result.baselinePairs).padStart(7)}  ${result.overlap.toFixed(3)}  ${result.port}  — ${state.floors.get(result.port).floorReason}`).join("\n")}`);
  }
  console.log(`\nexempt from the gate:\n${EXEMPT.map(([prefix, reason]) => `  ${prefix} — ${reason}`).join("\n")}`);
}

if (command === "queue") {
  const pending = results.filter((result) => result.removed === undefined && result.exempt === undefined && result.missing === undefined && state.ledger.has(result.port) === false && state.floors.has(result.port) === false);
  pending.sort(compareRiskFirst);
  console.log(`rewrite queue (risk first, then size): ${pending.length} landed files still to rewrite\n`);
  const unmeasured = results.filter((result) => result.missing !== undefined && result.exempt === undefined && !state.removals.has(result.port));
  for (const result of unmeasured) console.log("  unmeasured  " + result.missing + "  " + result.port);
  for (const result of pending.slice(0, limit)) {
    console.log(`  ${result.identical ? "identical" : result.overlap.toFixed(3)}  ${String(result.baselinePairs).padStart(7)}  ${result.port}`);
  }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hostExtensionDiagnosticTelemetry } from "../../source/host/telemetry/host-extension-diagnostic-telemetry.ts";

describe("host extension diagnostic projection", () => {
  it("reports box-store details as a warning", () => {
    assert.deepEqual(
      hostExtensionDiagnosticTelemetry({
        extension: "box_store",
        kind: "cleanup_failed",
        errorClass: "FilesystemError",
      }),
      {
        level: "warn",
        event: "slate.box_store.diagnostic",
        metadata: { kind: "cleanup_failed", error_class: "FilesystemError" },
      },
    );
  });

  it("projects automation cloud-sync fields into the event metadata", () => {
    assert.deepEqual(
      hostExtensionDiagnosticTelemetry({
        extension: "automation_cloud_sync",
        operation: "publish",
        agentId: "agent-7",
        errorType: "RemoteFailure",
        errorCode: 503,
      }),
      {
        level: "error",
        event: "slate.automation.cloud_sync",
        metadata: {
          operation: "publish",
          agent_id: "agent-7",
          error_type: "RemoteFailure",
          error_code: 503,
        },
      },
    );
  });

  it("raises managed-skill failures to error and keeps other setup failures as warnings", () => {
    assert.deepEqual(
      hostExtensionDiagnosticTelemetry({ extension: "managed_setup", kind: "managed_skills", errorClass: "ParseError" }),
      {
        level: "error",
        event: "slate.managed_setup.load_failed",
        metadata: { kind: "managed_skills", error_class: "ParseError" },
      },
    );
    assert.deepEqual(
      hostExtensionDiagnosticTelemetry({ extension: "managed_setup", kind: "profile", errorClass: "MissingValue" }),
      {
        level: "warn",
        event: "slate.managed_setup.load_failed",
        metadata: { kind: "profile", error_class: "MissingValue" },
      },
    );
  });

  it("stringifies the attachment's active-state flag", () => {
    assert.deepEqual(
      hostExtensionDiagnosticTelemetry({ extension: "attachments", kind: "read_miss", hasActive: false }),
      {
        level: "warn",
        event: "slate.attachment.read_miss",
        metadata: { kind: "read_miss", has_active: "false" },
      },
    );
  });

  it("reports action-audit drops as errors", () => {
    assert.deepEqual(
      hostExtensionDiagnosticTelemetry({ extension: "action_audit", errorClass: "QueueFailure" }),
      {
        level: "error",
        event: "slate.action_audit.drop",
        metadata: { error_class: "QueueFailure" },
      },
    );
  });

  it("reports MCP host-edge failures at informational level", () => {
    assert.deepEqual(
      hostExtensionDiagnosticTelemetry({ extension: "mcp", leg: "host", errorClass: "TransportFailure" }),
      {
        level: "info",
        event: "slate.mcp.host_edge_failed",
        metadata: { leg: "host", error_class: "TransportFailure" },
      },
    );
  });

  it("ignores extensions with no registered projection", () => {
    assert.equal(hostExtensionDiagnosticTelemetry({ extension: "future_extension" }), undefined);
  });
});

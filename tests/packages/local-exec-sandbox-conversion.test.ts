import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adaptSandboxPolicyFromInterop as convertProtoToInternalPolicy,
  adaptSandboxPolicyToInterop as convertInternalToProtoPolicy,
} from "../../source/adapters/interop/agent/sandbox-policy-adapter.ts";
import {
  NetworkPolicy,
  NetworkPolicy_DefaultAction,
  NetworkPolicyLoggingConfig,
  SandboxPolicy,
  SandboxPolicy_ReadBoundaryMode,
  SandboxPolicy_Type,
} from "../../source/adapters/interop/proto/generated/agent/v1/sandbox_pb.ts";

const protoPolicy = (fields: Record<string, unknown>) => new SandboxPolicy(fields as never);
const network = (fields: Record<string, unknown>) => new NetworkPolicy(fields as never);
const logging = (fields: Record<string, unknown>) => new NetworkPolicyLoggingConfig(fields as never);

describe("sandbox policy conversion", () => {
  it("turns an absent policy into the insecure one", () => {
    assert.deepEqual(convertProtoToInternalPolicy(undefined), { type: "insecure_none" });
    assert.equal(convertInternalToProtoPolicy(undefined), undefined);
  });

  it("keeps the insecure policy options on both sides", () => {
    const proto = protoPolicy({
      type: SandboxPolicy_Type.INSECURE_NONE,
      allowlistEscalated: true,
      enableSharedBuildCache: true,
      debugOutputDir: "/tmp/debug",
      captureDenies: true,
    });
    const internal = convertProtoToInternalPolicy(proto);
    assert.deepEqual(internal, {
      type: "insecure_none",
      allowlistEscalated: true,
      enableSharedBuildCache: true,
      debugOutputDir: "/tmp/debug",
      captureDenies: true,
    });
    const back = convertInternalToProtoPolicy(internal)!;
    assert.equal(back.type, SandboxPolicy_Type.INSECURE_NONE);
    assert.equal(back.allowlistEscalated, true);
    assert.equal(back.enableSharedBuildCache, true);
    assert.equal(back.debugOutputDir, "/tmp/debug");
    assert.equal(back.captureDenies, true);
  });

  it("makes no explicit network the requested default", () => {
    const allowed = convertProtoToInternalPolicy(protoPolicy({ type: SandboxPolicy_Type.WORKSPACE_READWRITE, networkAccess: true }));
    assert.deepEqual(allowed.networkPolicy, { version: 1, default: "allow" });
    const denied = convertProtoToInternalPolicy(protoPolicy({ type: SandboxPolicy_Type.WORKSPACE_READWRITE, networkAccess: false }));
    assert.deepEqual(denied.networkPolicy, { version: 1, default: "deny" });
  });

  it("carries an explicit network policy in both directions", () => {
    const proto = protoPolicy({
      type: SandboxPolicy_Type.WORKSPACE_READWRITE,
      networkPolicy: network({
        version: 2,
        defaultAction: NetworkPolicy_DefaultAction.DENY,
        deny: ["a.example.com"],
        allow: ["b.example.com"],
        logging: logging({ decisionLogPath: "/tmp/decisions.log", logFormat: "json" }),
      }),
    });
    const internal = convertProtoToInternalPolicy(proto);
    assert.deepEqual(internal.networkPolicy, {
      version: 2,
      default: "deny",
      deny: ["a.example.com"],
      allow: ["b.example.com"],
      logging: { decisionLogPath: "/tmp/decisions.log", logFormat: "json" },
    });
    const back = convertInternalToProtoPolicy(internal)!;
    assert.equal(back.networkAccess, true);
    assert.equal(back.networkPolicy?.defaultAction, NetworkPolicy_DefaultAction.DENY);
    assert.deepEqual([...back.networkPolicy!.deny], ["a.example.com"]);
    assert.deepEqual([...back.networkPolicy!.allow], ["b.example.com"]);
    assert.equal(back.networkPolicy?.logging?.decisionLogPath, "/tmp/decisions.log");
    assert.equal(back.networkPolicy?.logging?.logFormat, "json");
  });

  it("keeps an explicit allow network as allow", () => {
    const internal = convertProtoToInternalPolicy(protoPolicy({
      type: SandboxPolicy_Type.WORKSPACE_READWRITE,
      networkPolicy: network({ version: 1, defaultAction: NetworkPolicy_DefaultAction.ALLOW, allow: ["c.example.com"] }),
    }));
    assert.deepEqual(internal.networkPolicy, { version: 1, default: "allow", allow: ["c.example.com"] });
  });

  it("does not send network access when only the default denies", () => {
    const back = convertInternalToProtoPolicy({ type: "workspace_readwrite", networkPolicy: { version: 1, default: "deny" } })!;
    assert.equal(back.networkAccess, false);
    assert.equal(back.networkPolicy?.defaultAction, NetworkPolicy_DefaultAction.DENY);
  });

  it("sends network access when the default allows or the allow list is not empty", () => {
    const allowAll = convertInternalToProtoPolicy({ type: "workspace_readwrite", networkPolicy: { version: 1, default: "allow" } })!;
    assert.equal(allowAll.networkAccess, true);
    const allowList = convertInternalToProtoPolicy({ type: "workspace_readwrite", networkPolicy: { version: 1, default: "deny", allow: ["x"] } })!;
    assert.equal(allowList.networkAccess, true);
  });

  it("maps the read boundary and its extra paths", () => {
    const system = convertProtoToInternalPolicy(protoPolicy({ type: SandboxPolicy_Type.WORKSPACE_READWRITE, readBoundary: SandboxPolicy_ReadBoundaryMode.SYSTEM, additionalReadPaths: ["/x"] }));
    assert.equal(system.readBoundary, "system");
    assert.equal(system.additionalReadPaths, undefined);
    const custom = convertProtoToInternalPolicy(protoPolicy({ type: SandboxPolicy_Type.WORKSPACE_READWRITE, readBoundary: SandboxPolicy_ReadBoundaryMode.CUSTOM, additionalReadPaths: ["/x"] }));
    assert.equal(custom.readBoundary, "workspace");
    assert.deepEqual(custom.additionalReadPaths, ["/x"]);
    const sent = convertInternalToProtoPolicy({ type: "workspace_readwrite", readBoundary: "workspace", additionalReadPaths: ["/x"] })!;
    assert.equal(sent.readBoundary, SandboxPolicy_ReadBoundaryMode.WORKSPACE);
    assert.deepEqual([...sent.additionalReadPaths], ["/x"]);
    const sentSystem = convertInternalToProtoPolicy({ type: "workspace_readwrite", readBoundary: "system", additionalReadPaths: ["/x"] })!;
    assert.equal(sentSystem.readBoundary, SandboxPolicy_ReadBoundaryMode.SYSTEM);
    assert.deepEqual([...sentSystem.additionalReadPaths], []);
  });

  it("round-trips the workspace policies", () => {
    for (const type of [SandboxPolicy_Type.WORKSPACE_READWRITE, SandboxPolicy_Type.WORKSPACE_READONLY] as const) {
      const internal = convertProtoToInternalPolicy(protoPolicy({
        type,
        skipStatsigDefaults: true,
        additionalReadwritePaths: ["/rw"],
        additionalReadonlyPaths: ["/ro"],
        disableTmpWrite: true,
        enableSharedBuildCache: true,
        debugOutputDir: "/tmp/d",
        captureDenies: true,
        networkPolicyStrict: true,
      }));
      const back = convertInternalToProtoPolicy(internal)!;
      assert.equal(back.type, type);
      assert.equal(back.skipStatsigDefaults, true);
      assert.deepEqual([...back.additionalReadonlyPaths], ["/ro"]);
      assert.equal(back.disableTmpWrite, true);
      assert.equal(back.enableSharedBuildCache, true);
      assert.equal(back.debugOutputDir, "/tmp/d");
      assert.equal(back.captureDenies, true);
      assert.equal(back.networkPolicyStrict, true);
      if (type === SandboxPolicy_Type.WORKSPACE_READWRITE) assert.deepEqual([...back.additionalReadwritePaths], ["/rw"]);
    }
  });
});

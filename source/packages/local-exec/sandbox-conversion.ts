/**
 * The sandbox policy on both sides of the wire.
 *
 * The policy the executor works with and the policy that travels to the host are the same rules in different shapes, so
 * they are converted in both directions: the network policy with its default, its lists and its logging, the read
 * boundary, the extra paths, the write protections and the ignore mappings. A policy that names no network at all
 * becomes the policy that denies it, and a policy that is absent stays absent rather than becoming an empty one.
 */
import {
  NetworkPolicy as NetworkPolicyProto,
  NetworkPolicy_DefaultAction,
  NetworkPolicyLoggingConfig,
  SandboxPolicy,
  SandboxPolicy_ReadBoundaryMode,
  SandboxPolicy_Type,
  type NetworkPolicy as NetworkPolicyMessage,
  type SandboxPolicy as SandboxPolicyMessage,
} from "../proto/generated/agent/v1/sandbox_pb.ts";

interface NetworkPolicy {
  readonly version?: number | undefined;
  readonly default?: "allow" | "deny" | undefined;
  readonly deny?: readonly string[] | undefined;
  readonly allow?: readonly string[] | undefined;
  readonly logging?: {
    readonly decisionLogPath?: string | undefined;
    readonly logFormat?: string | undefined;
  } | undefined;
}

export interface SandboxRule {
  readonly type: "insecure_none" | "workspace_readwrite" | "workspace_readonly";
  readonly networkPolicy?: NetworkPolicy | undefined;
  readonly skipStatsigDefaults?: boolean | undefined;
  readonly additionalReadwritePaths?: readonly string[] | undefined;
  readonly additionalReadonlyPaths?: readonly string[] | undefined;
  readonly disableTmpWrite?: boolean | undefined;
  readonly enableSharedBuildCache?: boolean | undefined;
  readonly debugOutputDir?: string | undefined;
  readonly captureDenies?: boolean | undefined;
  readonly networkPolicyStrict?: boolean | undefined;
  readonly readBoundary?: "system" | "workspace" | undefined;
  readonly additionalReadPaths?: readonly string[] | undefined;
  readonly allowlistEscalated?: boolean | undefined;
  readonly ignoreMapping?: unknown;
}

function networkFromProto(sandboxValue: NetworkPolicyMessage | undefined): NetworkPolicy | undefined {
  if (!sandboxValue) return undefined;
  const networkShape: NetworkPolicy = {
    ...(sandboxValue.version === undefined ? {} : { version: sandboxValue.version }),
  };
  if (sandboxValue.defaultAction !== undefined) {
    switch (sandboxValue.defaultAction) {
      case NetworkPolicy_DefaultAction.ALLOW:
        return {
          ...networkShape,
          default: "allow",
          ...(sandboxValue.deny.length === 0 ? {} : { deny: [...sandboxValue.deny] }),
          ...(sandboxValue.allow.length === 0 ? {} : { allow: [...sandboxValue.allow] }),
          ...(sandboxValue.logging === undefined ? {} : { logging: loggingFromProto(sandboxValue.logging) }),
        };
      case NetworkPolicy_DefaultAction.DENY:
        return {
          ...networkShape,
          default: "deny",
          ...(sandboxValue.deny.length === 0 ? {} : { deny: [...sandboxValue.deny] }),
          ...(sandboxValue.allow.length === 0 ? {} : { allow: [...sandboxValue.allow] }),
          ...(sandboxValue.logging === undefined ? {} : { logging: loggingFromProto(sandboxValue.logging) }),
        };
    }
  }
  return {
    ...networkShape,
    ...(sandboxValue.deny.length === 0 ? {} : { deny: [...sandboxValue.deny] }),
    ...(sandboxValue.allow.length === 0 ? {} : { allow: [...sandboxValue.allow] }),
    ...(sandboxValue.logging === undefined ? {} : { logging: loggingFromProto(sandboxValue.logging) }),
  };
}

function networkToProto(sandboxValue: NetworkPolicy | undefined): NetworkPolicyMessage | undefined {
  if (!sandboxValue) return undefined;
  let defaultAction: NetworkPolicy_DefaultAction | undefined;
  if (sandboxValue.default === "allow") defaultAction = NetworkPolicy_DefaultAction.ALLOW;
  else if (sandboxValue.default === "deny") defaultAction = NetworkPolicy_DefaultAction.DENY;
  return new NetworkPolicyProto({
    ...(sandboxValue.version === undefined ? {} : { version: sandboxValue.version }),
    ...(defaultAction === undefined ? {} : { defaultAction }),
    deny: [...(sandboxValue.deny ?? [])],
    allow: [...(sandboxValue.allow ?? [])],
    ...(sandboxValue.logging === undefined ? {} : { logging: loggingToProto(sandboxValue.logging) }),
  });
}

function loggingFromProto(loggingConfig: NetworkPolicyMessage["logging"]): NetworkPolicy["logging"] {
  if (!loggingConfig) return undefined;
  return {
    ...(loggingConfig.decisionLogPath === undefined ? {} : { decisionLogPath: loggingConfig.decisionLogPath }),
    ...(loggingConfig.logFormat === undefined ? {} : { logFormat: loggingConfig.logFormat }),
  };
}

function loggingToProto(loggingConfig: NonNullable<NetworkPolicy["logging"]>): NetworkPolicyLoggingConfig {
  return new NetworkPolicyLoggingConfig({
    ...(loggingConfig.decisionLogPath === undefined ? {} : { decisionLogPath: loggingConfig.decisionLogPath }),
    ...(loggingConfig.logFormat === undefined ? {} : { logFormat: loggingConfig.logFormat }),
  });
}

function denyNetwork(): NetworkPolicy {
  return { version: 1, default: "deny" };
}

function allowNetwork(): NetworkPolicy {
  return { version: 1, default: "allow" };
}

function resolveNetwork(sandboxValue: SandboxPolicyMessage): NetworkPolicy {
  const explicitNetwork = networkFromProto(sandboxValue.networkPolicy);
  return explicitNetwork ?? (sandboxValue.networkAccess ? allowNetwork() : denyNetwork());
}

function readBoundaryFromProto(boundaryMode: SandboxPolicyMessage["readBoundary"]): "system" | "workspace" | undefined {
  switch (boundaryMode) {
    case SandboxPolicy_ReadBoundaryMode.SYSTEM:
      return "system";
    case SandboxPolicy_ReadBoundaryMode.WORKSPACE:
    case SandboxPolicy_ReadBoundaryMode.CUSTOM:
      return "workspace";
    case SandboxPolicy_ReadBoundaryMode.UNSPECIFIED:
    default:
      return undefined;
  }
}

function readBoundaryToProto(boundaryName: SandboxRule["readBoundary"]): SandboxPolicy_ReadBoundaryMode {
  switch (boundaryName) {
    case "system":
      return SandboxPolicy_ReadBoundaryMode.SYSTEM;
    case "workspace":
      return SandboxPolicy_ReadBoundaryMode.WORKSPACE;
    default:
      return SandboxPolicy_ReadBoundaryMode.UNSPECIFIED;
  }
}

function sandboxProtoFields(sandboxValue: SandboxPolicyMessage): {
  readonly readBoundary: "system" | "workspace" | undefined;
  readonly additionalReadPaths: readonly string[] | undefined;
} {
  const readBoundary = readBoundaryFromProto(sandboxValue.readBoundary);
  const readPathList = sandboxValue.additionalReadPaths;
  return {
    readBoundary,
    additionalReadPaths: readBoundary === "workspace" && readPathList.length > 0 ? readPathList : undefined,
  };
}

export function convertProtoToInternalPolicy(sandboxValue: SandboxPolicyMessage | undefined): SandboxRule {
  if (!sandboxValue) return { type: "insecure_none" };
  switch (sandboxValue.type) {
    case SandboxPolicy_Type.INSECURE_NONE:
    case SandboxPolicy_Type.UNSPECIFIED:
      return {
        type: "insecure_none",
        allowlistEscalated: sandboxValue.allowlistEscalated,
        enableSharedBuildCache: sandboxValue.enableSharedBuildCache,
        debugOutputDir: sandboxValue.debugOutputDir,
        captureDenies: sandboxValue.captureDenies,
      };
    case SandboxPolicy_Type.WORKSPACE_READWRITE:
      return {
        type: "workspace_readwrite",
        networkPolicy: resolveNetwork(sandboxValue),
        skipStatsigDefaults: sandboxValue.skipStatsigDefaults,
        additionalReadwritePaths: sandboxValue.additionalReadwritePaths,
        additionalReadonlyPaths: sandboxValue.additionalReadonlyPaths,
        disableTmpWrite: sandboxValue.disableTmpWrite,
        enableSharedBuildCache: sandboxValue.enableSharedBuildCache,
        debugOutputDir: sandboxValue.debugOutputDir,
        captureDenies: sandboxValue.captureDenies,
        networkPolicyStrict: sandboxValue.networkPolicyStrict,
        ...sandboxProtoFields(sandboxValue),
      };
    case SandboxPolicy_Type.WORKSPACE_READONLY:
      return {
        type: "workspace_readonly",
        networkPolicy: resolveNetwork(sandboxValue),
        skipStatsigDefaults: sandboxValue.skipStatsigDefaults,
        additionalReadonlyPaths: sandboxValue.additionalReadonlyPaths,
        disableTmpWrite: sandboxValue.disableTmpWrite,
        enableSharedBuildCache: sandboxValue.enableSharedBuildCache,
        debugOutputDir: sandboxValue.debugOutputDir,
        captureDenies: sandboxValue.captureDenies,
        networkPolicyStrict: sandboxValue.networkPolicyStrict,
        ...sandboxProtoFields(sandboxValue),
      };
    default:
      return { type: "insecure_none" };
  }
}

export function convertInternalToProtoPolicy(sandboxValue: SandboxRule | undefined): SandboxPolicyMessage | undefined {
  if (!sandboxValue) return undefined;
  if (sandboxValue.type === "insecure_none") {
    return new SandboxPolicy({
      type: SandboxPolicy_Type.INSECURE_NONE,
      ...(sandboxValue.allowlistEscalated === undefined ? {} : { allowlistEscalated: sandboxValue.allowlistEscalated }),
      ...(sandboxValue.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: sandboxValue.enableSharedBuildCache }),
      ...(sandboxValue.debugOutputDir === undefined ? {} : { debugOutputDir: sandboxValue.debugOutputDir }),
      ...(sandboxValue.captureDenies === undefined ? {} : { captureDenies: sandboxValue.captureDenies }),
    });
  }
  if (sandboxValue.type !== "workspace_readwrite" && sandboxValue.type !== "workspace_readonly") {
    return new SandboxPolicy({ type: SandboxPolicy_Type.INSECURE_NONE });
  }
  const networkPolicy = networkToProto(sandboxValue.networkPolicy);
  const commonFields = {
    type: sandboxValue.type === "workspace_readwrite" ? SandboxPolicy_Type.WORKSPACE_READWRITE : SandboxPolicy_Type.WORKSPACE_READONLY,
    networkAccess: sandboxValue.networkPolicy?.default === "allow" || (sandboxValue.networkPolicy?.allow?.length ?? 0) > 0,
    ...(sandboxValue.skipStatsigDefaults === undefined ? {} : { skipStatsigDefaults: sandboxValue.skipStatsigDefaults }),
    ...(sandboxValue.additionalReadonlyPaths === undefined ? {} : { additionalReadonlyPaths: [...sandboxValue.additionalReadonlyPaths] }),
    ...(sandboxValue.disableTmpWrite === undefined ? {} : { disableTmpWrite: sandboxValue.disableTmpWrite }),
    ...(sandboxValue.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: sandboxValue.enableSharedBuildCache }),
    ...(sandboxValue.debugOutputDir === undefined ? {} : { debugOutputDir: sandboxValue.debugOutputDir }),
    ...(sandboxValue.captureDenies === undefined ? {} : { captureDenies: sandboxValue.captureDenies }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
    ...(sandboxValue.networkPolicyStrict === undefined ? {} : { networkPolicyStrict: sandboxValue.networkPolicyStrict }),
    readBoundary: readBoundaryToProto(sandboxValue.readBoundary),
    additionalReadPaths: sandboxValue.readBoundary === "workspace" ? [...(sandboxValue.additionalReadPaths ?? [])] : [],
  };
  if (sandboxValue.type === "workspace_readwrite") {
    return new SandboxPolicy({
      ...commonFields,
      additionalReadwritePaths: [...(sandboxValue.additionalReadwritePaths ?? [])],
    });
  }
  return new SandboxPolicy(commonFields);
}

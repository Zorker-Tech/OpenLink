/** Maps Slate's sandbox policy to and from the remote executor message. */
import {
  NetworkPolicy as InteropNetworkPolicy,
  NetworkPolicy_DefaultAction,
  NetworkPolicyLoggingConfig,
  SandboxPolicy,
  SandboxPolicy_ReadBoundaryMode,
  SandboxPolicy_Type,
  type NetworkPolicy as InteropNetworkPolicyMessage,
  type SandboxPolicy as InteropSandboxPolicyMessage,
} from "../proto/generated/agent/v1/sandbox_pb.ts"
import type { SandboxNetworkPolicy, SandboxRule } from "../../../packages/local-exec/sandbox-policy.ts"

function networkFromInterop(value: InteropNetworkPolicyMessage | undefined): SandboxNetworkPolicy | undefined {
  if (!value) return undefined
  const networkShape: SandboxNetworkPolicy = {
    ...(value.version === undefined ? {} : { version: value.version }),
  }
  if (value.defaultAction !== undefined) {
    switch (value.defaultAction) {
      case NetworkPolicy_DefaultAction.ALLOW:
        return {
          ...networkShape,
          default: "allow",
          ...(value.deny.length === 0 ? {} : { deny: [...value.deny] }),
          ...(value.allow.length === 0 ? {} : { allow: [...value.allow] }),
          ...(value.logging === undefined ? {} : { logging: loggingFromInterop(value.logging) }),
        }
      case NetworkPolicy_DefaultAction.DENY:
        return {
          ...networkShape,
          default: "deny",
          ...(value.deny.length === 0 ? {} : { deny: [...value.deny] }),
          ...(value.allow.length === 0 ? {} : { allow: [...value.allow] }),
          ...(value.logging === undefined ? {} : { logging: loggingFromInterop(value.logging) }),
        }
    }
  }
  return {
    ...networkShape,
    ...(value.deny.length === 0 ? {} : { deny: [...value.deny] }),
    ...(value.allow.length === 0 ? {} : { allow: [...value.allow] }),
    ...(value.logging === undefined ? {} : { logging: loggingFromInterop(value.logging) }),
  }
}

function networkToInterop(value: SandboxNetworkPolicy | undefined): InteropNetworkPolicyMessage | undefined {
  if (!value) return undefined
  let defaultAction: NetworkPolicy_DefaultAction | undefined
  if (value.default === "allow") defaultAction = NetworkPolicy_DefaultAction.ALLOW
  else if (value.default === "deny") defaultAction = NetworkPolicy_DefaultAction.DENY
  return new InteropNetworkPolicy({
    ...(value.version === undefined ? {} : { version: value.version }),
    ...(defaultAction === undefined ? {} : { defaultAction }),
    deny: [...(value.deny ?? [])],
    allow: [...(value.allow ?? [])],
    ...(value.logging === undefined ? {} : { logging: loggingToInterop(value.logging) }),
  })
}

function loggingFromInterop(value: InteropNetworkPolicyMessage["logging"]): SandboxNetworkPolicy["logging"] {
  if (!value) return undefined
  return {
    ...(value.decisionLogPath === undefined ? {} : { decisionLogPath: value.decisionLogPath }),
    ...(value.logFormat === undefined ? {} : { logFormat: value.logFormat }),
  }
}

function loggingToInterop(value: NonNullable<SandboxNetworkPolicy["logging"]>): NetworkPolicyLoggingConfig {
  return new NetworkPolicyLoggingConfig({
    ...(value.decisionLogPath === undefined ? {} : { decisionLogPath: value.decisionLogPath }),
    ...(value.logFormat === undefined ? {} : { logFormat: value.logFormat }),
  })
}

function denyNetwork(): SandboxNetworkPolicy {
  return { version: 1, default: "deny" }
}

function allowNetwork(): SandboxNetworkPolicy {
  return { version: 1, default: "allow" }
}

function resolveNetwork(value: InteropSandboxPolicyMessage): SandboxNetworkPolicy {
  const explicitNetwork = networkFromInterop(value.networkPolicy)
  return explicitNetwork ?? (value.networkAccess ? allowNetwork() : denyNetwork())
}

function readBoundaryFromInterop(value: InteropSandboxPolicyMessage["readBoundary"]): "system" | "workspace" | undefined {
  switch (value) {
    case SandboxPolicy_ReadBoundaryMode.SYSTEM:
      return "system"
    case SandboxPolicy_ReadBoundaryMode.WORKSPACE:
    case SandboxPolicy_ReadBoundaryMode.CUSTOM:
      return "workspace"
    case SandboxPolicy_ReadBoundaryMode.UNSPECIFIED:
    default:
      return undefined
  }
}

function readBoundaryToInterop(value: SandboxRule["readBoundary"]): SandboxPolicy_ReadBoundaryMode {
  switch (value) {
    case "system":
      return SandboxPolicy_ReadBoundaryMode.SYSTEM
    case "workspace":
      return SandboxPolicy_ReadBoundaryMode.WORKSPACE
    default:
      return SandboxPolicy_ReadBoundaryMode.UNSPECIFIED
  }
}

function sandboxFieldsFromInterop(value: InteropSandboxPolicyMessage): {
  readonly readBoundary: "system" | "workspace" | undefined
  readonly additionalReadPaths: readonly string[] | undefined
} {
  const readBoundary = readBoundaryFromInterop(value.readBoundary)
  const readPaths = value.additionalReadPaths
  return {
    readBoundary,
    additionalReadPaths: readBoundary === "workspace" && readPaths.length > 0 ? readPaths : undefined,
  }
}

export function adaptSandboxPolicyFromInterop(value: InteropSandboxPolicyMessage | undefined): SandboxRule {
  if (!value) return { type: "insecure_none" }
  switch (value.type) {
    case SandboxPolicy_Type.INSECURE_NONE:
    case SandboxPolicy_Type.UNSPECIFIED:
      return {
        type: "insecure_none",
        allowlistEscalated: value.allowlistEscalated,
        enableSharedBuildCache: value.enableSharedBuildCache,
        debugOutputDir: value.debugOutputDir,
        captureDenies: value.captureDenies,
      }
    case SandboxPolicy_Type.WORKSPACE_READWRITE:
      return {
        type: "workspace_readwrite",
        networkPolicy: resolveNetwork(value),
        skipStatsigDefaults: value.skipStatsigDefaults,
        additionalReadwritePaths: value.additionalReadwritePaths,
        additionalReadonlyPaths: value.additionalReadonlyPaths,
        disableTmpWrite: value.disableTmpWrite,
        enableSharedBuildCache: value.enableSharedBuildCache,
        debugOutputDir: value.debugOutputDir,
        captureDenies: value.captureDenies,
        networkPolicyStrict: value.networkPolicyStrict,
        ...sandboxFieldsFromInterop(value),
      }
    case SandboxPolicy_Type.WORKSPACE_READONLY:
      return {
        type: "workspace_readonly",
        networkPolicy: resolveNetwork(value),
        skipStatsigDefaults: value.skipStatsigDefaults,
        additionalReadonlyPaths: value.additionalReadonlyPaths,
        disableTmpWrite: value.disableTmpWrite,
        enableSharedBuildCache: value.enableSharedBuildCache,
        debugOutputDir: value.debugOutputDir,
        captureDenies: value.captureDenies,
        networkPolicyStrict: value.networkPolicyStrict,
        ...sandboxFieldsFromInterop(value),
      }
    default:
      return { type: "insecure_none" }
  }
}

/** Decodes an opaque shell request field while keeping the generated message type inside this adapter. */
export function adaptSandboxPolicyValueFromInterop(value: unknown): SandboxRule {
  return adaptSandboxPolicyFromInterop(value as InteropSandboxPolicyMessage | undefined)
}

export function adaptSandboxPolicyToInterop(value: SandboxRule | undefined): InteropSandboxPolicyMessage | undefined {
  if (!value) return undefined
  if (value.type === "insecure_none") {
    return new SandboxPolicy({
      type: SandboxPolicy_Type.INSECURE_NONE,
      ...(value.allowlistEscalated === undefined ? {} : { allowlistEscalated: value.allowlistEscalated }),
      ...(value.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: value.enableSharedBuildCache }),
      ...(value.debugOutputDir === undefined ? {} : { debugOutputDir: value.debugOutputDir }),
      ...(value.captureDenies === undefined ? {} : { captureDenies: value.captureDenies }),
    })
  }
  if (value.type !== "workspace_readwrite" && value.type !== "workspace_readonly") {
    return new SandboxPolicy({ type: SandboxPolicy_Type.INSECURE_NONE })
  }
  const networkPolicy = networkToInterop(value.networkPolicy)
  const commonFields = {
    type: value.type === "workspace_readwrite" ? SandboxPolicy_Type.WORKSPACE_READWRITE : SandboxPolicy_Type.WORKSPACE_READONLY,
    networkAccess: value.networkPolicy?.default === "allow" || (value.networkPolicy?.allow?.length ?? 0) > 0,
    ...(value.skipStatsigDefaults === undefined ? {} : { skipStatsigDefaults: value.skipStatsigDefaults }),
    ...(value.additionalReadonlyPaths === undefined ? {} : { additionalReadonlyPaths: [...value.additionalReadonlyPaths] }),
    ...(value.disableTmpWrite === undefined ? {} : { disableTmpWrite: value.disableTmpWrite }),
    ...(value.enableSharedBuildCache === undefined ? {} : { enableSharedBuildCache: value.enableSharedBuildCache }),
    ...(value.debugOutputDir === undefined ? {} : { debugOutputDir: value.debugOutputDir }),
    ...(value.captureDenies === undefined ? {} : { captureDenies: value.captureDenies }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
    ...(value.networkPolicyStrict === undefined ? {} : { networkPolicyStrict: value.networkPolicyStrict }),
    readBoundary: readBoundaryToInterop(value.readBoundary),
    additionalReadPaths: value.readBoundary === "workspace" ? [...(value.additionalReadPaths ?? [])] : [],
  }
  if (value.type === "workspace_readwrite") {
    return new SandboxPolicy({
      ...commonFields,
      additionalReadwritePaths: [...(value.additionalReadwritePaths ?? [])],
    })
  }
  return new SandboxPolicy(commonFields)
}

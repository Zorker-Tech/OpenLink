/** Slate's normalized network policy, independent of the message used to transport it. */
export interface SandboxNetworkPolicy {
  readonly version?: number | undefined
  readonly default?: "allow" | "deny" | undefined
  readonly deny?: readonly string[] | undefined
  readonly allow?: readonly string[] | undefined
  readonly logging?: {
    readonly decisionLogPath?: string | undefined
    readonly logFormat?: string | undefined
  } | undefined
}

/** Slate's sandbox request after interop values have been projected into product-owned names. */
export interface SandboxRule {
  readonly type: "insecure_none" | "workspace_readwrite" | "workspace_readonly"
  readonly networkPolicy?: SandboxNetworkPolicy | undefined
  readonly skipStatsigDefaults?: boolean | undefined
  readonly additionalReadwritePaths?: readonly string[] | undefined
  readonly additionalReadonlyPaths?: readonly string[] | undefined
  readonly disableTmpWrite?: boolean | undefined
  readonly enableSharedBuildCache?: boolean | undefined
  readonly debugOutputDir?: string | undefined
  readonly captureDenies?: boolean | undefined
  readonly networkPolicyStrict?: boolean | undefined
  readonly readBoundary?: "system" | "workspace" | undefined
  readonly additionalReadPaths?: readonly string[] | undefined
  readonly allowlistEscalated?: boolean | undefined
  readonly ignoreMapping?: unknown
}

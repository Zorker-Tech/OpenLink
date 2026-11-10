export interface RewriteOverlap {
  readonly overlap: number
  readonly baselinePairs: number
  readonly identical: boolean
}

export interface RewriteGateResult {
  readonly problems: string[]
  readonly rewritten: number
}

export interface RewriteTokenPairFingerprint {
  readonly baselinePairs: number
  readonly tokenSequenceHash: string
  readonly pairCounts: Readonly<Record<string, number>>
}

export function codeTokens(code: string): string[]
export function fingerprintCode(code: string): RewriteTokenPairFingerprint
export function compareRiskFirst(
  left: { readonly baselinePairs?: number; readonly identical?: boolean; readonly overlap: number; readonly lines: number; readonly port: string },
  right: { readonly baselinePairs?: number; readonly identical?: boolean; readonly overlap: number; readonly lines: number; readonly port: string },
): number
export function overlapOf(baselineText: string, ourText: string | readonly string[]): RewriteOverlap
export function overlapOfFingerprint(fingerprint: RewriteTokenPairFingerprint, ourText: string | readonly string[]): RewriteOverlap
export function exemptSourceReason(sourcePath: string): string | undefined
export function overlapForOwnedSources(
  baselineText: string,
  sourcePaths: readonly string[],
  sourceTexts: readonly string[],
): RewriteOverlap & {
  readonly sourceExemptions: readonly { readonly path: string; readonly reason: string }[]
}
export function overlapForOwnedFingerprints(
  fingerprint: RewriteTokenPairFingerprint,
  sourcePaths: readonly string[],
  sourceTexts: readonly string[],
): RewriteOverlap & {
  readonly sourceExemptions: readonly { readonly path: string; readonly reason: string }[]
}
export function parseOptions(args: readonly string[]): Map<string, string>
export function removalProblems(input: {
  readonly port: string
  readonly record: { readonly reason?: unknown; readonly evidence?: unknown }
  readonly result: { readonly missing?: string } | undefined
  readonly importers: readonly string[]
  readonly claimed: boolean
  readonly floor: boolean
}): string[]
export function rewriteRecordProblems(input: {
  readonly port: string
  readonly record: {
    readonly claim?: unknown
    readonly overlap?: unknown
    readonly evidence?: unknown
    readonly floorReason?: unknown
    readonly refreshReason?: unknown
    readonly replaceExemption?: unknown
  }
  readonly result: {
    readonly missing?: string
    readonly overlap: number
    readonly identical: boolean
    readonly exempt?: unknown
    readonly sourceExemptions?: readonly unknown[]
  } | undefined
  readonly threshold: number
}): string[]
export function sourceOf(entry: { readonly rewritten?: string; readonly port: string }): string
export function sourcePathsOf(entry: { readonly rewritten?: string; readonly port: string }): string[]
export function findFileResult<T extends {
  readonly port: string
  readonly source?: string
  readonly sourcePaths?: readonly string[]
}>(results: readonly T[], query: string): T | undefined
export function withdrawClaimsForRemovedPorts(
  ports: Iterable<string>,
  ledger: Map<string, unknown>,
  floors: Map<string, unknown>,
): void
export function mayReplaceExistingRewriteRecord(
  previous: { readonly claim?: unknown } | undefined,
  record: { readonly claim?: unknown; readonly refreshReason?: unknown; readonly replaceExemption?: unknown },
): boolean

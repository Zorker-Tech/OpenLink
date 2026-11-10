export interface ConsumerAllowlistDifference {
  readonly added: string[]
  readonly stale: string[]
}

export function compareConsumerAllowlist(
  actual: Iterable<string>,
  allowed: Iterable<string>,
): ConsumerAllowlistDifference

export function importedInteropModules(contents: string): string[]
export function coreInteropConsumers(
  files: Iterable<{ readonly relative: string; readonly contents: string }>,
): string[]

export function declaresPluginMcpInteropSchema(contents: string): boolean
export function declaresExternalPluginManifestDialect(contents: string): boolean
export function importsCounterpartExecutionWire(contents: string): boolean
export function importsExternalProtobufRuntime(contents: string): boolean

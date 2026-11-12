/**
 * Ambient provider credentials are deliberately allow-listed.  The Agent Host
 * process can contain unrelated secrets (database keys, SSH credentials, etc.)
 * and copying the whole process environment into a Project VM would defeat the
 * execution boundary.
 */

import type { AgentProviderRuntimeConfiguration } from './contracts.js'

const AMBIENT_ENVIRONMENT_BY_PROVIDER: Record<string, readonly string[]> = {
  'amazon-bedrock': [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_PROFILE',
    'AWS_ROLE_ARN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  ],
  'google-vertex': [
    'GOOGLE_CLOUD_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
}

const ENVIRONMENT_VALUE_LIMIT = 16 * 1024

/**
 * A custom endpoint has no built-in Pi model catalog. Pass the selected
 * model's metadata to the worker so it can register that exact model instead
 * of resolving it against a catalog entry that does not exist.
 */
export function providerModelEnvironment(
  configuration: AgentProviderRuntimeConfiguration,
): Record<string, string> {
  if (configuration.providerId !== 'custom') return {}
  return {
    OPENLINK_PROVIDER_MODEL_CONFIG: JSON.stringify({
      id: configuration.modelId,
      name: configuration.name ?? configuration.modelId,
      api: configuration.api ?? 'openai-completions',
      reasoning: configuration.reasoning ?? false,
      input: configuration.input ?? ['text'],
      contextWindow: configuration.contextWindow ?? 128_000,
      maxTokens: configuration.maxTokens ?? 8_192,
      cost: configuration.cost ?? { input: 0, output: 0 },
    }),
  }
}

export function ambientProviderEnvironment(
  providerId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of AMBIENT_ENVIRONMENT_BY_PROVIDER[providerId] ?? []) {
    const value = environment[name]
    // Node's child-process environment cannot represent undefined/null and
    // control characters would make diagnostics and shell tooling unsafe.
    if (typeof value !== 'string' || !value || value.length > ENVIRONMENT_VALUE_LIMIT || /[\u0000\r\n]/.test(value)) continue
    result[name] = value
  }
  return result
}

/** Names used by a desktop worker when it needs to explicitly inherit ambient credentials. */
export function ambientProviderEnvironmentNames(providerId: string): readonly string[] {
  return AMBIENT_ENVIRONMENT_BY_PROVIDER[providerId] ?? []
}

/**
 * OpenSandbox and sandbox-runtime need the network target before Pi resolves a
 * model URL. Vertex model catalog URLs contain `{location}`; turn that
 * template into the narrowest supported wildcard instead of allowing a domain
 * that can never match the actual regional endpoint.
 */
export function providerNetworkTargets(providerId: string, baseUrl: string): string[] {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return []
  }

  if (providerId === 'google-vertex' && hostname.includes('{location}')) {
    return ['*.aiplatform.googleapis.com']
  }
  return hostname ? [hostname] : []
}

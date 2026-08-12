/**
 * Ambient provider credentials are deliberately allow-listed.  The Agent Host
 * process can contain unrelated secrets (database keys, SSH credentials, etc.)
 * and copying the whole process environment into a Project VM would defeat the
 * execution boundary.
 */

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

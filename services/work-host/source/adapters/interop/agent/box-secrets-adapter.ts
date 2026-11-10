/** Adapts Slate's secret policy to the box runtime's environment and redaction key. */

import { validateBoxSecretKey, validateBoxSecrets } from "../../../shared/box-secrets.ts"

export const BOX_SECRET_REDACTION_NAMES_ENV_VAR = "CLOUD_AGENT_INJECTED_SECRET_NAMES"

const BOX_RUNTIME_RESERVED_NAMES = new Set([BOX_SECRET_REDACTION_NAMES_ENV_VAR])

export function validateBoxSecretKeyAtInterop(key: string): string | null {
  return validateBoxSecretKey(key, BOX_RUNTIME_RESERVED_NAMES)
}

export function validateBoxSecretsAtInterop(secrets: Readonly<Record<string, string>>): string | null {
  return validateBoxSecrets(secrets, BOX_RUNTIME_RESERVED_NAMES)
}

export function buildBoxSecretsEnv(secrets: Readonly<Record<string, string>>): Record<string, string> {
  const secretNames = Object.keys(secrets).sort()
  if (secretNames.length === 0) return {}

  const environment: Record<string, string> = {}
  for (const name of secretNames) environment[name] = secrets[name] ?? ""
  environment[BOX_SECRET_REDACTION_NAMES_ENV_VAR] = secretNames.join(",")
  return environment
}

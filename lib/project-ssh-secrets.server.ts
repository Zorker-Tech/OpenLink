import 'server-only'

import {
  decryptProviderSecret,
  encryptProviderSecret,
  providerSecretHint,
  type EncryptedProviderSecret,
} from '@/lib/provider-secrets.server'

export interface EncryptedProjectSshPrivateKey extends EncryptedProviderSecret {
  hint: string
}

/**
 * Project SSH keys use the same KMS-compatible AES-256-GCM envelope as
 * provider credentials, but with a project-specific associated-data scope.
 */
export function encryptProjectSshPrivateKey(
  privateKey: string,
  userId: string,
  projectId: string,
): EncryptedProjectSshPrivateKey {
  const encrypted = encryptProviderSecret(privateKey, userId, `project-ssh:${projectId}`)
  return { ...encrypted, hint: providerSecretHint(privateKey) }
}

/**
 * Decryption is intentionally server-only.  The web client receives only the
 * public connection summary and a key hint; Agent Host retrieves this envelope
 * with its service role when it needs to establish a strict SSH transport.
 */
export function decryptProjectSshPrivateKey(
  encrypted: Pick<EncryptedProviderSecret, 'ciphertext' | 'iv' | 'tag' | 'version'>,
  userId: string,
  projectId: string,
) {
  return decryptProviderSecret(encrypted, userId, `project-ssh:${projectId}`)
}

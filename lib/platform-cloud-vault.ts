import type { OAuthTokenSet } from '@vtslx/platform-sdk/auth'

export type CloudConnectionState = 'active' | 'refreshing' | 'reauth_required' | 'revoking' | 'revoked'
export type CloudCredentialEnvelope = { version: 1; keyId: string; ciphertext: string; iv: string; tag: string }
export type CloudRevocationReceipt = { key_id: string; signature: string }
export type CloudConnectionRecord = {
  id: string; user_id: string; issuer: string; subject: string; client_id: string
  revision: number; state: CloudConnectionState; envelope: CloudCredentialEnvelope | null
  lease_until: string | null
}
export type CloudConnectionCommand = (operation: string, connectionId: string | null, payload?: Record<string, unknown>) => Promise<{
  outcome: string; record?: CloudConnectionRecord; lease?: string
  connections?: Array<Pick<CloudConnectionRecord, 'id' | 'issuer' | 'subject' | 'client_id' | 'state'>>
}>
export type CloudCredentialCipher = {
  seal(tokens: OAuthTokenSet, record: CloudConnectionRecord): CloudCredentialEnvelope
  open(envelope: CloudCredentialEnvelope, record: CloudConnectionRecord): OAuthTokenSet
}
export type CloudOAuthVaultOptions = {
  mode: 'local' | 'cloud'; userId: string; connectionId: string; subject: string; clientId: string
  command: CloudConnectionCommand; cipher: CloudCredentialCipher
  signRevocation?: (record: CloudConnectionRecord) => CloudRevocationReceipt | Promise<CloudRevocationReceipt>
  wait?: (milliseconds: number) => Promise<void>
}

/** User-scoped encrypted SDK store and database-fenced refresh coordinator. */
export class CloudOAuthVault {
  private record: CloudConnectionRecord | null = null
  private lease: { token: string; revision: number } | null = null
  private saved = false
  private running = false
  private readonly options: CloudOAuthVaultOptions
  constructor(options: CloudOAuthVaultOptions) {
    this.options = options
    if (options.mode !== 'cloud') throw new Error('Cloud OAuth storage is unavailable in Local mode')
    for (const id of [options.userId, options.connectionId]) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
        throw new Error('Invalid Cloud connection identity')
    }
    if (!options.subject || !options.clientId) throw new Error('Cloud subject/client binding required')
  }
  private accept(record: CloudConnectionRecord | undefined) {
    if (!record || record.id !== this.options.connectionId || record.user_id !== this.options.userId ||
      record.issuer !== 'https://auth.hydite.com' || record.subject !== this.options.subject || record.client_id !== this.options.clientId ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !['active','refreshing','reauth_required','revoking','revoked'].includes(record.state))
      throw new Error('Cloud credential owner or revision mismatch')
    this.record = record
    return record
  }
  private call(operation: string, payload: Record<string, unknown> = {}) {
    return this.options.command(operation, this.options.connectionId, payload)
  }
  async load(): Promise<OAuthTokenSet | null> {
    const result = await this.call('load')
    if (result.outcome === 'missing') return null
    const record = this.accept(result.record)
    if (!['active', 'refreshing'].includes(record.state) || !record.envelope)
      throw new Error('Cloud connection requires reauthentication or revocation recovery')
    return this.options.cipher.open(record.envelope, record)
  }
  async create(tokens: OAuthTokenSet): Promise<void> {
    const record: CloudConnectionRecord = { id: this.options.connectionId, user_id: this.options.userId,
      issuer: 'https://auth.hydite.com', subject: this.options.subject, client_id: this.options.clientId,
      revision: 1, state: 'active', envelope: null, lease_until: null }
    const result = await this.call('create', { issuer: record.issuer, subject: record.subject, client_id: record.client_id,
      envelope: this.options.cipher.seal(tokens, record) })
    if (result.outcome !== 'created') throw new Error('Cloud connection creation failed')
    this.accept(result.record)
  }
  async save(tokens: OAuthTokenSet): Promise<void> {
    if (!this.lease || !this.record || this.saved) throw new Error('Cloud credential save requires its active refresh lease')
    const next = { ...this.record, revision: this.lease.revision + 1 }
    const result = await this.call('commit', { lease: this.lease.token, revision: this.lease.revision,
      envelope: this.options.cipher.seal(tokens, next) })
    if (result.outcome !== 'committed') throw new Error('Cloud refresh commit lost its fence')
    this.accept(result.record)
    this.saved = true
  }
  /** SDK revoke calls clear even on remote failure; keep ciphertext for recovery. */
  async clear(): Promise<void> {
    const result = await this.call('disconnect')
    if (result.outcome === 'missing') return
    if (result.outcome !== 'disconnected') throw new Error('Cloud disconnect failed')
    this.accept(result.record)
  }
  async acknowledgeRevocation(): Promise<void> {
    if (this.record?.state === 'revoked') { this.record = null; return }
    if (!this.record || this.record.state !== 'revoking') throw new Error('Cloud revocation is not pending')
    if (!this.options.signRevocation) throw new Error('A server revocation receipt is required')
    const receipt = await this.options.signRevocation(this.record)
    const result = await this.call('ack_revoke', { revision: this.record.revision, receipt })
    if (result.outcome !== 'revoked') throw new Error('Cloud revocation acknowledgement failed')
    this.record = null
  }
  /** Only for the revocation workflow, after local access has been fenced. */
  async pendingRevocationTokens(): Promise<OAuthTokenSet | null> {
    const result = await this.call('load')
    if (result.outcome === 'missing') return null
    const record = this.accept(result.record)
    if (record.state === 'revoked') return null
    if (record.state !== 'revoking' || !record.envelope) throw new Error('Cloud revocation is not pending')
    return this.options.cipher.open(record.envelope, record)
  }
  async runExclusive(operation: () => Promise<OAuthTokenSet>): Promise<OAuthTokenSet> {
    if (this.running) throw new Error('Cloud refresh coordinator already in use')
    this.running = true
    this.saved = false
    const stopWaitingAt = performance.now() + 10_000
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (performance.now() >= stopWaitingAt) throw new Error('Cloud refresh wait deadline exceeded')
        await this.load()
        if (!this.record) throw new Error('Cloud connection missing')
        const result = await this.call('claim', { revision: this.record.revision })
        if (result.outcome === 'claimed') {
          const record = this.accept(result.record)
          if (!result.lease) throw new Error('Cloud refresh lease is missing')
          this.lease = { token: result.lease, revision: record.revision }
          break
        }
        if (!['busy', 'changed'].includes(result.outcome)) throw new Error('Cloud refresh requires reauthentication')
        if (attempt === 39 || performance.now() >= stopWaitingAt) throw new Error('Cloud refresh is busy; no credential was replayed')
        await (this.options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(250)
      }
      try {
        const result = await operation()
        if (!this.saved) {
          const released = await this.call('release', { lease: this.lease!.token, revision: this.lease!.revision })
          if (released.outcome !== 'released') throw new Error('Cloud refresh release lost its fence')
          this.accept(released.record)
        }
        return result
      } catch {
        if (this.lease && !this.saved) {
          await this.call('fail', { lease: this.lease.token, revision: this.lease.revision }).catch(() => {})
        }
        // A failed fail-marker leaves a refreshing lease, which expires closed.
        throw new Error('Cloud refresh outcome is uncertain; reconnect is required')
      }
    } finally {
      this.lease = null
      this.running = false
    }
  }
}

/** User-authenticated ZOKERBASE client only; never inject a service-role client. */
export function cloudConnectionCommand(client: {
  schema(name: string): { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
}): CloudConnectionCommand {
  return async (operation, connectionId, payload = {}) => {
    const { data, error } = await client.schema('openlink').rpc('cloud_oauth_connection_command', {
      p_operation: operation, p_connection_id: connectionId, p_payload: payload,
    })
    if (error || !data || typeof data !== 'object' || typeof (data as { outcome?: unknown }).outcome !== 'string')
      throw new Error('Cloud credential storage request failed')
    return data as Awaited<ReturnType<CloudConnectionCommand>>
  }
}

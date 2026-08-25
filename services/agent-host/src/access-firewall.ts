/**
 * OpenLink Access Firewall — unified SDK.
 *
 * A mode-based firewall that any MCP server, environment or tool can use to
 * gate operations by a session-selected access mode. Three tiers:
 *
 * - 'restricted' — controlled mode. Operations pass through the firewall:
 *   reads are allowed, writes are denied.
 * - 'ask' — confirmation mode. Reads are allowed; writes return a pending
 *   confirmation that must be approved by the user before execution.
 * - 'open' — full access. Everything is allowed with no restrictions.
 *
 * This module is intentionally dependency-free so any runtime (Agent Host,
 * in-VM controllers, future MCP servers) can adopt the same policy.
 */

export type AccessMode = 'restricted' | 'ask' | 'open'

export const ACCESS_MODES: readonly AccessMode[] = ['restricted', 'ask', 'open']
export const DEFAULT_ACCESS_MODE: AccessMode = 'restricted'

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value)
}

/** Normalizes any external value into a valid mode; unknown values fall back to the safe default. */
export function normalizeAccessMode(value: unknown): AccessMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return isAccessMode(normalized) ? normalized : DEFAULT_ACCESS_MODE
}

export type SqlKind = 'read' | 'write' | 'multi' | 'invalid'

export interface SqlClassification {
  kind: SqlKind
  /** The normalized single statement (trimmed, trailing terminators removed). */
  statement: string
  reason?: string
}

const READ_STATEMENT_START = /^(select|with|explain|show|table)\b/i
const WRITE_KEYWORDS = /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|vacuum|refresh|set|reset|comment|lock|notify|listen|reindex|import|analyze)\b/i
const MAX_SQL_LENGTH = 12_000

/**
 * Classifies a SQL statement for the firewall. Pure and deterministic:
 * - 'read'  — a single statement that starts with a read keyword and contains no write keyword.
 * - 'write' — a single statement that mutates data or structure.
 * - 'multi' — multiple statements separated by interior semicolons.
 * - 'invalid' — empty, oversized, or otherwise unusable input.
 */
export function classifySql(value: string): SqlClassification {
  if (typeof value !== 'string') return { kind: 'invalid', statement: '', reason: 'sql is required' }
  const trimmed = value.trim()
  if (!trimmed) return { kind: 'invalid', statement: '', reason: 'sql is required' }
  if (trimmed.length > MAX_SQL_LENGTH) return { kind: 'invalid', statement: trimmed.slice(0, 200), reason: `sql exceeds the ${MAX_SQL_LENGTH} character limit` }

  const statement = trimmed.replace(/;+\s*$/, '').trim()
  if (!statement) return { kind: 'invalid', statement: '', reason: 'sql is required' }

  const interiorSemicolon = /;/.test(statement)
  const startsWithRead = READ_STATEMENT_START.test(statement)
  const containsWrite = WRITE_KEYWORDS.test(statement)

  if (interiorSemicolon) {
    // Multiple statements: classified by the most dangerous contained statement.
    if (startsWithRead && !containsWrite) return { kind: 'multi', statement, reason: 'multiple read statements' }
    return { kind: 'write', statement }
  }
  if (containsWrite) return { kind: 'write', statement }
  if (startsWithRead) return { kind: 'read', statement }
  // A single statement that is neither clearly read nor write (e.g. `\dt`, DO blocks
  // without keywords) is treated conservatively as a write.
  return { kind: 'write', statement }
}

export type FirewallDecision = 'allow' | 'require-confirmation' | 'deny'

export interface FirewallEvaluation {
  decision: FirewallDecision
  reason: string
}

/**
 * The unified firewall gate. Pure function of the access mode and the
 * operation classification:
 *
 * | mode       | read    | write / multi           | invalid |
 * |------------|---------|-------------------------|---------|
 * | restricted | allow   | deny                    | deny    |
 * | ask        | allow   | require-confirmation    | deny    |
 * | open       | allow   | allow                   | allow   |
 */
export function evaluateFirewall(mode: AccessMode, kind: SqlKind): FirewallEvaluation {
  if (kind === 'invalid') return { decision: 'deny', reason: 'invalid sql statement' }
  if (mode === 'open') return { decision: 'allow', reason: 'open mode allows all operations' }
  if (kind === 'read') return { decision: 'allow', reason: 'read operations are allowed in every mode' }
  if (mode === 'ask') return { decision: 'require-confirmation', reason: 'write operations require user confirmation in ask mode' }
  return { decision: 'deny', reason: 'write operations are denied in restricted mode' }
}

/** Convenience: classify + evaluate in one call. */
export function evaluateSqlFirewall(mode: AccessMode, sql: string): FirewallEvaluation & { classification: SqlClassification } {
  const classification = classifySql(sql)
  const evaluation = evaluateFirewall(mode, classification.kind)
  return { ...evaluation, classification }
}

/** Non-write operations (tables, auth-users, services, …) are allowed in every mode. */
export function evaluateReadOperation(mode: AccessMode): FirewallEvaluation {
  void mode
  return { decision: 'allow', reason: 'read operations are allowed in every mode' }
}

// ---------------------------------------------------------------------------
// Pending write confirmations ('ask' tier).
//
// A write in ask mode never executes on first request. The firewall returns a
// pending confirmation bound to (project, session, sql); execution is only
// possible once that confirmation has been approved, and each approval is
// single-use.
// ---------------------------------------------------------------------------

export interface FirewallConfirmation {
  id: string
  projectId: string
  sessionId: string
  mode: AccessMode
  operation: string
  sql: string
  createdAt: string
  expiresAt: number
}

export interface FirewallConfirmationOptions {
  projectId: string
  sessionId: string
  mode: AccessMode
  operation: string
  sql: string
  ttlMs?: number
  now?: number
}

export function createFirewallConfirmation(options: FirewallConfirmationOptions): FirewallConfirmation {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? 10 * 60 * 1_000
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    projectId: options.projectId,
    sessionId: options.sessionId,
    mode: options.mode,
    operation: options.operation,
    sql: options.sql,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  }
}

export function isFirewallConfirmationLive(confirmation: FirewallConfirmation, now = Date.now()): boolean {
  return confirmation.expiresAt > now
}

export interface FirewallAuditRecord {
  timestamp: string
  projectId: string
  sessionId: string | null
  mode: AccessMode
  operation: string
  sql?: string
  decision: FirewallDecision
  actor: 'agent' | 'internal'
}

export function formatFirewallAuditRecord(record: FirewallAuditRecord): string {
  return JSON.stringify({ ...record, sql: record.sql?.slice(0, 500) })
}

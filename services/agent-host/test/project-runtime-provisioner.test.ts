import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProjectRuntimeProvisioner,
  normalizeProjectRuntimeProvisionerId,
  SupabaseProjectRuntimeProvisioningQueue,
  type ProjectRuntimeProvisioningQueue,
} from '../src/project-runtime-provisioner.js'

const projectId = '2c51ca26-3cd0-4cb4-896d-2061de06098c'

test('queue errors preserve the constraint message but omit private failing-row details', async () => {
  const queue = new SupabaseProjectRuntimeProvisioningQueue({
    url: 'http://localhost:54380', serviceRoleKey: 'test-only',
    fetch: async () => Response.json({ code: '23514', message: 'violates check constraint', details: 'private-lease-row' }, { status: 400 }),
  })
  await assert.rejects(queue.claim('agent-local', 10000), (error: Error) => {
    assert.match(error.message, /23514 violates check constraint/)
    assert.doesNotMatch(error.message, /private-lease-row/)
    return true
  })
})

test('preserves valid provisioner identities and deterministically repairs legacy base64url IDs', () => {
  for (const valid of ['agent-local', 'host.name:1', 'A'.repeat(128)]) {
    assert.equal(normalizeProjectRuntimeProvisionerId(valid), valid)
  }
  for (const invalid of ['-legacy_seed-local', '_seed', 'a'.repeat(129)]) {
    const normalized = normalizeProjectRuntimeProvisionerId(invalid)
    assert.match(normalized, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    assert.equal(normalized, normalizeProjectRuntimeProvisionerId(invalid))
  }
  assert.notEqual(normalizeProjectRuntimeProvisionerId('_seed-local'), normalizeProjectRuntimeProvisionerId('_seed-ssh'))
  assert.throws(() => normalizeProjectRuntimeProvisionerId(' '), /empty/)
})

test('legacy identity is repaired before the actual database claim request', async () => {
  let claimedBy = ''
  const queue = new SupabaseProjectRuntimeProvisioningQueue({
    url: 'http://localhost:54380', serviceRoleKey: 'test-only',
    fetch: async (_url, init) => {
      if (init?.method === 'PATCH') {
        claimedBy = JSON.parse(String(init.body)).provisioning_claimed_by
        assert.match(claimedBy, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
        return Response.json([])
      }
      return Response.json([{ project_id: projectId, provisioning_attempts: 0, disk_mode: 'thin' }])
    },
  })
  const provisioner = new ProjectRuntimeProvisioner({ queue, workerId: '-legacy_seed-local',
    runtimeManager: { ensure: async () => { throw new Error('unclaimed runtime must not start') } },
  })
  assert.equal(await provisioner.runOnce(), false)
  assert.equal(claimedBy, normalizeProjectRuntimeProvisionerId('-legacy_seed-local'))
  await assert.rejects(queue.claim('-legacy_seed', 10000), /invalid/)
})

test('eagerly provisions a claimed Project and completes its lease', async () => {
  const calls: string[] = []
  const queue: ProjectRuntimeProvisioningQueue = {
    claim: async () => ({ projectId, attempt: 1, diskMode: 'thick' }),
    renew: async () => true,
    complete: async (id) => { calls.push(`complete:${id}`) },
    fail: async () => { throw new Error('unexpected failure') },
    terminalFail: async () => { throw new Error('unexpected terminal failure') },
  }
  const provisioner = new ProjectRuntimeProvisioner({
    queue,
    runtimeManager: { ensure: async (id, diskMode) => { calls.push(`ensure:${id}:${diskMode}`); return {} as never } },
  })

  assert.equal(await provisioner.runOnce(), true)
  assert.deepEqual(calls, [`ensure:${projectId}:thick`, `complete:${projectId}`])
})

test('schedules a durable retry when provisioning fails', async () => {
  let retryAt: Date | undefined
  const queue: ProjectRuntimeProvisioningQueue = {
    claim: async () => ({ projectId, attempt: 2, diskMode: 'thin' }),
    renew: async () => true,
    complete: async () => { throw new Error('unexpected completion') },
    fail: async (_id, _worker, value) => { retryAt = value },
    terminalFail: async () => { throw new Error('unexpected terminal failure') },
  }
  const before = Date.now()
  const provisioner = new ProjectRuntimeProvisioner({
    queue,
    runtimeManager: { ensure: async () => { throw new Error('VM failed') } },
    retryBaseMs: 1_000,
    jitterFactor: 0,
  })

  assert.equal(await provisioner.runOnce(), true)
  assert.ok(retryAt)
  assert.ok(retryAt.getTime() >= before + 2_000)
})

test('backs off with jitter but never exceeds the configured ceiling', async () => {
  let retryAt: Date | undefined
  const queue: ProjectRuntimeProvisioningQueue = {
    claim: async () => ({ projectId, attempt: 1, diskMode: 'thin' }),
    renew: async () => true,
    complete: async () => { throw new Error('unexpected completion') },
    fail: async (_id, _worker, value) => { retryAt = value },
    terminalFail: async () => { throw new Error('unexpected terminal failure') },
  }
  const before = Date.now()
  const provisioner = new ProjectRuntimeProvisioner({
    queue,
    runtimeManager: { ensure: async () => { throw new Error('VM failed') } },
    retryBaseMs: 1_000,
    retryMaxMs: 10_000,
    jitterFactor: 1,
  })

  // attempt 1 -> base delay is retryBaseMs (1000ms); jitter factor 1 allows
  // [0, 2000ms]; the final delay must stay a positive-ish step and cap at 10s.
  assert.equal(await provisioner.runOnce(), true)
  assert.ok(retryAt)
  const delay = retryAt.getTime() - before
  assert.ok(delay >= 0, 'backoff must not go backwards in time')
  assert.ok(delay <= 10_000, `backoff must respect the ceiling, got ${delay}`)
  assert.ok(delay <= 2_000, `jitter must stay within the ±factor band, got ${delay}`)

  // A very large attempt count clamps the exponent, so the delay is bounded by
  // the ceiling rather than growing without limit.
  let lateRetry: Date | undefined
  const lateQueue: ProjectRuntimeProvisioningQueue = {
    claim: async () => ({ projectId, attempt: 99, diskMode: 'thin' }),
    renew: async () => true,
    complete: async () => { throw new Error('unexpected completion') },
    fail: async (_id, _worker, value) => { lateRetry = value },
    terminalFail: async () => { throw new Error('unexpected terminal failure') },
  }
  const lateProvisioner = new ProjectRuntimeProvisioner({
    queue: lateQueue,
    runtimeManager: { ensure: async () => { throw new Error('VM failed') } },
    retryBaseMs: 1_000,
    retryMaxMs: 10_000,
    jitterFactor: 0,
    maxAttempts: 200,
  })
  assert.equal(await lateProvisioner.runOnce(), true)
  assert.ok(lateRetry)
  assert.ok(lateRetry.getTime() - Date.now() <= 10_000, 'large attempt count must still respect the ceiling')
})

test('moves to a terminal error once the attempt budget is exhausted', async () => {
  let terminalMessage: string | undefined
  let failCalled = false
  const queue: ProjectRuntimeProvisioningQueue = {
    claim: async () => ({ projectId, attempt: 50, diskMode: 'thin' }),
    renew: async () => true,
    complete: async () => { throw new Error('unexpected completion') },
    fail: async () => { failCalled = true },
    terminalFail: async (_id, _worker, message) => { terminalMessage = message },
  }
  const provisioner = new ProjectRuntimeProvisioner({
    queue,
    runtimeManager: { ensure: async () => { throw new Error('disk did not mount') } },
    maxAttempts: 50,
  })

  assert.equal(await provisioner.runOnce(), true)
  assert.equal(failCalled, false, 'must not schedule another retry after exhaustion')
  assert.equal(terminalMessage, 'disk did not mount')
})

test('claims runtime rows with an atomic conditional PATCH', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const queue = new SupabaseProjectRuntimeProvisioningQueue({
    url: 'https://backend.example.test',
    serviceRoleKey: 'server-secret',
    fetch: async (input, init = {}) => {
      requests.push({ url: String(input), init })
      if (init.method === 'GET') {
        return Response.json([{ project_id: projectId, provisioning_attempts: 0, disk_mode: 'thick' }])
      }
      return Response.json([{ project_id: projectId, provisioning_attempts: 1, disk_mode: 'thick' }])
    },
  })

  assert.deepEqual(await queue.claim('agent-test', 60_000), { projectId, attempt: 1, diskMode: 'thick' })
  assert.equal(requests.length, 2)
  const candidateUrl = new URL(requests[0]?.url ?? '')
  assert.match(candidateUrl.searchParams.get('and') ?? '', /^\(or\(.+\),or\(.+\)\)$/)
  assert.doesNotMatch(candidateUrl.searchParams.get('and') ?? '', /^and\(/)
  assert.match(candidateUrl.searchParams.get('and') ?? '', /provisioning_claimed_by\.eq\.agent-test/)
  assert.equal(requests[1]?.init.method, 'PATCH')
  assert.match(requests[1]?.url ?? '', /provisioning_lease_expires_at/)
  assert.equal((requests[1]?.init.headers as Record<string, string>).Authorization, 'Bearer server-secret')
  assert.equal((requests[1]?.init.headers as Record<string, string>)['Content-Profile'], 'openlink')
  const body = JSON.parse(String(requests[1]?.init.body)) as Record<string, unknown>
  assert.equal(body.status, 'provisioning')
  assert.equal(body.provisioning_claimed_by, 'agent-test')
})

test('rejects an unsafe provisioner identity before composing PostgREST filters', async () => {
  let requested = false
  const queue = new SupabaseProjectRuntimeProvisioningQueue({
    url: 'https://backend.example.test',
    serviceRoleKey: 'server-secret',
    fetch: async () => {
      requested = true
      return Response.json([])
    },
  })

  await assert.rejects(queue.claim('agent,or(status.eq.ready)', 60_000), /worker ID is invalid/)
  assert.equal(requested, false)
})

test('completion clears its claim after runtime readiness changes the coarse status', async () => {
  let request: { url: string; body: Record<string, unknown> } | undefined
  const queue = new SupabaseProjectRuntimeProvisioningQueue({
    url: 'https://backend.example.test',
    serviceRoleKey: 'server-secret',
    fetch: async (input, init = {}) => {
      request = { url: String(input), body: JSON.parse(String(init.body)) as Record<string, unknown> }
      return Response.json([])
    },
  })
  await queue.complete(projectId, 'agent-test')
  assert.match(request?.url ?? '', /provisioning_claimed_by=eq\.agent-test/)
  assert.equal(request?.body.provisioning_claimed_by, null)
  assert.equal(request?.body.provisioning_lease_expires_at, null)
  assert.equal(request?.body.provisioning_phase, 'ready')
  assert.equal(request?.body.status, 'ready')
})

test('terminal failure atomically clears the claim and overrides a stale ready projection', async () => {
  let request: { url: string; body: Record<string, unknown> } | undefined
  const queue = new SupabaseProjectRuntimeProvisioningQueue({
    url: 'https://backend.example.test',
    serviceRoleKey: 'server-secret',
    fetch: async (input, init = {}) => {
      request = { url: String(input), body: JSON.parse(String(init.body)) as Record<string, unknown> }
      return Response.json([])
    },
  })
  await queue.terminalFail(projectId, 'agent-test', 'VM health probe timed out')
  assert.match(request?.url ?? '', /provisioning_claimed_by=eq\.agent-test/)
  assert.equal(request?.body.status, 'error')
  assert.equal(request?.body.provisioning_phase, 'failed')
  assert.equal(request?.body.provisioning_claimed_by, null)
  assert.equal(request?.body.last_error, 'VM health probe timed out')
})

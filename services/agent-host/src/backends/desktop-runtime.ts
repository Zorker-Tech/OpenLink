import { ConnectionConfig, type Sandbox } from '@alibaba-group/opensandbox'
import { AgentHostError } from '../errors.js'
import type { DesktopEndpoint } from '../desktop-gateway.js'

export type DesktopRuntimeState = 'stopped' | 'installing' | 'booting' | 'running' | 'suspended' | 'failed'

export interface DesktopRuntimeStatus {
  state: DesktopRuntimeState
  suspended: boolean
}

export interface DesktopSuspendResult {
  suspended: boolean
  state: DesktopRuntimeState
}

/** Worker-side desktop lifecycle endpoint used for prewarm and idle sleep. */
export async function requestDesktopControl(
  baseUrl: string,
  headers: Record<string, string>,
  action: 'status' | 'suspend' | 'resume',
  timeoutMs = 10_000,
): Promise<DesktopRuntimeStatus & { suspended: boolean }> {
  const response = await fetch(`${baseUrl}/desktop/${action}`, {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => null) as Partial<DesktopRuntimeStatus> | null
  if (!response.ok) {
    throw new AgentHostError(
      'PROVISIONING_FAILED',
      `OpenSandbox desktop ${action} failed (${response.status})`,
      { retryable: true },
    )
  }
  return {
    state: payload?.state ?? 'failed',
    suspended: payload?.suspended === true,
  }
}

async function waitForDesktop(baseUrl: string, headers: Record<string, string> = {}, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/vnc.html`, { headers, signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        await response.body?.cancel()
        return
      }
      lastError = new Error(`noVNC returned HTTP ${response.status}`)
      await response.body?.cancel()
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new AgentHostError(
    'PROVISIONING_FAILED',
    `OpenSandbox desktop did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { retryable: true },
  )
}

/** Lazily start the desktop inside the session sandbox and return its private endpoint. */
export async function ensureDesktopEndpoint(
  sandbox: Sandbox,
  connection: ConnectionConfig,
  workerPort: number,
  workerToken: string,
  workerTokenHeader: string,
  desktopMode: 'ubuntu-container' | 'ubuntu-iso' | 'wayland-rdp',
): Promise<DesktopEndpoint> {
  const endpoint = await sandbox.getEndpoint(6080)
  const url = `${connection.protocol}://${endpoint.endpoint}`
  try {
    await waitForDesktop(url, endpoint.headers ?? {}, 1_500)
  } catch {
    // Start through the worker process. Commands launched through execd run
    // in bubblewrap's minimal /dev namespace, which hides /dev/kvm.
    const worker = await sandbox.getEndpoint(workerPort)
    const response = await fetch(`${connection.protocol}://${worker.endpoint}/desktop/start`, {
      method: 'POST',
      headers: {
        ...(worker.headers ?? {}),
        [workerTokenHeader]: workerToken,
        Authorization: `Bearer ${workerToken}`,
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (response.status === 404 && desktopMode === 'ubuntu-container') {
      // Keep already-running worker images usable during a rolling rebuild.
      const execution = await sandbox.commands.run('bash /opt/openlink/desktop/start.sh', {
        background: true,
        workingDirectory: '/workspace',
      })
      if (!execution.id) throw new AgentHostError('PROVISIONING_FAILED', 'OpenSandbox did not return a desktop process id', { retryable: true })
      await waitForDesktop(url, endpoint.headers ?? {})
      return { url, headers: endpoint.headers ?? {} }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new AgentHostError('PROVISIONING_FAILED', `OpenSandbox desktop process did not start (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`, { retryable: true })
    }
    await response.body?.cancel()
    await waitForDesktop(url, endpoint.headers ?? {})
  }
  return { url, headers: endpoint.headers ?? {} }
}

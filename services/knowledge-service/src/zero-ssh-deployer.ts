import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeError, safeErrorMessage } from './errors.js'

export interface ZeroSshDeploymentInput {
  id: string
  host: string
  port: number
  user: string
  remoteRoot: string
  knownHosts: string
  privateKey: string
  endpoint: string
  chartReference: string
  namespace: string
  releaseName: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function validateEndpoint(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new KnowledgeError('INVALID_BODY', 'Distributed Zero endpoint must be an absolute HTTP(S) origin')
  }
}

function validate(input: ZeroSshDeploymentInput): ZeroSshDeploymentInput {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]-]{0,253}$/.test(input.host) || input.host.startsWith('-')) throw new KnowledgeError('INVALID_BODY', 'SSH host is invalid')
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(input.user)) throw new KnowledgeError('INVALID_BODY', 'SSH user is invalid')
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) throw new KnowledgeError('INVALID_BODY', 'SSH port is invalid')
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(input.remoteRoot) || input.remoteRoot.includes('..')) throw new KnowledgeError('INVALID_BODY', 'SSH remoteRoot is invalid')
  if (!input.knownHosts.trim() || input.knownHosts.length > 1_000_000) throw new KnowledgeError('INVALID_BODY', 'SSH knownHosts is invalid')
  if (!input.privateKey.includes('PRIVATE KEY') || input.privateKey.length > 32_768) throw new KnowledgeError('INVALID_BODY', 'SSH privateKey is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.namespace) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.releaseName)) throw new KnowledgeError('INVALID_BODY', 'Helm release configuration is invalid')
  return { ...input, endpoint: validateEndpoint(input.endpoint), remoteRoot: input.remoteRoot.replace(/\/+$/, '') || '/' }
}

function run(executable: 'ssh' | 'scp', args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_000) })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000) })
    const timeout = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new KnowledgeError('DEPLOYMENT_UNAVAILABLE', `${executable} timed out`, { status: 503, retryable: true })) }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timeout); rejectRun(new KnowledgeError('DEPLOYMENT_UNAVAILABLE', safeErrorMessage(error), { status: 503, retryable: true })) })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolveRun({ stdout, stderr })
      else rejectRun(new KnowledgeError('DEPLOYMENT_UNAVAILABLE', `${executable} failed (${code ?? 'signal'}): ${stderr.slice(-2_000)}`, { status: 503, retryable: true }))
    })
  })
}

export class ZeroSshDeployer {
  async deploy(raw: ZeroSshDeploymentInput): Promise<{ endpoint: string }> {
    const input = validate(raw)
    const directory = await mkdtemp(join(tmpdir(), 'openlink-zero-ssh-'))
    const identity = join(directory, 'id_ed25519')
    const knownHosts = join(directory, 'known_hosts')
    try {
      await writeFile(identity, `${input.privateKey.trim()}\n`, { mode: 0o600 })
      await chmod(identity, 0o600)
      await writeFile(knownHosts, `${input.knownHosts.trim()}\n`, { mode: 0o600 })
      const common = ['-p', String(input.port), '-i', identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=15']
      const target = `${input.user}@${input.host}`
      const remoteRoot = `${input.remoteRoot}/openlink-zero/${input.id}`
      const preflight = `set -eu; command -v kubectl >/dev/null; command -v helm >/dev/null; kubectl cluster-info >/dev/null; mkdir -p ${shellQuote(remoteRoot)}`
      await run('ssh', [...common, target, 'bash', '-lc', preflight])
      const chart = input.chartReference.trim()
      if (!chart) throw new KnowledgeError('INVALID_BODY', 'A pinned local or OCI Helm chart reference is required')
      const install = [
        'set -eu',
        `helm upgrade --install ${shellQuote(input.releaseName)} ${shellQuote(chart)} --namespace ${shellQuote(input.namespace)} --create-namespace --wait --timeout 15m --set cluster.enabled=true --set standalone.enabled=false`,
      ].join('; ')
      await run('ssh', [...common, target, 'bash', '-lc', install], 1_200_000)
      await run('ssh', [...common, target, 'bash', '-lc', `kubectl -n ${shellQuote(input.namespace)} rollout status deployment -l app.kubernetes.io/instance=${shellQuote(input.releaseName)} --timeout=15m`], 1_200_000)
      return { endpoint: input.endpoint }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

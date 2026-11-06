import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, chmod, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CivilizationMemoryServiceConfig } from './project-memory-mcp.js'

export interface EmbeddedCivilizationMemoryService {
  config: CivilizationMemoryServiceConfig
  close(): Promise<void>
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function civilizationSourceRoot(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(moduleDirectory, '../../../civilization'),
    resolve(moduleDirectory, '../../civilization'),
  ]
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, 'src/civilization/engine/stages/stage74_orion_memory_service.py'))
      return candidate
    } catch {
      // Source execution and compiled Agent Host output use different depths.
    }
  }
  throw new Error('Civilization 1.0.0 source is missing from services/civilization')
}

function readyLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolveReady, rejectReady) => {
    if (!child.stdout) {
      rejectReady(new Error('Civilization memory service did not expose startup output'))
      return
    }
    let settled = false
    let timeout: NodeJS.Timeout
    const finish = (error?: Error, url?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      lines.removeAllListeners('line')
      lines.close()
      if (error) rejectReady(error)
      else resolveReady(url!)
    }
    const lines = createInterface({ input: child.stdout })
    timeout = setTimeout(() => finish(new Error('Civilization memory service did not become ready in time')), timeoutMs)
    timeout.unref()

    lines.on('line', (line) => {
      try {
        const payload = JSON.parse(line) as { ready?: unknown; url?: unknown }
        if (payload.ready === true && typeof payload.url === 'string') {
          const url = new URL(payload.url)
          if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port) {
            finish(new Error('Civilization memory service returned an invalid loopback address'))
            return
          }
          finish(undefined, url.origin)
          return
        }
      } catch {
        // Startup output is expected to contain only a readiness JSON line.
      }
    })
    child.once('error', (error) => finish(new Error(`Could not start Civilization memory service: ${error.message}`)))
    child.once('exit', (code, signal) => finish(new Error(`Civilization memory service exited during startup (${signal ?? code ?? 'unknown'})`)))
  })
}

export async function startEmbeddedCivilizationMemoryService(options: { stateRoot: string }): Promise<EmbeddedCivilizationMemoryService> {
  const stateRoot = resolve(options.stateRoot)
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(stateRoot, 0o700)

  const runtimeRoot = await civilizationSourceRoot()
  const launcher = resolve(runtimeRoot, '../agent-host/civilization-host.py')
  await access(launcher)
  const token = randomBytes(32).toString('base64url')
  const python = process.env.PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PYTHONPATH: resolve(runtimeRoot, 'src'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    OPENLINK_CIVILIZATION_INTERNAL_TOKEN: token,
    ...(process.platform === 'win32' ? {
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    } : {}),
  }
  const child = spawn(python, [launcher, '--state-dir', stateRoot], {
    cwd: runtimeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[Civilization memory] ${chunk.toString()}`))

  let baseUrl: string
  try {
    baseUrl = await readyLine(child, 15_000)
  } catch (error) {
    child.kill('SIGTERM')
    await Promise.race([exited, delay(2_000).then(() => child.kill('SIGKILL'))])
    throw error
  }
  console.info('Civilization Project Memory runtime is ready')

  let closing = false
  const stopOnParentExit = () => {
    if (!closing && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  process.once('exit', stopOnParentExit)
  child.once('exit', (code, signal) => {
    if (!closing) console.error(`Civilization memory service exited unexpectedly (${signal ?? code ?? 'unknown'})`)
  })

  return {
    config: { baseUrl, apiToken: token },
    async close() {
      if (closing) return
      closing = true
      process.removeListener('exit', stopOnParentExit)
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await Promise.race([exited, delay(5_000).then(() => child.kill('SIGKILL'))])
    },
  }
}

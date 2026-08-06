import { AgentHostError } from './errors.js'

export interface CommandSpec {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  shell: false
}

export interface PiRpcCommandOptions {
  entrypoint: string
  cwd: string
  sessionDir: string
  sessionId: string
  model?: string
  environment?: Record<string, string>
  entrypointKind?: 'rpc-entry' | 'cli'
  browser?: {
    hostUrl: string
    sessionId: string
    controlToken: string
    extensionPath: string
  }
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function validateSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new AgentHostError('INVALID_SESSION', 'sessionId contains unsafe characters')
  }
  return value
}

function validateModel(value: string): string {
  if (!value || /[\u0000-\u001f]/.test(value) || value.length > 200) {
    throw new AgentHostError('INVALID_SESSION', 'model contains unsafe characters')
  }
  return value
}

function validateRuntimeValue(value: string, label: string): string {
  if (!value || /[\u0000-\u001f]/.test(value) || value.length > 8192) {
    throw new AgentHostError('INVALID_SESSION', `${label} is invalid`)
  }
  return value
}

export function buildPiRpcCommand(options: PiRpcCommandOptions): CommandSpec {
  const sessionId = validateSessionId(options.sessionId)
  const args = options.entrypointKind === 'cli' ? ['--mode', 'rpc'] : []
  args.push('--session-dir', options.sessionDir, '--session-id', sessionId, '--no-approve')
  if (options.model) args.push('--model', validateModel(options.model))
  if (options.browser) args.push('--extension', validateRuntimeValue(options.browser.extensionPath, 'browser extension path'))

  return {
    executable: 'node',
    args: [options.entrypoint, ...args],
    cwd: options.cwd,
    env: {
      ...(options.environment ?? {}),
      AI_AGENT: 'pi',
      PI_CODING_AGENT: 'true',
      ...(options.browser ? {
        OPENLINK_BROWSER_HOST_URL: validateRuntimeValue(options.browser.hostUrl, 'browser host URL'),
        OPENLINK_BROWSER_SESSION_ID: validateSessionId(options.browser.sessionId),
        OPENLINK_BROWSER_CONTROL_TOKEN: validateRuntimeValue(options.browser.controlToken, 'browser control token'),
      } : {}),
    },
    shell: false,
  }
}

export class JsonlFrameDecoder {
  #buffer = ''

  constructor(readonly maxFrameBytes = 1024 * 1024) {}

  push(chunk: string | Uint8Array): unknown[] {
    this.#buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk, { stream: true })
    const events: unknown[] = []
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (new TextEncoder().encode(line).byteLength > this.maxFrameBytes) {
        throw new AgentHostError('FRAME_TOO_LARGE', 'Pi RPC frame exceeds the configured limit')
      }
      if (line.length > 0) {
        try {
          events.push(JSON.parse(line))
        } catch {
          throw new AgentHostError('INVALID_FRAME', 'Pi RPC emitted invalid JSONL')
        }
      }
      newline = this.#buffer.indexOf('\n')
    }
    if (new TextEncoder().encode(this.#buffer).byteLength > this.maxFrameBytes) {
      throw new AgentHostError('FRAME_TOO_LARGE', 'Pi RPC frame exceeds the configured limit')
    }
    return events
  }

  finish(): void {
    if (this.#buffer.length > 0) {
      throw new AgentHostError('INVALID_FRAME', 'Pi RPC stream ended mid-frame')
    }
  }
}

export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

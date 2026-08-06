import type { AgentProcess } from './contracts.js'
import { AgentHostError } from './errors.js'
import { encodeJsonl, JsonlFrameDecoder } from './pi-rpc.js'

type FrameListener = (frame: unknown) => void
type ErrorListener = (error: Error) => void

export class LocalAgentSession {
  private readonly decoder = new JsonlFrameDecoder()
  private readonly frameListeners = new Set<FrameListener>()
  private readonly errorListeners = new Set<ErrorListener>()
  private busy = false
  private disposed = false
  private stderr = ''

  constructor(
    readonly process: AgentProcess,
    private readonly cleanupEnvironment: () => Promise<void>,
  ) {
    void this.consume()
  }

  get isBusy(): boolean {
    return this.busy
  }

  async prompt(message: string, listener: FrameListener, signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new AgentHostError('BACKEND_NOT_CONFIGURED', 'Agent session has stopped')
    if (this.busy) throw new AgentHostError('SESSION_BUSY', 'Agent session is already processing a prompt')
    this.busy = true
    this.frameListeners.add(listener)
    const requestId = crypto.randomUUID()

    await new Promise<void>(async (resolve, reject) => {
      const timeout = setTimeout(() => finish(new AgentHostError('AGENT_TIMEOUT', 'Agent did not settle within 15 minutes')), 15 * 60_000)
      const onAbort = () => finish(new AgentHostError('REQUEST_ABORTED', 'Agent request was aborted'))
      const onError = (error: Error) => finish(error)
      const onFrame = (frame: unknown) => {
        const value = frame && typeof frame === 'object' ? frame as Record<string, unknown> : null
        if (value?.type === 'response' && value.id === requestId && value.success === false) {
          finish(new AgentHostError('PI_PROMPT_FAILED', typeof value.error === 'string' ? value.error : 'Pi rejected the prompt'))
          return
        }
        if (value?.type === 'agent_settled') finish()
      }
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        this.errorListeners.delete(onError)
        this.frameListeners.delete(onFrame)
        this.frameListeners.delete(listener)
        this.busy = false
        if (error) reject(error)
        else resolve()
      }

      this.errorListeners.add(onError)
      this.frameListeners.add(onFrame)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await this.process.send(encodeJsonl({ id: requestId, type: 'prompt', message }))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.allSettled([this.process.stop('session disposed'), this.cleanupEnvironment()])
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.process.events) {
        if (event.type === 'stdout' && event.data) {
          for (const frame of this.decoder.push(event.data)) {
            for (const listener of this.frameListeners) listener(frame)
          }
          continue
        }
        if (event.type === 'stderr' && event.data) {
          this.stderr = `${this.stderr}${event.data}`.slice(-16_384)
          continue
        }
        if (event.type === 'error') throw new Error(event.message || 'Pi RPC process failed')
        if (event.type === 'exit') throw new Error(`Pi RPC process exited with code ${event.code ?? 'unknown'}${this.stderr ? `: ${this.stderr}` : ''}`)
      }
      this.decoder.finish()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      for (const listener of this.errorListeners) listener(failure)
    }
  }
}

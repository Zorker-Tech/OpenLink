import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentEvent, AgentProcess } from './contracts.js'
import type { CommandSpec } from './pi-rpc.js'

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private readonly buffered: AgentEvent[] = []
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = []
  private ended = false

  push(event: AgentEvent): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.buffered.push(event)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const event = this.buffered.shift()
        if (event) return Promise.resolve({ done: false, value: event })
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

export class NodeAgentProcess implements AgentProcess {
  readonly events: AsyncIterable<AgentEvent>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly queue = new AsyncEventQueue()
  private stopped = false

  constructor(readonly command: CommandSpec) {
    this.events = this.queue
    this.child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.queue.push({ type: 'stdout', data: chunk.toString('utf8') }))
    this.child.stderr.on('data', (chunk: Buffer) => this.queue.push({ type: 'stderr', data: chunk.toString('utf8') }))
    this.child.once('error', (error) => {
      this.queue.push({ type: 'error', message: error.message })
      this.queue.end()
    })
    this.child.once('exit', (code) => {
      this.queue.push({ type: 'exit', code })
      this.queue.end()
    })
  }

  async send(data: string): Promise<void> {
    if (this.stopped || !this.child.stdin.writable) throw new Error('Pi RPC process is not writable')
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(data, (error) => error ? reject(error) : resolve())
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }
}

export function spawnNodeAgentProcess(command: CommandSpec): Promise<AgentProcess> {
  return Promise.resolve(new NodeAgentProcess(command))
}

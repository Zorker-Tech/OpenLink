import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { WorkspaceObservation } from './inspiration-observer.js'

const LEASE_MS = 5 * 60_000
const MAX_RETAINED = 64

export class InspirationObserverHost {
  #worker?: Worker
  #lease?: ReturnType<typeof setTimeout>
  #generation = ''
  #sequence = 0
  #ready = false
  #observations: Array<WorkspaceObservation & { sequence: number }> = []

  constructor(readonly workspaceRoot: string, readonly observeNetwork = false) {}

  pull(cursor: string | null) {
    if (!this.#worker) {
      this.#generation = randomUUID()
      this.#sequence = 0
      this.#ready = false
      this.#observations = []
      const worker = new Worker(new URL('./inspiration-observer.js', import.meta.url), {
        workerData: { workspaceRoot: this.workspaceRoot, observeNetwork: this.observeNetwork },
        env: {},
        execArgv: [],
      })
      this.#worker = worker
      worker.unref()
      worker.on('message', (observation: WorkspaceObservation | 'ready') => {
        if (worker !== this.#worker) return
        if (observation === 'ready') { this.#ready = true; return }
        this.#observations.push({ ...observation, sequence: ++this.#sequence })
        if (this.#observations.length > MAX_RETAINED) this.#observations.shift()
      })
      worker.on('error', () => { if (worker === this.#worker) this.stop() })
      worker.on('exit', () => { if (worker === this.#worker) this.stop() })
    }
    clearTimeout(this.#lease)
    this.#lease = setTimeout(() => this.stop(), LEASE_MS)
    this.#lease.unref()
    const prefix = this.#generation + ':'
    const after = cursor?.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : 0
    return {
      cursor: prefix + this.#sequence,
      ready: this.#ready,
      observations: this.#observations.filter(({ sequence }) => sequence > after),
    }
  }

  stop() {
    clearTimeout(this.#lease)
    const worker = this.#worker
    this.#worker = undefined
    if (worker) void worker.terminate().catch(() => undefined)
  }
}

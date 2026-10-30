import { randomUUID } from 'node:crypto'
import { WorkspaceTerminalClient } from '@vtslx/platform-sdk/terminal'

const maxRecordBytes = 64 * 1024 * 1024
const maxInputChunkBytes = 3_900
const recordId = /^[A-Za-z0-9_-]{1,128}$/

function timeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}-timeout`)), timeoutMs)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function utf8Chunks(value) {
  const chunks = []
  let current = ''
  let size = 0
  for (const character of value) {
    const characterSize = Buffer.byteLength(character, 'utf8')
    if (size + characterSize > maxInputChunkBytes && current) {
      chunks.push(current)
      current = ''
      size = 0
    }
    current += character
    size += characterSize
  }
  if (current) chunks.push(current)
  return chunks
}

/**
 * Cloud Computer RPC bridge for Oh My Pi. OMP's JSONL transport resembles Pi,
 * but has its own command catalog and prompt/session completion protocol.
 */
export class CloudOmpAgent {
  static async open(computer, options) {
    const {
      sessionId,
      sessionDir,
      agentDir,
      terminalCheckpoint,
      persistCheckpoint,
      heartbeatIntervalMs = 30_000,
      onHeartbeatError,
    } = options
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9]{11}$/.test(sessionId)
      || sessionDir !== `/workspace/.openlink/omp-sessions/${sessionId}`
      || typeof agentDir !== 'string' || !/^\/workspace\/\.openlink\/agent-config\/[a-f0-9]{64}$/.test(agentDir)) {
      throw new Error('omp-session-binding-invalid')
    }
    const agentRef = { current: null }
    const terminals = new WorkspaceTerminalClient(computer.realtime, {
      persistCheckpoint: async () => {
        if (agentRef.current) await persistCheckpoint(agentRef.current.exportCheckpoint())
      },
    })
    const terminal = terminalCheckpoint
      ? terminals.restore(terminalCheckpoint)
      : await terminals.open({
        cwd: '/workspace',
        cols: 120,
        rows: 40,
        idempotencyKey: `openlink-omp-terminal-${randomUUID()}`,
      })
    const agent = new CloudOmpAgent(computer, terminal, {
      sessionId,
      sessionDir,
      persistCheckpoint,
      onHeartbeatError,
    })
    agentRef.current = agent
    agent.stopHeartbeat = computer.startHeartbeat({ intervalMs: heartbeatIntervalMs, onError: onHeartbeatError })
    agent.startPump()

    try {
      if (!terminalCheckpoint) {
        await terminal.write(`export PI_CODING_AGENT_DIR=${agentDir} OMP_CODING_AGENT_DIR=${agentDir}; mkdir -p /workspace/.openlink/omp-sessions/${sessionId} && stty -echo -icanon -icrnl -opost 2>/dev/null && exec omp --mode rpc --no-ui --cwd /workspace\n`)
        const ready = await timeout(agent.ready, 60_000, 'omp-startup')
        if (Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
          const negotiated = await agent.sendCommand({ type: 'negotiate_protocol', protocolVersion: 2 }, { timeoutMs: 10_000 })
          if (!negotiated.success) throw new Error('omp-protocol-negotiation-failed')
        }
        const opened = await agent.sendCommand({ type: 'open_session', sessionDir }, { timeoutMs: 60_000 })
        if (!opened.success || asObject(opened.data)?.cancelled === true) throw new Error('omp-session-open-failed')
        agent.ompSessionId = typeof opened.data?.sessionId === 'string' ? opened.data.sessionId : null
      } else {
        // A restored terminal is already attached to the running OMP process;
        // the process does not emit another ready frame after host recovery.
        await agent.sendCommand({ type: 'get_state' }, { timeoutMs: 30_000 })
      }

      const state = await agent.getState({ timeoutMs: 30_000 })
      if (typeof state.sessionId === 'string') agent.ompSessionId = state.sessionId
      if (!agent.ompSessionId) throw new Error('omp-session-id-missing')
      agent.settled = state.isSettled !== false
      await persistCheckpoint(agent.exportCheckpoint())
      return agent
    } catch (error) {
      await agent.close().catch(() => undefined)
      throw error
    }
  }

  constructor(computer, terminal, options) {
    this.computer = computer
    this.terminal = terminal
    this.sessionId = options.sessionId
    this.sessionDir = options.sessionDir
    this.persistCheckpoint = options.persistCheckpoint
    this.onHeartbeatError = options.onHeartbeatError
    this.agentSessionId = options.sessionId
    this.ompSessionId = null
    this.listeners = new Set()
    this.pending = new Map()
    this.promptWaiters = new Map()
    this.decoder = new TextDecoder('utf-8', { fatal: true })
    this.outputBuffer = ''
    this.chunkState = null
    this.nextRequestId = 0
    this.writeQueue = Promise.resolve()
    this.closed = false
    this.pumpError = null
    this.pumpPromise = null
    this.settled = true
    this.settledEventSent = false
    this.stopHeartbeat = null
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
  }

  startPump() {
    if (this.pumpPromise) return
    this.pumpPromise = this.pump().catch((error) => {
      this.pumpError = error instanceof Error ? error : new Error('omp-terminal-failed')
      this.rejectReady?.(this.pumpError)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(this.pumpError)
      }
      this.pending.clear()
      for (const waiter of this.promptWaiters.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(this.pumpError)
      }
      this.promptWaiters.clear()
    })
  }

  async pump() {
    while (!this.closed && this.terminal.state === 'running') {
      const result = await this.terminal.poll()
      for (const event of result.events) {
        if (event.type === 'exit') throw new Error(`omp-terminal-exited-${event.exitCode}`)
        this.acceptText(this.decoder.decode(event.data, { stream: true }))
      }
      if (result.state !== 'running') throw new Error('omp-terminal-exited')
      if (!result.events.length && result.cursor === result.latestCursor) {
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
    }
  }

  acceptText(text) {
    this.outputBuffer += text
    if (Buffer.byteLength(this.outputBuffer, 'utf8') > maxRecordBytes + 1) throw new Error('omp-record-too-large')
    let newline = this.outputBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.outputBuffer.slice(0, newline).trim()
      this.outputBuffer = this.outputBuffer.slice(newline + 1)
      if (line) this.acceptLine(line)
      newline = this.outputBuffer.indexOf('\n')
    }
  }

  acceptLine(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // The PTY can contain a one-time shell banner before `exec` replaces it.
      // Ignore non-protocol startup noise; malformed frames after readiness
      // are treated as a broken RPC stream.
      if (!this.resolveReady) throw new Error('omp-invalid-jsonl-frame')
      return
    }
    if (!asObject(frame) || typeof frame.type !== 'string') throw new Error('omp-invalid-frame')
    if (frame.type === 'rpc_chunk') return this.acceptChunk(frame)
    if (this.chunkState) throw new Error('omp-interrupted-rpc-chunk')
    this.acceptFrame(frame)
  }

  acceptChunk(frame) {
    if (typeof frame.chunkId !== 'string' || !recordId.test(frame.chunkId)
      || !Number.isSafeInteger(frame.index) || frame.index < 0
      || !Number.isSafeInteger(frame.count) || frame.count < 1 || frame.count > 16_384
      || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > maxRecordBytes
      || typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
      throw new Error('omp-invalid-rpc-chunk')
    }
    if (!this.chunkState) {
      if (frame.index !== 0) throw new Error('omp-invalid-rpc-chunk-order')
      this.chunkState = { chunkId: frame.chunkId, count: frame.count, byteLength: frame.byteLength, nextIndex: 0, chunks: [], size: 0 }
    }
    const state = this.chunkState
    if (state.chunkId !== frame.chunkId || state.count !== frame.count || state.byteLength !== frame.byteLength
      || state.nextIndex !== frame.index) throw new Error('omp-invalid-rpc-chunk-order')
    const chunk = Buffer.from(frame.data, 'base64')
    if (!chunk.length || chunk.toString('base64') !== frame.data) throw new Error('omp-invalid-rpc-chunk-data')
    state.chunks.push(chunk)
    state.size += chunk.byteLength
    state.nextIndex += 1
    if (state.size > state.byteLength || state.size > maxRecordBytes) throw new Error('omp-rpc-chunk-too-large')
    if (state.nextIndex === state.count) {
      this.chunkState = null
      if (state.size !== state.byteLength) throw new Error('omp-rpc-chunk-length-mismatch')
      const bytes = Buffer.concat(state.chunks, state.size)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      this.acceptFrame(JSON.parse(text))
    }
  }

  acceptFrame(frame) {
    if (frame.type === 'ready') {
      const resolve = this.resolveReady
      this.resolveReady = null
      resolve?.(frame)
    }
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(frame.id)
        pending.resolve(frame)
      }
    }
    if (frame.type === 'agent_start') {
      this.settled = false
      this.settledEventSent = false
    }
    if (frame.type === 'prompt_result' && typeof frame.id === 'string') {
      const waiter = this.promptWaiters.get(frame.id)
      if (waiter) {
        waiter.result = frame
        if (frame.sessionSettled === true || this.settled) {
          this.settled = true
          if (!this.settledEventSent) this.emit({ type: 'agent_settled' })
          this.settledEventSent = true
          this.finishPrompt(frame.id, frame)
        }
      }
    }
    if (frame.type === 'session_settled') {
      this.settled = true
      for (const [id, waiter] of this.promptWaiters) {
        if (waiter.result) this.finishPrompt(id, waiter.result)
      }
      if (!this.settledEventSent) this.emit({ type: 'agent_settled' })
      this.settledEventSent = true
    }
    if (frame.type !== 'ready') this.emit(frame)
  }

  finishPrompt(id, result) {
    const waiter = this.promptWaiters.get(id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.promptWaiters.delete(id)
    waiter.resolve(result)
  }

  emit(record) {
    for (const listener of this.listeners) {
      try { listener(record) } catch {}
    }
  }

  onRecord(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  nextId() {
    this.nextRequestId += 1
    return `openlink-omp-${this.nextRequestId}`
  }

  async writeInput(text) {
    for (const chunk of utf8Chunks(text)) await this.terminal.write(chunk)
  }

  async sendCommand(command, options = {}) {
    if (this.closed || this.pumpError) throw this.pumpError ?? new Error('omp-agent-closed')
    const id = options.id ?? this.nextId()
    const timeoutMs = options.timeoutMs ?? 30_000
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('omp-command-timeout'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
    })
    const encoded = JSON.stringify({ ...command, id })
    if (Buffer.byteLength(encoded, 'utf8') + 1 > maxRecordBytes) {
      const pending = this.pending.get(id)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(id)
      throw new Error('omp-command-too-large')
    }
    const write = this.writeQueue.then(() => this.writeInput(`${encoded}\n`))
    this.writeQueue = write.catch(() => undefined)
    try {
      await write
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(id)
      throw error
    }
    return responsePromise
  }

  async getState(options = {}) {
    const response = await this.sendCommand({ type: 'get_state' }, options)
    if (!response.success || !asObject(response.data)) throw new Error(response.error ?? 'omp-get-state-failed')
    return {
      ...response.data,
      isStreaming: response.data.isStreaming === true || response.data.isSettled === false,
    }
  }

  async getEntries(since, options = {}) {
    const response = await this.sendCommand({ type: 'get_entries', ...(since ? { since } : {}) }, options)
    if (!response.success || !Array.isArray(response.data?.entries)) throw new Error(response.error ?? 'omp-get-entries-failed')
    return { entries: response.data.entries, leafId: typeof response.data.leafId === 'string' ? response.data.leafId : null }
  }

  async getCommands(options = {}) {
    const response = await this.sendCommand({ type: 'get_available_commands' }, options)
    if (!response.success || !Array.isArray(response.data?.commands)) throw new Error(response.error ?? 'omp-get-commands-failed')
    return response.data.commands
  }

  async getAvailableModels(options = {}) {
    const response = await this.sendCommand({ type: 'get_available_models' }, options)
    if (!response.success || !Array.isArray(response.data?.models)) throw new Error(response.error ?? 'omp-get-models-failed')
    return response.data.models
  }

  async setModel(provider, modelId, options = {}) {
    const response = await this.sendCommand({ type: 'set_model', provider, modelId }, options)
    if (!response.success) throw new Error(response.error ?? 'omp-set-model-failed')
    return response.data
  }

  async prompt(message, options = {}) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('omp-prompt-required')
    const id = this.nextId()
    const timeoutMs = options.timeoutMs ?? 300_000
    let resolveCompletion
    let rejectCompletion
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    const timer = setTimeout(() => {
      this.promptWaiters.delete(id)
      rejectCompletion(new Error('omp-prompt-timeout'))
    }, timeoutMs)
    timer.unref?.()
    this.promptWaiters.set(id, { resolve: resolveCompletion, reject: rejectCompletion, timer, result: null })
    this.settled = false
    this.settledEventSent = false
    let accepted
    try {
      accepted = await this.sendCommand({
        type: 'prompt',
        message,
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior === 'steer' ? 'steer' : 'followUp' } : {}),
      }, { id, timeoutMs: 30_000 })
      if (!accepted.success) throw new Error(accepted.error ?? 'omp-prompt-rejected')
      if (accepted.data?.agentInvoked === false) {
        clearTimeout(timer)
        this.promptWaiters.delete(id)
        this.settled = true
        if (!this.settledEventSent) this.emit({ type: 'agent_settled' })
        this.settledEventSent = true
        resolveCompletion({ type: 'agent_settled', handled: true })
      }
    } catch (error) {
      clearTimeout(timer)
      this.promptWaiters.delete(id)
      rejectCompletion(error)
      throw error
    }
    return {
      accepted,
      completion,
      abort: () => this.abort({ timeoutMs }),
    }
  }

  async steer(message, options = {}) {
    return this.sendCommand({ type: 'steer', message }, options)
  }

  async followUp(message, options = {}) {
    return this.sendCommand({ type: 'follow_up', message }, options)
  }

  async abort(options = {}) {
    const response = await this.sendCommand({ type: 'abort' }, options)
    if (!response.success) throw new Error(response.error ?? 'omp-abort-failed')
    return response
  }

  exportCheckpoint() {
    return {
      version: 1,
      agentKind: 'omp',
      computer: this.computer.exportCheckpoint(),
      agentSessionId: this.sessionId,
      ompSessionId: this.ompSessionId,
      sessionDir: this.sessionDir,
      terminal: this.terminal.exportCheckpoint(),
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.stopHeartbeat?.()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('omp-agent-closed'))
    }
    this.pending.clear()
    for (const waiter of this.promptWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('omp-agent-closed'))
    }
    this.promptWaiters.clear()
    try {
      if (this.terminal.state === 'running' && !this.terminal.hasPendingMutation) await this.terminal.close()
    } finally {
      await this.computer.close().catch(() => undefined)
    }
  }
}

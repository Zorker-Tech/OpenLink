import { WriteEpoch } from "./write-epoch.ts"

/** Track whether a field was answered locally and which write the box last confirmed. */
export class HostSettingsFieldSession<Value> {
  readonly #writeEpoch = new WriteEpoch()
  #hasLocalAnswer = false
  #lastValueSent: Value | undefined

  captureReadEpoch(): number { return this.#writeEpoch.snapshot() }
  readWasInterrupted(epoch: number): boolean { return this.#writeEpoch.isStale(epoch) }
  beginWrite(): () => void { return this.#writeEpoch.begin() }
  noteLocalAnswer(): void { this.#hasLocalAnswer = true }
  noteBoxEcho(value: Value): void { this.#lastValueSent = value }
  hasLocalAnswer(): boolean { return this.#hasLocalAnswer }
  lastValueSent(): Value | undefined { return this.#lastValueSent }

  abandon(): void {
    this.#writeEpoch.reset()
    this.#hasLocalAnswer = false
    this.#lastValueSent = undefined
  }
}

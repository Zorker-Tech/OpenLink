import { readHostSettingsSnapshot } from "./host-settings-field-port.ts"
import type { HostSettingsFieldUpdate, HostSettingsMirror, HostSettingsPort } from "./host-settings-field-contracts.ts"
import { HostSettingsFieldSession } from "./host-settings-field-session.ts"

export type { HostSettingsFieldUpdate, HostSettingsMirror, HostSettingsPort } from "./host-settings-field-contracts.ts"

export class BoxSettingsField<
  Settings extends object,
  Field extends keyof Settings,
  Value = Exclude<Settings[Field], null | undefined>,
> {
  readonly #session = new HostSettingsFieldSession<Value>()

  constructor(
    readonly port: HostSettingsPort<Settings>,
    readonly field: Field,
    readonly mirror?: HostSettingsMirror<Value>,
  ) {}

  async reconcile(): Promise<Value | null> {
    if (this.mirror === undefined) return this.#valueIn(await this.port.read())

    const readEpoch = this.#session.captureReadEpoch()
    const snapshot = await readHostSettingsSnapshot(this.port)
    if (snapshot === null || this.#session.readWasInterrupted(readEpoch)) return this.mirror.read() ?? null

    const value = this.#valueIn(snapshot)
    return this.#session.hasLocalAnswer() ? value ?? this.mirror.read() ?? null : value
  }

  async apply(value: Value): Promise<HostSettingsFieldUpdate<Value>> {
    this.mirror?.write(value)
    this.#session.noteLocalAnswer()
    const finishWrite = this.#session.beginWrite()

    try {
      const echoed = await this.port.write({ [this.field]: value } as unknown as Partial<Settings>)
      if (echoed === null) return { status: "unreachable" }
      this.#session.noteBoxEcho(value)
      return { status: "persisted", value: this.#valueIn(echoed) }
    } finally {
      finishWrite()
    }
  }

  async absorbFromBox(): Promise<"none" | "backfilled" | "repainted" | "cleared"> {
    if (this.mirror === undefined) return "none"

    const readEpoch = this.#session.captureReadEpoch()
    const snapshot = await readHostSettingsSnapshot(this.port)
    if (snapshot === null || this.#session.readWasInterrupted(readEpoch)) return "none"

    const valueOnBox = this.#valueIn(snapshot)
    if (valueOnBox === null) return await this.#settleMissingBoxValue()

    const valueHere = this.mirror.read()
    if (valueOnBox === valueHere) return "none"
    this.mirror.write(valueOnBox)
    return valueHere === undefined ? "backfilled" : "repainted"
  }

  abandonInFlight(): void { this.#session.abandon() }

  async #settleMissingBoxValue(): Promise<"none" | "cleared"> {
    const localValue = this.mirror!.read()
    if (!this.#session.hasLocalAnswer()) {
      if (localValue === undefined || this.mirror!.clear === undefined) return "none"
      this.mirror!.clear()
      return "cleared"
    }

    if (localValue !== undefined && localValue !== this.#session.lastValueSent()) await this.apply(localValue)
    return "none"
  }

  #valueIn(settings: Settings): Value | null {
    const value = settings[this.field]
    return value == null ? null : value as unknown as Value
  }
}

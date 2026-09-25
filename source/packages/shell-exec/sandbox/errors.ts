/**
 * The failure of asking for a sandbox that this machine cannot provide.
 *
 * A sandbox is a promise about what a command cannot do, and the platform would rather refuse a command
 * than run it outside the sandbox the caller asked for. So the reason travels with the error: it says what
 * was unsupported, which is what lets a caller decide between a weaker sandbox and no command at all.
 */

export class SandboxUnsupportedError extends Error {
  readonly reason: string | undefined

  constructor(message: string, reason?: string | undefined) {
    super(message)
    this.reason = reason
    this.name = "SandboxUnsupportedError"
  }
}

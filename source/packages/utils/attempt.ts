/**
 * Running something that may throw, without a try/catch at every call site.
 *
 * A result is returned either way, so a caller can decide whether a failure is worth reporting,
 * retrying or ignoring — which is exactly the decision a bare `catch` hides.
 */

export type AttemptResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

export function attemptSync<T>(operation: () => T): AttemptResult<T> {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    return { ok: false, error }
  }
}

/** A synchronous result that retains either the value or the original thrown value. */
export type CapturedResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export function captureSync<T>(work: () => T): CapturedResult<T> {
  try {
    return { ok: true, value: work() };
  } catch (failure) {
    return { ok: false, error: failure };
  }
}

/**
 * The two ways writing an agent's state can end: it was written, or it was not, with the reason.
 */

/** A write that landed, carrying what the writer wants to report back. */
type StateWriteSuccess<T> = { readonly ok: true; readonly detail: T };

/** A write that did not land, carrying the reason the writer gives. */
type StateWriteFailure = { readonly ok: false; readonly reason: string };

/** What a state write answers with: success with its detail, or failure with its reason. */
export type StateWriteResult<T = unknown> = StateWriteSuccess<T> | StateWriteFailure;

/** A successful state write result. */
export const stateWriteOk = <T,>(payload: T): StateWriteSuccess<T> => ({ ok: true, detail: payload });

/** A failed state write result. */
export const stateWriteFailed = (why: string): StateWriteFailure => ({ ok: false, reason: why });

/**
 * Whether a session belongs to the conversation thread it was started in.
 *
 * A session started from a chat thread answers in that thread and is bound to it; one started without a
 * thread, or with a thread kind the platform does not recognize, is not bound to anything and has to be
 * told where its replies go. Only sessions of that family are asked at all — for anything else the
 * question does not arise.
 */

export type ThreadSessionKind = "thread" | "other"

type ThreadBoundSessionProps = {
  readonly isThreadSurface?: boolean | undefined
  readonly sessionKind?: ThreadSessionKind | undefined
}

export function isThreadBoundSession(props: ThreadBoundSessionProps): boolean {
  if (props.isThreadSurface !== true) return false
  return props.sessionKind === undefined || props.sessionKind === "thread"
}

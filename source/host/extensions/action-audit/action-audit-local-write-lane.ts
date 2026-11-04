import { errorLogTag } from "../../../shared/errors/summary.ts";

/** Serialize local append operations and wait for every write already accepted at shutdown. */
export function createActionAuditLocalWriteLane(args: {
  readonly auditPath: (agentId: string) => string;
  readonly append: (path: string, line: string) => Promise<void>;
  readonly report?: (diagnostic: unknown) => void;
}) {
  let tail = Promise.resolve();
  let accepting = true;

  function enqueue(agentId: string, line: string): void {
    if (!accepting || line.length === 0) return;
    tail = tail
      .then(() => args.append(args.auditPath(agentId), line))
      .catch((error) => args.report?.({ extension: "action_audit", errorClass: errorLogTag(error) }));
  }

  async function close(): Promise<void> {
    while (accepting) {
      const currentTail = tail;
      await currentTail;
      if (tail !== currentTail) continue;
      accepting = false;
    }
  }

  return { enqueue, close };
}

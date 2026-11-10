import { writeLocalExecDaemonDiscovery } from "./local-exec-daemon-protocol.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";

export interface LocalExecDaemonIdentity {
  readonly pid: number;
  readonly startedAt: number;
  readonly entryRealpath: string;
  readonly generationToken: string;
}

/** Coalesce concurrent status updates and keep the last in-flight count in the published record. */
export function createLocalExecDaemonDiscoveryPublisher(identity: LocalExecDaemonIdentity, path: string) {
  let inflightCount = 0;
  let writing = false;
  let needsAnotherWrite = false;

  async function publish(): Promise<void> {
    needsAnotherWrite = true;
    if (writing) return;
    writing = true;
    try {
      while (needsAnotherWrite) {
        needsAnotherWrite = false;
        await writeLocalExecDaemonDiscovery({ ...identity, inflightCount }, path).catch((error) => {
          console.error(`[local-exec-daemon] discovery publish failed (previous record stands): ${errorLogTag(error)}`);
        });
      }
    } finally {
      writing = false;
    }
  }

  function updateInflightCount(nextCount: number): void {
    inflightCount = nextCount;
    void publish();
  }

  return { publish, updateInflightCount };
}

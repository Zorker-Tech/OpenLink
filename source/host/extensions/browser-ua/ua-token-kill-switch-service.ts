/**
 * A marker file that says the browser's user-agent token was switched off.
 *
 * Whatever the marker is written for reads it off the filesystem, so the file has to exist exactly when the switch is
 * on: writes are queued so two reconciliations cannot interleave, and a marker that is already in the wanted state is
 * left alone.
 */
import { promises as fs } from "node:fs";

export const UA_TOKEN_DISABLED_MARKER_PATH = "/tmp/slate-ua-token-disabled";

export function createUaTokenKillSwitchReconciler(options: { readonly path?: string; readonly isKillSwitchEnabled: () => boolean; readonly log: (message: string) => void }) {
  const path = options.path ?? UA_TOKEN_DISABLED_MARKER_PATH;
  let lastApplied: boolean | null = null;
  let queue = Promise.resolve();
  const applyOnce = async () => {
    const disabled = options.isKillSwitchEnabled();
    if (disabled === lastApplied) return;
    try {
      if (disabled) await fs.writeFile(path, "1\n", { encoding: "utf8", mode: 0o644 });
      else await fs.rm(path, { force: true });
      lastApplied = disabled;
    } catch (error) { options.log(`ua-token kill-switch marker update failed: ${String(error)}`); }
  };
  return () => { queue = queue.then(applyOnce); return queue; };
}


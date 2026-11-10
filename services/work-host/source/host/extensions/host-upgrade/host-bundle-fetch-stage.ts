import type { FetchStageHostBundleDependencies } from "./host-bundle-upgrade-contracts.ts";

export type { FetchStageHostBundleDependencies } from "./host-bundle-upgrade-contracts.ts";

export async function fetchStageAndReportHostBundle(dependencies: FetchStageHostBundleDependencies): Promise<
  { ok: true } | { ok: false; error: unknown; phase: "fetch" | "stage" }
> {
  let phase: "fetch" | "stage" = "fetch";
  try {
    const bytes = await dependencies.source.loadBundleBytes();
    phase = "stage";
    await dependencies.stage(bytes);
    dependencies.state.stagedVersion = dependencies.source.version;
    dependencies.state.lastFailedVersion = undefined;
    dependencies.log?.("info", `host bundle update (${dependencies.trigger}): staged ${dependencies.source.version}; supervisor swaps when idle`);
    return { ok: true };
  } catch (error) {
    dependencies.log?.("warn", `host bundle update (${dependencies.trigger}): ${phase} failed (box unchanged): ${String(error)}`);
    if (dependencies.state.lastFailedVersion !== dependencies.source.version) {
      dependencies.state.lastFailedVersion = dependencies.source.version;
      dependencies.reportUpgrade({
        outcome: "failed",
        phase,
        mode: "bundle",
        trigger: dependencies.trigger,
        from_version: dependencies.fromVersion ?? undefined,
        to_version: dependencies.source.version,
        error_class: error instanceof Error ? error.constructor.name : "unknown",
      });
    }
    return { ok: false, error, phase };
  }
}

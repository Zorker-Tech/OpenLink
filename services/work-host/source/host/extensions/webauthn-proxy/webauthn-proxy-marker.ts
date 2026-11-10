import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SLATE_WEBAUTHN_PROXY_MARKER_PATH = "/home/box/.slate-webauthn-proxy-enabled";
export const BOX_CHROME_POLICY_COMMAND = "/usr/local/bin/box-chrome-policy";

type MarkerTransition = "not-a-box" | "unchanged" | "applied";

function boxFilesystemExists(markerPath: string): boolean {
  return existsSync(dirname(markerPath));
}

function markerHasState(markerPath: string, enabled: boolean): boolean {
  return existsSync(markerPath) === enabled;
}

function applyMarkerState(markerPath: string, enabled: boolean): void {
  if (enabled) {
    writeFileSync(markerPath, "", { encoding: "utf8", mode: 0o644 });
    return;
  }
  unlinkSync(markerPath);
}

function refreshBrowserPolicy(policyCommand: string): void {
  if (!existsSync(policyCommand)) return;
  spawnSync(policyCommand, [], { stdio: "ignore" });
}

export function applyWebAuthnProxyMarker(
  enabled: boolean,
  markerPath = SLATE_WEBAUTHN_PROXY_MARKER_PATH,
  policyCommand = BOX_CHROME_POLICY_COMMAND,
): MarkerTransition {
  if (!boxFilesystemExists(markerPath)) return "not-a-box";
  if (markerHasState(markerPath, enabled)) return "unchanged";

  applyMarkerState(markerPath, enabled);
  refreshBrowserPolicy(policyCommand);
  return "applied";
}

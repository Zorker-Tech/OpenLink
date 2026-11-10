import path from "node:path";
import type { ShellPathResolutionPorts } from "./platform-shell-contracts.ts";

export function resolveBashExecutable(
  ports: ShellPathResolutionPorts,
  terminalHint?: string,
): string | null {
  if (ports.platform === "win32") {
    const gitBash = /git.*bash/i;
    if (terminalHint && gitBash.test(terminalHint)) return terminalHint;
    const located = ports.findExecutable("bash", gitBash);
    return gitBash.test(located) ? located : null;
  }
  if (ports.shell?.includes("bash")) return ports.shell;
  return ports.findExecutable("bash");
}

export function toGitShellPath(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return value;
  const normalized = path.win32.normalize(value);
  const drive = normalized[0]?.toLowerCase();
  if (drive && normalized[1] === ":" && normalized[2] === "\\") {
    return `/${drive}${normalized.slice(2).replace(/\\/g, "/")}`;
  }
  return normalized.replace(/\\/g, "/");
}

export function resolvePowerShellExecutable(ports: ShellPathResolutionPorts): string {
  if (ports.platform !== "win32") {
    if (ports.shell?.includes("pwsh") || ports.shell?.includes("powershell")) return ports.shell;
  }

  const modern = ports.findExecutable("pwsh");
  if (modern !== "pwsh") return modern;
  const compatibility = ports.findExecutable("powershell");
  if (compatibility !== "powershell") return compatibility;

  if (ports.platform === "win32") {
    const builtIn = ports.join(
      ports.systemRoot as string,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (ports.exists(builtIn)) return builtIn;
  }

  throw new Error("Neither 'pwsh' (PowerShell Core) nor 'powershell' (Windows PowerShell) found in PATH");
}

export function resolveZshExecutable(ports: ShellPathResolutionPorts): string {
  if (ports.shell?.includes("zsh")) return ports.shell;
  return ports.findExecutable("zsh");
}

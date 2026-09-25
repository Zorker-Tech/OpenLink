/**
 * Telling a network failure from a sandbox one, so a retry knows whether it can help.
 *
 * A command that fails because the network is down is worth running again; one that failed because the
 * sandbox refused it is not, and retrying it only wastes the turn. The command's own name is the first
 * signal — a package install or a fetch is a network command whatever its output says — and the output is
 * the second, since a network failure names itself in a handful of recognizable ways.
 *
 * A permission failure is called a sandbox failure even though the message does not say so: in this
 * platform, a command the environment refused is a command the sandbox refused.
 */

export const NETWORK_COMMANDS = [
  "curl", "wget", "ping", "nslookup", "dig", "host", "traceroute", "telnet", "nc", "netcat", "ifconfig",
  "ip", "iwconfig", "iwlist", "arp", "route", "iptables", "ufw", "firewall-cmd", "ss", "netstat", "lsof",
  "tcpdump", "wireshark", "tshark", "nmap", "masscan", "zmap", "ssh", "scp", "rsync", "git", "pip", "apt",
  "yum", "brew", "docker", "kubectl", "aws", "gcloud", "az", "terraform", "ansible", "mvn", "gradle",
  "composer", "cargo", "go", "nuget", "gem", "bundle", "npm install", "yarn install", "pnpm install",
  "pip install", "apt install", "yum install", "brew install", "docker pull", "docker push", "git clone",
  "git pull", "git push", "git fetch",
] as const

export function isNetworkCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  return NETWORK_COMMANDS.some(networkCommand => normalized.startsWith(networkCommand.toLowerCase()))
}

const NETWORK_FAILURE_PATTERN =
  /connection refused|network is unreachable|no route to host|timeout|could not resolve host|name or service not known|temporary failure in name resolution|connection timed out|connection reset by peer|host unreachable/i
const SANDBOX_FAILURE_PATTERN = /operation not permitted|EPERM|EACCES/i

export function analyzeFailure(
  exitCode: number | null | undefined,
  stderr: string | undefined,
  command?: string,
): "network" | "sandbox" | "unknown" {
  const output = stderr || ""
  if (command && isNetworkCommand(command)) return "network"
  if (NETWORK_FAILURE_PATTERN.test(output)) return "network"
  return (exitCode ?? -1) !== 0 && SANDBOX_FAILURE_PATTERN.test(output) ? "sandbox" : "unknown"
}

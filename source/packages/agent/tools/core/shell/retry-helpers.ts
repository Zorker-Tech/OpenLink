/** Classifies command failures so callers can retry only when another attempt may help. */

const NETWORK_TOOLS = [
  "curl", "wget", "ping", "nslookup", "dig", "host", "traceroute", "telnet", "nc", "netcat", "ifconfig",
  "ip", "iwconfig", "iwlist", "arp", "route", "iptables", "ufw", "firewall-cmd", "ss", "netstat", "lsof",
  "tcpdump", "wireshark", "tshark", "nmap", "masscan", "zmap", "ssh", "scp", "rsync", "git", "pip", "apt",
  "yum", "brew", "docker", "kubectl", "aws", "gcloud", "az", "terraform", "ansible", "mvn", "gradle",
  "composer", "cargo", "go", "nuget", "gem", "bundle",
] as const

const NETWORK_ACTIONS = [
  ["npm", "install"], ["yarn", "install"], ["pnpm", "install"], ["pip", "install"],
  ["apt", "install"], ["yum", "install"], ["brew", "install"], ["docker", "pull"],
  ["docker", "push"], ["git", "clone"], ["git", "pull"], ["git", "push"], ["git", "fetch"],
] as const

export const NETWORK_COMMANDS = [
  ...NETWORK_TOOLS,
  ...NETWORK_ACTIONS.map(([program, action]) => `${program} ${action}`),
] as const

export function isNetworkCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  return NETWORK_COMMANDS.some(prefix => normalized.startsWith(prefix))
}

const NETWORK_FAILURES = [
  /connection refused/i,
  /network is unreachable/i,
  /no route to host/i,
  /timeout/i,
  /could not resolve host/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  /connection timed out/i,
  /connection reset by peer/i,
  /host unreachable/i,
] as const

const SANDBOX_FAILURES = [/operation not permitted/i, /EPERM/i, /EACCES/i] as const

function containsAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some(pattern => pattern.test(value))
}

export function analyzeFailure(
  exitCode: number | null | undefined,
  stderr: string | undefined,
  command?: string,
): "network" | "sandbox" | "unknown" {
  const output = stderr || ""
  if (command !== undefined && isNetworkCommand(command)) return "network"
  if (containsAny(NETWORK_FAILURES, output)) return "network"
  if ((exitCode ?? -1) !== 0 && containsAny(SANDBOX_FAILURES, output)) return "sandbox"
  return "unknown"
}

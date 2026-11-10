import { isIP } from "node:net"

interface Ipv4Network {
  readonly value: number
  readonly prefix: number
}

const LOOPBACK: Ipv4Network = { value: 0x7f000000, prefix: 8 }
const PRIVATE_NETWORKS: readonly Ipv4Network[] = [
  { value: 0x0a000000, prefix: 8 },
  { value: 0xac100000, prefix: 12 },
  { value: 0xc0a80000, prefix: 16 },
  { value: 0xa9fe0000, prefix: 16 },
]

function ipv4Integer(address: string): number {
  return address.split(".").reduce((total, piece) => ((total << 8) | Number(piece)) >>> 0, 0)
}

function ipv4IsInside(address: number, network: Ipv4Network): boolean {
  const mask = (0xffffffff << (32 - network.prefix)) >>> 0
  return (address & mask) >>> 0 === network.value
}

function isLoopbackIpv4(address: string): boolean {
  return ipv4IsInside(ipv4Integer(address), LOOPBACK)
}

function isPrivateIpv4(address: string): boolean {
  if (address === "0.0.0.0") return true
  const number = ipv4Integer(address)
  return ipv4IsInside(number, LOOPBACK) || PRIVATE_NETWORKS.some(network => ipv4IsInside(number, network))
}

function mappedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase()
  if (!lower.startsWith("::ffff:")) return undefined
  const payload = lower.slice(7)
  if (isIP(payload) === 4) return payload

  const groups = payload.split(":")
  if (groups.length !== 2 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return undefined
  const upper = Number.parseInt(groups[0]!, 16)
  const lowerWord = Number.parseInt(groups[1]!, 16)
  return [
    upper >> 8,
    upper & 255,
    lowerWord >> 8,
    lowerWord & 255,
  ].join(".")
}

function isLoopbackIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === "::1") return true
  const mapped = mappedIpv4(lower)
  return mapped !== undefined && isLoopbackIpv4(mapped)
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === "::" || lower === "::1") return true
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true

  const firstGroup = lower.split(":")[0] ?? ""
  if (/^fe[89ab]/.test(firstGroup)) return true

  const mapped = mappedIpv4(lower)
  return mapped !== undefined && isPrivateIpv4(mapped)
}

export function isLoopbackIpHost(host: string): boolean {
  const version = isIP(host)
  if (version === 4) return isLoopbackIpv4(host)
  return version === 6 ? isLoopbackIpv6(host) : false
}

export function isPrivateIpHost(host: string): boolean {
  const version = isIP(host)
  if (version === 4) return isPrivateIpv4(host)
  return version === 6 ? isPrivateIpv6(host) : false
}

/**
 * Whether a host is the local machine or a private network.
 *
 * Used to decide whether an address an agent wants to reach is one it can be allowed to reach at all:
 * loopback and private ranges are the machine and the network the user is on, and a request to them is
 * not the same kind of thing as a request to the internet. IPv6 is handled too, including
 * IPv4-mapped addresses, which are the usual way a v4 address arrives over a v6 socket.
 */

import { isIP } from "node:net"

function isLoopbackIpv4(ip: string): boolean {
  return ip.startsWith("127.")
}

function isPrivateIpv4(ip: string): boolean {
  if (ip === "0.0.0.0") return true
  if (isLoopbackIpv4(ip)) return true
  const parts = ip.split(".")
  if (parts.length !== 4) return false
  const numbers = parts.map(part => Number(part))
  if (numbers.some(number => !Number.isInteger(number) || number < 0 || number > 255)) return false
  const first = numbers[0] as number
  const second = numbers[1] as number
  if (first === 10) return true
  if (first === 192 && second === 168) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 169 && second === 254) return true
  return false
}

/** `::ffff:127.0.0.1` and `::ffff:7f00:1` both mean 127.0.0.1. */
function extractIpv4FromMappedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase()
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return dotted[1] as string
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = Number.parseInt(hex[1] as string, 16)
    const low = Number.parseInt(hex[2] as string, 16)
    return `${high >> 8 & 255}.${high & 255}.${low >> 8 & 255}.${low & 255}`
  }
  return null
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === "::1" || lower === "::") return true
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true
  if (lower.startsWith("fe80")) return true
  const mapped = extractIpv4FromMappedIpv6(lower)
  return mapped !== null ? isPrivateIpv4(mapped) : false
}

export function isLoopbackIpHost(host: string): boolean {
  const hostname = host.toLowerCase()
  const version = isIP(hostname)
  if (version === 4) return isLoopbackIpv4(hostname)
  if (version === 6) {
    if (hostname === "::1") return true
    const mapped = extractIpv4FromMappedIpv6(hostname)
    return mapped !== null ? isLoopbackIpv4(mapped) : false
  }
  return false
}

export function isPrivateIpHost(host: string): boolean {
  const hostname = host.toLowerCase()
  const version = isIP(hostname)
  if (version === 4) return isPrivateIpv4(hostname)
  if (version === 6) return isPrivateIpv6(hostname)
  return false
}

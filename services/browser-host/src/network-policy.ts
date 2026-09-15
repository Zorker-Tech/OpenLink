import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { BrowserHostError } from './errors.js'

export interface BrowserNetworkPolicy {
  allowedDomains: string[]
  deniedDomains: string[]
  allowLoopback: boolean
  allowPrivateNetworks: boolean
}

type HostLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>

function matchDomain(hostname: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase().replace(/\.$/, '')
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(1)
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  return hostname === normalized
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 192 && octets[1] === 0)
    || (octets[0] === 192 && octets[1] === 0 && octets[2] === 2)
    || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19))
    || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
    || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
    || octets[0] === 0
    || octets[0] >= 224
}

function isSyntheticDnsIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  return octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 198
    && (octets[1] === 18 || octets[1] === 19)
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  const hextets = parseIpv6(normalized)
  if (!hextets) return true
  const first = hextets[0]!
  const unspecified = hextets.every((part) => part === 0)
  const loopback = hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1
  const mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff
  const ipv4Compatible = hextets.slice(0, 6).every((part) => part === 0)
  return mapped
    ? isPrivateIpv4([
        (hextets[6]! >>> 8) & 0xff,
        hextets[6]! & 0xff,
        (hextets[7]! >>> 8) & 0xff,
        hextets[7]! & 0xff,
      ].join('.'))
    : unspecified || loopback || ipv4Compatible
      || (first & 0xfe00) === 0xfc00
      || (first & 0xffc0) === 0xfe80
      || (first & 0xff00) === 0xff00
      || (first === 0x2001 && hextets[1] === 0x0db8)
}

function isLoopbackAddress(address: string): boolean {
  if (address.startsWith('127.')) return true
  const hextets = parseIpv6(address.toLowerCase().split('%')[0])
  if (!hextets) return false
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1) return true
  return hextets.slice(0, 5).every((part) => part === 0)
    && hextets[5] === 0xffff
    && ((hextets[6]! >>> 8) & 0xff) === 127
}

function parseIpv6(value: string): number[] | null {
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    if (lastColon < 0) return null
    const parts = value.slice(lastColon + 1).split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    value = `${value.slice(0, lastColon)}:${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  if (halves.length === 1 && left.length !== 8) return null
  if (halves.length === 2 && left.length + right.length >= 8) return null
  const missing = 8 - left.length - right.length
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ]
}

export class BrowserNetworkGuard {
  private readonly cache = new Map<string, { expiresAt: number; addresses: string[] }>()

  constructor(
    private readonly policy: BrowserNetworkPolicy,
    private readonly now: () => number = Date.now,
    private readonly lookupHost: HostLookup = lookup,
  ) {}

  async assertUrl(raw: string): Promise<URL> {
    return (await this.resolveUrl(raw)).url
  }

  async resolveUrl(raw: string): Promise<{ url: URL; addresses: string[] }> {
    const url = new URL(raw)
    if (['about:', 'data:', 'blob:'].includes(url.protocol)) return { url, addresses: [] }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      throw new BrowserHostError('NETWORK_SCHEME_DENIED', `Browser URL scheme is not allowed: ${url.protocol}`, 403)
    }
    // Node's URL parser keeps brackets on IPv6 literals in `hostname`.
    // Remove them before IP classification; otherwise a literal such as
    // [::ffff:127.0.0.1] is treated as a DNS name and can bypass the SSRF
    // policy (or simply fail with a misleading DNS error).
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (this.policy.deniedDomains.some((pattern) => matchDomain(hostname, pattern))) {
      throw new BrowserHostError('NETWORK_DOMAIN_DENIED', `Browser domain is denied: ${hostname}`, 403)
    }
    if (this.policy.allowedDomains.length > 0 && !this.policy.allowedDomains.some((pattern) => matchDomain(hostname, pattern))) {
      throw new BrowserHostError('NETWORK_DOMAIN_NOT_ALLOWED', `Browser domain is not allowlisted: ${hostname}`, 403)
    }

    const addresses = await this.resolve(hostname)
    const hostnameIsIpLiteral = isIP(hostname) !== 0
    for (const address of addresses) {
      if (isLoopbackAddress(address)) {
        if (!this.policy.allowLoopback) throw new BrowserHostError('NETWORK_LOOPBACK_DENIED', `Loopback access is denied: ${hostname}`, 403)
        continue
      }
      const privateAddress = isIP(address) === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address)
      // Clash/sing-box style fake-IP DNS intentionally maps public domain
      // names into RFC 2544's 198.18.0.0/15 range and routes those addresses
      // through the host proxy. That range is not a reachable RFC1918 target.
      // Permit it only as a resolver result for an already policy-checked DNS
      // name; an explicit 198.18.x.x URL remains denied.
      const syntheticDnsAddress = !hostnameIsIpLiteral && isSyntheticDnsIpv4(address)
      if (privateAddress && !syntheticDnsAddress && !this.policy.allowPrivateNetworks) {
        throw new BrowserHostError('NETWORK_PRIVATE_ADDRESS_DENIED', `Private network access is denied: ${hostname}`, 403)
      }
    }
    return { url, addresses }
  }

  private async resolve(hostname: string): Promise<string[]> {
    if (isIP(hostname)) return [hostname]
    const cached = this.cache.get(hostname)
    if (cached && cached.expiresAt > this.now()) return cached.addresses
    let results: Array<{ address: string; family: number }>
    try {
      results = await this.lookupHost(hostname, { all: true, verbatim: true })
    } catch (error) {
      throw new BrowserHostError('NETWORK_DNS_FAILED', `DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`, 502, true)
    }
    const addresses = [...new Set(results.map((result) => result.address))]
    if (addresses.length === 0) throw new BrowserHostError('NETWORK_DNS_EMPTY', `DNS returned no addresses for ${hostname}`, 502, true)
    this.cache.set(hostname, { expiresAt: this.now() + 60_000, addresses })
    return addresses
  }
}

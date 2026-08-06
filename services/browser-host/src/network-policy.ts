import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { BrowserHostError } from './errors.js'

export interface BrowserNetworkPolicy {
  allowedDomains: string[]
  deniedDomains: string[]
  allowLoopback: boolean
  allowPrivateNetworks: boolean
}

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

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped) return isPrivateIpv4(mapped[1])
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
    || normalized.startsWith('ff') || normalized.startsWith('2001:db8:')
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.')
}

export class BrowserNetworkGuard {
  private readonly cache = new Map<string, { expiresAt: number; addresses: string[] }>()

  constructor(private readonly policy: BrowserNetworkPolicy, private readonly now: () => number = Date.now) {}

  async assertUrl(raw: string): Promise<URL> {
    return (await this.resolveUrl(raw)).url
  }

  async resolveUrl(raw: string): Promise<{ url: URL; addresses: string[] }> {
    const url = new URL(raw)
    if (['about:', 'data:', 'blob:'].includes(url.protocol)) return { url, addresses: [] }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      throw new BrowserHostError('NETWORK_SCHEME_DENIED', `Browser URL scheme is not allowed: ${url.protocol}`, 403)
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (this.policy.deniedDomains.some((pattern) => matchDomain(hostname, pattern))) {
      throw new BrowserHostError('NETWORK_DOMAIN_DENIED', `Browser domain is denied: ${hostname}`, 403)
    }
    if (this.policy.allowedDomains.length > 0 && !this.policy.allowedDomains.some((pattern) => matchDomain(hostname, pattern))) {
      throw new BrowserHostError('NETWORK_DOMAIN_NOT_ALLOWED', `Browser domain is not allowlisted: ${hostname}`, 403)
    }

    const addresses = await this.resolve(hostname)
    for (const address of addresses) {
      if (isLoopbackAddress(address)) {
        if (!this.policy.allowLoopback) throw new BrowserHostError('NETWORK_LOOPBACK_DENIED', `Loopback access is denied: ${hostname}`, 403)
        continue
      }
      const privateAddress = isIP(address) === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address)
      if (privateAddress && !this.policy.allowPrivateNetworks) {
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
      results = await lookup(hostname, { all: true, verbatim: true })
    } catch (error) {
      throw new BrowserHostError('NETWORK_DNS_FAILED', `DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`, 502, true)
    }
    const addresses = [...new Set(results.map((result) => result.address))]
    if (addresses.length === 0) throw new BrowserHostError('NETWORK_DNS_EMPTY', `DNS returned no addresses for ${hostname}`, 502, true)
    this.cache.set(hostname, { expiresAt: this.now() + 60_000, addresses })
    return addresses
  }
}

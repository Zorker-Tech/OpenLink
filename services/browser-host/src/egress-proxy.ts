import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { BrowserNetworkGuard } from './network-policy.js'
import { BrowserHostError } from './errors.js'

const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function cleanHeaders(headers: IncomingMessage['headers']): IncomingMessage['headers'] {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())))
}

function writeProxyError(response: ServerResponse, error: unknown): void {
  const status = error instanceof BrowserHostError ? error.status : 502
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
  response.end(error instanceof Error ? error.message : 'Browser egress proxy failed')
}

export class BrowserEgressProxy {
  private readonly server: Server
  private _port?: number

  constructor(private readonly guard: BrowserNetworkGuard) {
    this.server = createServer((request, response) => void this.handleHttp(request, response))
    this.server.on('connect', (request, socket, head) => void this.handleConnect(request, socket as Socket, head))
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.server.on('connection', (socket) => socket.on('error', () => undefined))
  }

  get url(): string {
    if (!this._port) throw new BrowserHostError('EGRESS_PROXY_NOT_READY', 'Browser egress proxy is not ready')
    return `http://127.0.0.1:${this._port}`
  }

  async start(): Promise<void> {
    if (this._port) return
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (!address || typeof address === 'string') return reject(new BrowserHostError('EGRESS_PROXY_FAILED', 'Could not allocate egress proxy port'))
        this._port = address.port
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    if (!this._port) return
    this._port = undefined
    this.server.closeIdleConnections()
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!request.url) throw new BrowserHostError('EGRESS_URL_INVALID', 'Proxy request URL is missing', 400)
      const { url, addresses } = await this.guard.resolveUrl(request.url)
      if (url.protocol !== 'http:' || addresses.length === 0) throw new BrowserHostError('EGRESS_SCHEME_INVALID', 'Forward proxy accepts absolute HTTP URLs', 400)
      const upstream = httpRequest({
        hostname: addresses[0],
        port: url.port || 80,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...cleanHeaders(request.headers), host: url.host },
        timeout: 30_000,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, cleanHeaders(upstreamResponse.headers))
        upstreamResponse.pipe(response)
      })
      upstream.once('timeout', () => upstream.destroy(new BrowserHostError('EGRESS_TIMEOUT', 'Browser request timed out', 504, true)))
      upstream.once('error', (error) => { if (!response.headersSent) writeProxyError(response, error); else response.destroy(error) })
      request.once('aborted', () => upstream.destroy())
      request.once('error', () => upstream.destroy())
      response.once('error', () => upstream.destroy())
      request.pipe(upstream)
    } catch (error) {
      writeProxyError(response, error)
    }
  }

  private async handleConnect(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    try {
      const authority = request.url || ''
      const separator = authority.lastIndexOf(':')
      if (separator <= 0) throw new BrowserHostError('EGRESS_CONNECT_INVALID', 'CONNECT authority is invalid', 400)
      const rawHost = authority.slice(0, separator)
      const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
      const port = Number(authority.slice(separator + 1))
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BrowserHostError('EGRESS_CONNECT_INVALID', 'CONNECT port is invalid', 400)
      const hostnameForUrl = host.includes(':') ? `[${host}]` : host
      const { addresses } = await this.guard.resolveUrl(`https://${hostnameForUrl}:${port}/`)
      const upstream = connect({ host: addresses[0], port })
      client.on('error', () => upstream.destroy())
      upstream.setTimeout(30_000)
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: OpenLink-Browser-Host\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.once('timeout', () => upstream.destroy(new BrowserHostError('EGRESS_TIMEOUT', 'Browser tunnel timed out', 504, true)))
      upstream.once('error', () => client.destroy())
    } catch (error) {
      const status = error instanceof BrowserHostError ? error.status : 502
      client.end(`HTTP/1.1 ${status} Connection Denied\r\nConnection: close\r\n\r\n`)
    }
  }
}

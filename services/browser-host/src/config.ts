import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { BrowserHostError } from './errors.js'

export interface BrowserHostConfig {
  host: string
  port: number
  publicBaseUrl: string
  apiToken: string
  tokenSecret: string
  allowedParentOrigins: string[]
  storageRoot: string
  chromeExecutable?: string
  maxSessions: number
  sessionTtlMs: number
  controlLeaseTtlMs: number
  shutdownTimeoutMs: number
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new BrowserHostError('INVALID_CONFIG', `${key} is required`)
  return value
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BrowserHostError('INVALID_CONFIG', `${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function parseOrigins(value: string): string[] {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean)
  if (origins.length === 0) throw new BrowserHostError('INVALID_CONFIG', 'OPENLINK_BROWSER_ALLOWED_ORIGINS cannot be empty')
  for (const origin of origins) {
    const url = new URL(origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new BrowserHostError('INVALID_CONFIG', `Invalid parent origin: ${origin}`)
    }
  }
  return origins
}

export function loadBrowserHostConfig(env: NodeJS.ProcessEnv = process.env): BrowserHostConfig {
  const apiToken = required(env, 'OPENLINK_BROWSER_API_TOKEN')
  const tokenSecret = required(env, 'OPENLINK_BROWSER_TOKEN_SECRET')
  if (apiToken.length < 32 || tokenSecret.length < 32) {
    throw new BrowserHostError('INVALID_CONFIG', 'Browser API token and token secret must be at least 32 characters')
  }

  const host = env.OPENLINK_BROWSER_HOST?.trim() || '127.0.0.1'
  const port = integer(env, 'OPENLINK_BROWSER_PORT', 43120, 1, 65535)
  const publicBaseUrl = env.OPENLINK_BROWSER_PUBLIC_URL?.trim() || `http://${host}:${port}`
  const publicUrl = new URL(publicBaseUrl)
  if (!['http:', 'https:'].includes(publicUrl.protocol)) {
    throw new BrowserHostError('INVALID_CONFIG', 'OPENLINK_BROWSER_PUBLIC_URL must be HTTP or HTTPS')
  }

  const storageRoot = resolve(env.OPENLINK_BROWSER_STORAGE_ROOT?.trim() || '.browser-data')
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 })

  return {
    host,
    port,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ''),
    apiToken,
    tokenSecret,
    allowedParentOrigins: parseOrigins(env.OPENLINK_BROWSER_ALLOWED_ORIGINS || 'http://localhost:3000'),
    storageRoot,
    chromeExecutable: env.OPENLINK_CHROME_EXECUTABLE?.trim() || undefined,
    maxSessions: integer(env, 'OPENLINK_BROWSER_MAX_SESSIONS', 32, 1, 512),
    sessionTtlMs: integer(env, 'OPENLINK_BROWSER_SESSION_TTL_MS', 3_600_000, 60_000, 86_400_000),
    controlLeaseTtlMs: integer(env, 'OPENLINK_BROWSER_CONTROL_LEASE_TTL_MS', 15_000, 1_000, 120_000),
    shutdownTimeoutMs: integer(env, 'OPENLINK_BROWSER_SHUTDOWN_TIMEOUT_MS', 10_000, 1_000, 60_000),
  }
}

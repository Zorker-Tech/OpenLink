#!/usr/bin/env node
import { getAsset, isSea } from 'node:sea'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { installReleaseArchive } from './openlinkctl.mjs'
import { createProductionConfiguration } from './runtime/configuration.mjs'
import { normalizeTarget } from './runtime/release-contract.mjs'
import { runPreflight } from './runtime/preflight.mjs'
import { installNativeService } from './runtime/native-service.mjs'

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid installer argument near ${key ?? '<end>'}`)
    values.set(key.slice(2), value)
  }
  return values
}

function paths(values) {
  if (process.platform === 'linux') {
    const configPath = resolve(values.get('config') || '/etc/openlink/openlink.env')
    return {
      installRoot: resolve(values.get('root') || '/opt/openlink'),
      configPath,
      secretsPath: resolve(values.get('secrets') || join(dirname(configPath), 'secrets.env')),
      stateRoot: resolve(values.get('state-root') || '/var/lib/openlink'),
      logRoot: resolve(values.get('log-root') || '/var/log/openlink'),
      backupRoot: resolve(values.get('backup-root') || '/var/backups/openlink'),
    }
  }
  if (process.platform === 'darwin') {
    const root = resolve(values.get('root') || '/Library/Application Support/OpenLink')
    const configPath = resolve(values.get('config') || join(root, 'config/openlink.env'))
    return {
      installRoot: root,
      configPath,
      secretsPath: resolve(values.get('secrets') || join(dirname(configPath), 'secrets.env')),
      stateRoot: resolve(values.get('state-root') || join(root, 'state')),
      logRoot: resolve(values.get('log-root') || '/Library/Logs/OpenLink'),
      backupRoot: resolve(values.get('backup-root') || join(root, 'backups')),
    }
  }
  throw new Error(`OpenLink production installer does not support ${process.platform}`)
}

function parseTrust(document) {
  const keys = document?.keys ?? document
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('Embedded release trust root is invalid')
  return Object.fromEntries(Object.entries(keys).map(([id, value]) => [id, typeof value === 'string' ? value : value?.publicKeyPem]))
}

async function trustRoot(values) {
  if (isSea()) return parseTrust(JSON.parse(getAsset('release-keys.json', 'utf8')))
  const path = values.get('trust')
  if (!path) throw new Error('A trust file is required outside the sealed installer')
  return parseTrust(JSON.parse(await readFile(resolve(path), 'utf8')))
}

export async function runBootstrapInstaller(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    const keys = await trustRoot(new Map())
    return { ok: true, sealedInstaller: isSea(), target: normalizeTarget({ platform: process.platform, architecture: process.arch }).triple, trustedKeyIds: Object.keys(keys).sort() }
  }
  const values = parseArguments(argv)
  const archive = values.get('archive')
  const appUrl = values.get('app-url')
  if (!archive || !appUrl) throw new Error('Usage: openlink-installer --archive <bundle.tar.gz> --app-url <https-origin> [--root <path>]')
  const destination = paths(values)
  const trustedKeys = await trustRoot(values)
  const expectedTarget = normalizeTarget({ platform: process.platform, architecture: process.arch })
  const installed = await installReleaseArchive({ archive, installRoot: destination.installRoot, trustedKeys, expectedTarget })
  const releaseRoot = installed.destination
  const configuration = await createProductionConfiguration({
    releaseRoot,
    configPath: destination.configPath,
    secretsPath: destination.secretsPath,
    stateRoot: destination.stateRoot,
    logRoot: destination.logRoot,
    backupRoot: destination.backupRoot,
    appUrl,
    gatewayUrl: values.get('gateway-url'),
    allowInsecure: values.get('allow-insecure-http') === '1',
  })
  if (values.get('skip-host-preflight') !== '1') {
    await runPreflight({
      releaseRoot,
      stateRoot: destination.stateRoot,
      platform: process.platform,
      architecture: process.arch,
      dockerCommand: values.get('docker-command') || 'docker',
      environment: {},
    })
  }
  const service = values.get('skip-service-install') === '1' ? { skipped: true } : await installNativeService({
    releaseRoot,
    installRoot: destination.installRoot,
    configPath: destination.configPath,
    secretsPath: destination.secretsPath,
    backupKeyPath: configuration.backupKeyPath,
    stateRoot: destination.stateRoot,
    logRoot: destination.logRoot,
    backupRoot: destination.backupRoot,
  })
  return { ok: true, installed, service, configuration: { ...configuration, secretsPath: '<protected>', backupKeyPath: '<protected>' } }
}

if (import.meta.url === `file://${process.argv[1]}` || isSea()) {
  runBootstrapInstaller().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`openlink-installer: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

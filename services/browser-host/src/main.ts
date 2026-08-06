import { BrowserHostServer } from './browser-server.js'
import { loadBrowserHostConfig } from './config.js'

const config = loadBrowserHostConfig()
const server = new BrowserHostServer(config)
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const timeout = setTimeout(() => process.exit(1), config.shutdownTimeoutMs)
  timeout.unref()
  try {
    await server.close()
    clearTimeout(timeout)
    process.stdout.write(`Browser Host stopped (${signal})\n`)
    process.exit(0)
  } catch (error) {
    process.stderr.write(`Browser Host shutdown failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.on('uncaughtException', (error) => {
  process.stderr.write(`Uncaught Browser Host error: ${error.stack ?? error.message}\n`)
  void shutdown('uncaughtException')
})
process.on('unhandledRejection', (error) => {
  process.stderr.write(`Unhandled Browser Host rejection: ${error instanceof Error ? error.stack : String(error)}\n`)
  void shutdown('unhandledRejection')
})

await server.listen()
process.stdout.write(`OpenLink Browser Host listening on ${config.publicBaseUrl}\n`)

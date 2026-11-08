import { networkInterfaces } from 'node:os'

/** @type {import('next').NextConfig} */
const localZokerbaseUrl = (
  process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
)?.replace(/\/+$/, '')
const localGatewayProxyPort = process.env.OPENLINK_DESKTOP_GATEWAY_PROXY_PORT?.trim() || '43125'
const runtimeMode = (process.env.OPENLINK_RUNTIME_MODE || 'local').trim().toLowerCase()
const localInterfaceOrigins = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === 'IPv4' && !address.internal)
  .map((address) => address.address)

const nextConfig = {
  distDir: process.env.OPENLINK_NEXT_DIST_DIR || '.next',
  // Preserve the gateway's trailing slash so relative editor assets resolve
  // under the per-session path. proxy.ts keeps the normal canonical redirect
  // behavior for every other route.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const beforeFiles = []
    if (localZokerbaseUrl) {
      beforeFiles.push({
        source: '/api/openlink-zokerbase/:path*',
        destination: `${localZokerbaseUrl}/:path*`,
      })
    }
    if (runtimeMode === 'local') {
      const gatewayProxyOrigin = `http://127.0.0.1:${localGatewayProxyPort}`
      for (const gateway of ['desktop', 'browser', 'code-server']) {
        beforeFiles.push({
          source: `/v1/${gateway}/gateway/:path*`,
          destination: `${gatewayProxyOrigin}/v1/${gateway}/gateway/:path*`,
        })
      }
    }
    if (beforeFiles.length === 0) return []
    return {
      beforeFiles,
    }
  },
  // Customer self-hosted releases run the prebuilt standalone server. Source
  // compilation and dependency installation remain internal release tasks.
  output: 'standalone',
  // The Local stack is also opened from the workstation's LAN address during
  // development. Next blocks dev assets and HMR for unlisted origins, which
  // leaves Client Components rendered but their event handlers unattached.
  allowedDevOrigins: [...new Set(['localhost', '127.0.0.1', ...localInterfaceOrigins])],
  // Server Function arguments can contain provider API keys and other user
  // credentials. Keep request logging while preventing Next dev from printing
  // those arguments to the terminal.
  logging: {
    serverFunctions: false,
  },
  // Keep Next's development overlay out of the product surface. It can cover
  // right-aligned controls (for example the Skills editor Save button).
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig

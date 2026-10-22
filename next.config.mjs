import { networkInterfaces } from 'node:os'

/** @type {import('next').NextConfig} */
const localZokerbaseUrl = (
  process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
)?.replace(/\/+$/, '')
const localInterfaceOrigins = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === 'IPv4' && !address.internal)
  .map((address) => address.address)

const nextConfig = {
  distDir: process.env.OPENLINK_NEXT_DIST_DIR || '.next',
  async rewrites() {
    if (!localZokerbaseUrl) return []
    return {
      beforeFiles: [
        {
          source: '/api/openlink-zokerbase/:path*',
          destination: `${localZokerbaseUrl}/:path*`,
        },
      ],
    }
  },
  // Customer self-hosted releases run the prebuilt standalone server. Source
  // compilation and dependency installation remain internal release tasks.
  output: 'standalone',
  // The Local stack is also opened from the workstation's LAN address during
  // development. Next blocks dev assets and HMR for unlisted origins, which
  // leaves Client Components rendered but their event handlers unattached.
  allowedDevOrigins: [...new Set(['localhost', '127.0.0.1', ...localInterfaceOrigins])],
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

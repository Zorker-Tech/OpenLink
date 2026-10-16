/** @type {import('next').NextConfig} */
const localZokerbaseUrl = (
  process.env.OPENLINK_LOCAL_ZOKERBASE_URL || process.env.OPENLINK_LOCAL_SUPABASE_URL
)?.replace(/\/+$/, '')

const nextConfig = {
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
  // The Local stack deliberately supports both localhost and 127.0.0.1. The
  // latter is used by ZOKERBASE callbacks, so permit its dev HMR origin too.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
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

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/postcss'

const rendererRoot = fileURLToPath(new URL('./src/renderer/', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const platformRoot = path.join(rendererRoot, 'platform')
const upstream = process.env.OPENLINK_DESKTOP_UPSTREAM || 'http://127.0.0.1:3000'

/**
 * The desktop renderer is a second host for the same product UI. It resolves
 * the repository root as `@`, so `components/` and client-safe `lib/` modules
 * are consumed verbatim. Next-only imports are redirected at build time; no
 * shared component is forked or edited.
 */
export default defineConfig({
  root: rendererRoot,
  base: '/',
  publicDir: path.join(repositoryRoot, 'public'),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: upstream, changeOrigin: true, ws: true },
      '/auth': { target: upstream, changeOrigin: true, ws: false },
    },
  },
  resolve: {
    alias: [
      { find: /^next\/navigation$/, replacement: path.join(platformRoot, 'navigation.tsx') },
      { find: /^next\/link$/, replacement: path.join(platformRoot, 'link.tsx') },
      { find: /^@\/app\/chat\/actions$/, replacement: path.join(platformRoot, 'actions/chat.ts') },
      { find: /^@\/app\/settings\/actions$/, replacement: path.join(platformRoot, 'actions/settings.ts') },
      { find: /^@\/app\/settings\/skills\/actions$/, replacement: path.join(platformRoot, 'actions/skills.ts') },
      { find: /^@\/app\/app\/project-actions$/, replacement: path.join(platformRoot, 'actions/project.ts') },
      { find: /^@\/app\/app\/organization-actions$/, replacement: path.join(platformRoot, 'actions/organization.ts') },
      { find: /^@\/app\/app\/onboarding\/actions$/, replacement: path.join(platformRoot, 'actions/onboarding.ts') },
      { find: /^@\/app\/app\/onboarding\/cloud-project-actions$/, replacement: path.join(platformRoot, 'actions/cloud-project.ts') },
      { find: '@', replacement: repositoryRoot },
    ],
  },
  plugins: [
    {
      // `onboarding-form.tsx` imports its server actions through relative
      // specifiers. Resolve those two edges explicitly so the shared form can
      // run in the Vite host without editing the file.
      name: 'openlink-desktop-relative-action-edges',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer) return null
        if (source === './actions' && importer.endsWith('/app/app/onboarding/onboarding-form.tsx')) {
          return path.join(platformRoot, 'actions/onboarding.ts')
        }
        if (source === './cloud-project-actions' && importer.endsWith('/app/app/onboarding/cloud-project-setup.tsx')) {
          return path.join(platformRoot, 'actions/cloud-project.ts')
        }
        return null
      },
    },
  ],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    'process.env.NEXT_PUBLIC_ZORKER_APP_URL': JSON.stringify(process.env.NEXT_PUBLIC_ZORKER_APP_URL || ''),
    'process.env.NEXT_PUBLIC_OPENLINK_RUNTIME_MODE': JSON.stringify(process.env.NEXT_PUBLIC_OPENLINK_RUNTIME_MODE || ''),
    'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_URL || ''),
    'process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || ''),
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      '@base-ui/react/accordion',
      'embla-carousel-react',
      'shiki',
      '@rive-app/react-webgl2',
      '@xyflow/react',
      'media-chrome/react',
      'react-jsx-parser',
    ],
  },
  build: {
    outDir: path.join(repositoryRoot, 'desktop/dist-renderer'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
})

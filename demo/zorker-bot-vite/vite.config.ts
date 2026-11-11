import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  esbuild: {
    jsx: 'automatic',
  },
  server: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer/', import.meta.url)),
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./out/renderer/', import.meta.url)),
    emptyOutDir: true,
  },
})

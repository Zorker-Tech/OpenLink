import { build } from 'esbuild'
import { mkdir, rename, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const serviceRoot = fileURLToPath(new URL('../services/work-host/', import.meta.url))
const distDirectory = `${serviceRoot}dist`
const outputPath = `${distDirectory}/host.mjs`
const temporaryPath = `${distDirectory}/.host.${process.pid}.${Date.now()}.mjs`

await mkdir(distDirectory, { recursive: true })

try {
  await build({
    entryPoints: [`${serviceRoot}source/host/main.ts`],
    outfile: temporaryPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'warning',
    sourcemap: false,
  })
  await rename(temporaryPath, outputPath)
} finally {
  await rm(temporaryPath, { force: true })
}

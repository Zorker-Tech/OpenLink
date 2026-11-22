import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '../..')
const output = resolve(packageRoot, 'dist-sdk')
const require = createRequire(import.meta.url)
const version = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')).version
const metadata = {
  name: '@zorker/openlink-demo',
  version,
  description: 'An embeddable OpenLink Bot workspace demo for React and Next.js.',
  license: 'LicenseRef-Zorker-Openlink-1.0',
  type: 'module',
  main: './index.js',
  types: './types/embed/index.d.ts',
  exports: {
    '.': { types: './types/embed/index.d.ts', import: './index.js' },
    './styles.css': './index.css',
  },
  files: ['index.js', 'index.css', 'chunks', 'types'],
  sideEffects: ['**/*.css'],
  peerDependencies: { react: '>=19', 'react-dom': '>=19' },
}

await mkdir(output, { recursive: true })
await rm(resolve(output, 'chunks'), { force: true, recursive: true })

// Keep one public client entry with its own stylesheet and a shared React runtime.
await build({
  absWorkingDir: packageRoot,
  stdin: {
    contents: "import './src/styles/embed.css'\nexport * from './src/embed/index.ts'",
    resolveDir: packageRoot,
  },
  entryNames: 'index',
  chunkNames: 'chunks/[name]-[hash]',
  outdir: output,
  alias: { '@zorker/avatar': resolve(repoRoot, 'packages/avatar/src/index.ts') },
  bundle: true,
  splitting: true,
  external: ['react', 'react-dom'],
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  minify: true,
  banner: { js: "'use client';" },
})

execFileSync(process.execPath, [
  resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
  '-p', resolve(packageRoot, 'tsconfig.json'),
  '--emitDeclarationOnly',
  '--declarationMap', 'false',
  '--outDir', resolve(output, 'types'),
], { stdio: 'inherit' })

await Promise.all([
  writeFile(resolve(output, 'package.json'), JSON.stringify(metadata, null, 2) + '\n'),
  copyFile(resolve(repoRoot, 'LICENSE'), resolve(output, 'LICENSE')),
  copyFile(resolve(packageRoot, 'SDK.md'), resolve(output, 'README.md')),
])

console.log(`SDK built at ${output}`)

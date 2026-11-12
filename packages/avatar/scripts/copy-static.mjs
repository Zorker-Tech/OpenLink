import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceLib = resolve(packageRoot, 'src/lib')
const distLib = resolve(packageRoot, 'dist/lib')

await mkdir(distLib, { recursive: true })
for (const name of await readdir(sourceLib)) {
  if (name.endsWith('.js') || name.endsWith('.d.ts')) {
    await copyFile(resolve(sourceLib, name), resolve(distLib, name))
  }
}

const cssSource = resolve(packageRoot, 'src/components/AgentAvatar.css')
const cssDestination = resolve(packageRoot, 'dist/components/AgentAvatar.css')
await mkdir(dirname(cssDestination), { recursive: true })
await copyFile(cssSource, cssDestination)

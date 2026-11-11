import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cssSource = resolve(packageRoot, 'src/styles/zorker-bot-demo.css')
const cssDestination = resolve(packageRoot, 'dist/styles/zorker-bot-demo.css')

await mkdir(dirname(cssDestination), { recursive: true })
await copyFile(cssSource, cssDestination)

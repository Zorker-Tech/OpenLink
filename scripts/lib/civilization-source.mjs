import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const EXPECTED_PATH = 'services/civilization'
const EXPECTED_VERSION = '1.0.0'
const EXPECTED_COMMIT = '2594df21847bf0689fb3c362c6823a0a352afaa8'
const STAGE74_ENTRY = 'src/civilization/engine/stages/stage74_orion_memory_service.py'

export async function assertCivilizationSource(projectRoot) {
  const root = resolve(projectRoot)
  const revisions = JSON.parse(await readFile(join(root, 'services/source-revisions.json'), 'utf8'))
  const source = revisions?.services?.civilization
  if (!source || source.path !== EXPECTED_PATH || source.tag !== `v${EXPECTED_VERSION}`
    || source.version !== EXPECTED_VERSION || source.sourceCommit !== EXPECTED_COMMIT) {
    throw new Error(`services/source-revisions.json must pin Civilization ${EXPECTED_VERSION} at ${EXPECTED_PATH}`)
  }

  const sourceRoot = join(root, EXPECTED_PATH)
  const pyproject = await readFile(join(sourceRoot, 'pyproject.toml'), 'utf8')
  await Promise.all([
    access(join(sourceRoot, 'LICENSE')),
    access(join(sourceRoot, STAGE74_ENTRY)),
  ])
  const version = /^version\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1]
  if (version !== EXPECTED_VERSION) {
    throw new Error(`services/civilization must contain upstream version ${EXPECTED_VERSION}; found ${version ?? 'unknown'}`)
  }
  let hasNestedGit = false
  try {
    await access(join(sourceRoot, '.git'))
    hasNestedGit = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (hasNestedGit) throw new Error('services/civilization must be a subtree import without nested Git metadata')
  return { sourceRoot, sourceCommit: source.sourceCommit, version }
}

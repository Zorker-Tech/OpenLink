// Execute inside the current Worker; inspect its actual installed protocol.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp('/tmp/openlink-schema-smoke-')
try {
  execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', directory], { stdio: 'pipe' })
  const schemas = new Map()
  async function scan(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (/ToolRequestUserInput(Response|Answer)|CollaborationModeMask|ThreadGoalSetParams/.test(entry.name)) {
        schemas.set(entry.name, JSON.parse(await readFile(path, 'utf8')))
      }
    }
  }
  await scan(directory)
  const input = schemas.get('ToolRequestUserInputResponse.json')
  assert.ok(input?.required.includes('answers'))
  assert.equal(input.properties.answers.additionalProperties.$ref, '#/definitions/ToolRequestUserInputAnswer')
  assert.equal(input.definitions.ToolRequestUserInputAnswer.properties.answers.type, 'array')
  assert.equal(input.definitions.ToolRequestUserInputAnswer.properties.answers.items.type, 'string')
  const goal = schemas.get('ThreadGoalSetParams.json')
  assert.deepEqual(goal?.required, ['threadId'])
  for (const status of ['active', 'paused', 'blocked', 'complete']) assert.ok(goal.definitions.ThreadGoalStatus.enum.includes(status))
  console.log(JSON.stringify({ nativeSchemaVerified: true, contracts: ['question answers and skip', 'native goal statuses'] }))
} finally {
  await rm(directory, { recursive: true, force: true })
}

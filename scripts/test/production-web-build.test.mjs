import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../dev-browser.mjs', import.meta.url), 'utf8')

test('source-tree production startup always rebuilds the web artifact with local ZOKERBASE configuration', () => {
  const artifactBranchEnd = source.indexOf("if (mode === 'production')", source.indexOf("if (process.env.OPENLINK_BUILD_ARTIFACTS === '1')"))
  assert.ok(artifactBranchEnd > 0)
  assert.match(source.slice(artifactBranchEnd), /run\('npm', \['run', 'build:web'\]/)
  assert.match(source.slice(artifactBranchEnd), /OPENLINK_LOCAL_ZOKERBASE_URL: localZokerbase\.url/)
  assert.match(source.slice(artifactBranchEnd), /NEXT_PUBLIC_SUPABASE_URL: localZokerbase\.url/)
})

test('local Browser Gateway websocket origin follows the actual web port', () => {
  assert.match(source, /const webPort = String\(Number\(process\.env\.PORT \|\| 3000\)\)/)
  assert.match(source, /const localBrowserGatewayUpstreamOrigin = process\.env\.OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN \|\| `http:\/\/localhost:\$\{webPort\}`/)
  assert.match(source, /OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN: localBrowserGatewayUpstreamOrigin/)
  assert.doesNotMatch(source, /OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN: process\.env\.OPENLINK_BROWSER_GATEWAY_UPSTREAM_ORIGIN \|\| 'http:\/\/localhost:3000'/)
})

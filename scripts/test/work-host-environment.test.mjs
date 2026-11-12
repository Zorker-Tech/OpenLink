import assert from 'node:assert/strict'
import test from 'node:test'

import {
  scopeWorkHostEnvironment,
  stripWorkHostEnvironment,
  WORK_HOST_AMBIENT_ENVIRONMENT_KEYS,
  WORK_HOST_RUNTIME_ENVIRONMENT_KEYS,
} from '../lib/work-host-environment.mjs'

const runtime = {
  SLATE_DATA_ROOT: '/state/work-host',
  SLATE_HOST_PORT: '43127',
  SLATE_GATEWAY_TOKEN: 'work-host-gateway-secret',
  SLATE_GATEWAY_REQUIRE_AUTH: '1',
  SLATE_USE_EXISTING_BOX_EXEC_DAEMON: '1',
  SLATE_DISABLE_SEND_ACCEPT_RETURN: '1',
  OPENLINK_AGENT_HOST_URL: 'http://127.0.0.1:43121',
  OPENLINK_SUBSTRATE_API_TOKEN: 'substrate-secret',
}

const bff = {
  OPENLINK_WORK_HOST_URL: 'http://127.0.0.1:43127',
  OPENLINK_WORK_HOST_API_TOKEN: 'work-host-bff-secret',
}

test('Work-host credentials are absent from every inherited service environment', () => {
  const inherited = {
    PATH: '/usr/bin',
    HOME: '/home/openlink',
    NODE_ENV: 'production',
    SLATE_DATA_ROOT: '/stale/work-host',
    SLATE_HOST_PORT: '9999',
    SLATE_GATEWAY_TOKEN: 'inherited-gateway-secret',
    SLATE_GATEWAY_REQUIRE_AUTH: '0',
    SLATE_USE_EXISTING_BOX_EXEC_DAEMON: '0',
    SLATE_DISABLE_SEND_ACCEPT_RETURN: '0',
    SLATE_OTHER_PRIVATE_SETTING: 'must-not-leak',
    OPENLINK_WORK_HOST_URL: 'http://stale.invalid',
    OPENLINK_WORK_HOST_API_TOKEN: 'inherited-bff-secret',
  }
  const scoped = scopeWorkHostEnvironment(inherited, { runtime, bff })

  for (const environment of [scoped.shared, scoped.workHost, scoped.web]) {
    assert.equal(environment.SLATE_GATEWAY_TOKEN === 'inherited-gateway-secret', false)
    assert.equal(environment.OPENLINK_WORK_HOST_API_TOKEN === 'inherited-bff-secret', false)
    assert.equal(environment.SLATE_OTHER_PRIVATE_SETTING, undefined)
  }
  assert.equal(scoped.shared.PATH, '/usr/bin')
  assert.equal(scoped.web.OPENLINK_WORK_HOST_URL, bff.OPENLINK_WORK_HOST_URL)
  assert.equal(scoped.web.OPENLINK_WORK_HOST_API_TOKEN, bff.OPENLINK_WORK_HOST_API_TOKEN)
})

test('Work-host receives only its own runtime configuration and ambient process keys', () => {
  const scoped = scopeWorkHostEnvironment(
    {
      PATH: '/usr/bin',
      HOME: '/home/openlink',
      NODE_EXTRA_CA_CERTS: '/certs/root.pem',
      OPENLINK_PROVIDER_SECRET_KEY: 'provider-secret',
      OPENLINK_SUPABASE_SERVICE_ROLE_KEY: 'database-secret',
      OPENLINK_BROWSER_TOKEN_SECRET: 'browser-secret',
      OPENLINK_AGENT_API_TOKEN: 'agent-secret',
      OPENLINK_WORK_HOST_URL: 'http://127.0.0.1:43127',
      OPENLINK_WORK_HOST_API_TOKEN: 'work-host-bff-secret',
      SLATE_EXTRA_SETTING: 'not-for-work-host',
    },
    { runtime, bff },
  )

  assert.deepEqual(Object.keys(scoped.workHost).sort(), [...WORK_HOST_AMBIENT_ENVIRONMENT_KEYS.filter((key) => ['PATH', 'HOME', 'NODE_EXTRA_CA_CERTS'].includes(key)), ...WORK_HOST_RUNTIME_ENVIRONMENT_KEYS].sort())
  assert.equal(scoped.workHost.OPENLINK_WORK_HOST_API_TOKEN, undefined)
  assert.equal(scoped.workHost.OPENLINK_WORK_HOST_URL, undefined)
  assert.equal(scoped.workHost.OPENLINK_PROVIDER_SECRET_KEY, undefined)
  assert.equal(scoped.workHost.OPENLINK_SUPABASE_SERVICE_ROLE_KEY, undefined)
  assert.equal(scoped.workHost.OPENLINK_BROWSER_TOKEN_SECRET, undefined)
  assert.equal(scoped.workHost.OPENLINK_AGENT_API_TOKEN, undefined)
  assert.equal(scoped.workHost.SLATE_EXTRA_SETTING, undefined)
  assert.deepEqual(Object.fromEntries(WORK_HOST_RUNTIME_ENVIRONMENT_KEYS.map((key) => [key, scoped.workHost[key]])), runtime)
})

test('Web keeps the BFF environment and receives the Work-host client credentials', () => {
  const scoped = scopeWorkHostEnvironment(
    {
      PATH: '/usr/bin',
      OPENLINK_AGENT_API_TOKEN: 'agent-secret',
      OPENLINK_WORK_HOST_URL: 'http://stale.invalid',
      OPENLINK_WORK_HOST_API_TOKEN: 'stale-secret',
    },
    { runtime, bff },
  )

  assert.equal(scoped.web.PATH, '/usr/bin')
  assert.equal(scoped.web.OPENLINK_AGENT_API_TOKEN, 'agent-secret')
  assert.equal(scoped.web.OPENLINK_WORK_HOST_URL, bff.OPENLINK_WORK_HOST_URL)
  assert.equal(scoped.web.OPENLINK_WORK_HOST_API_TOKEN, bff.OPENLINK_WORK_HOST_API_TOKEN)
  assert.equal(scoped.web.SLATE_DATA_ROOT, undefined)
  assert.equal(scoped.web.SLATE_GATEWAY_TOKEN, undefined)
})

test('stripWorkHostEnvironment removes every SLATE and Work-host BFF variable', () => {
  assert.deepEqual(stripWorkHostEnvironment({
    PATH: '/usr/bin',
    SLATE_ANYTHING: '1',
    OPENLINK_WORK_HOST_PORT: '43127',
    OPENLINK_WORK_HOST_URL: 'http://127.0.0.1:43127',
    OPENLINK_WORK_HOST_API_TOKEN: 'secret',
    OPENLINK_AGENT_API_TOKEN: 'agent-secret',
  }), { PATH: '/usr/bin', OPENLINK_AGENT_API_TOKEN: 'agent-secret' })
})

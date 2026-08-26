import assert from 'node:assert/strict'
import test from 'node:test'
import { ambientProviderEnvironment, providerNetworkTargets } from '../src/provider-environment.js'

test('ambient provider environment is provider-scoped and excludes unrelated secrets', () => {
  const environment = ambientProviderEnvironment('amazon-bedrock', {
    AWS_ACCESS_KEY_ID: 'access',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_REGION: 'us-east-1',
    OPENLINK_PROVIDER_SECRET_KEY: 'must-not-forward',
    DATABASE_URL: 'must-not-forward',
  })
  assert.deepEqual(environment, {
    AWS_ACCESS_KEY_ID: 'access',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_REGION: 'us-east-1',
  })
})

test('ambient environment rejects unsafe values and maps Vertex URL templates to a wildcard target', () => {
  const environment = ambientProviderEnvironment('google-vertex', {
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    GOOGLE_CLOUD_PROJECT: 'openlink',
    GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/google.json\nleak',
  })
  assert.deepEqual(environment, {
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    GOOGLE_CLOUD_PROJECT: 'openlink',
  })
  assert.deepEqual(providerNetworkTargets('google-vertex', 'https://{location}-aiplatform.googleapis.com'), ['*.aiplatform.googleapis.com'])
  assert.deepEqual(providerNetworkTargets('deepseek', 'https://api.deepseek.com'), ['api.deepseek.com'])
  assert.deepEqual(providerNetworkTargets('hydite-vtslx-ao', 'https://api.hydite.com'), ['api.hydite.com'])
})

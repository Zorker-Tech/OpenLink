const WORK_HOST_RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  'SLATE_DATA_ROOT',
  'SLATE_HOST_PORT',
  'SLATE_GATEWAY_TOKEN',
  'SLATE_GATEWAY_REQUIRE_AUTH',
  'SLATE_USE_EXISTING_BOX_EXEC_DAEMON',
  'SLATE_DISABLE_SEND_ACCEPT_RETURN',
])

const WORK_HOST_BFF_ENVIRONMENT_KEYS = Object.freeze([
  'OPENLINK_WORK_HOST_URL',
  'OPENLINK_WORK_HOST_API_TOKEN',
])

const WORK_HOST_AMBIENT_ENVIRONMENT_KEYS = Object.freeze([
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
])

function pick(environment, keys) {
  return Object.fromEntries(keys.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]))
}

export function isWorkHostEnvironmentKey(key) {
  return key.startsWith('SLATE_') || key.startsWith('OPENLINK_WORK_HOST_')
}

export function stripWorkHostEnvironment(environment = {}) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !isWorkHostEnvironmentKey(key)))
}

export function scopeWorkHostEnvironment(environment = {}, { runtime = {}, bff = {} } = {}) {
  const shared = stripWorkHostEnvironment(environment)
  return {
    shared,
    workHost: {
      ...pick(shared, WORK_HOST_AMBIENT_ENVIRONMENT_KEYS),
      ...pick(runtime, WORK_HOST_RUNTIME_ENVIRONMENT_KEYS),
    },
    web: {
      ...shared,
      ...pick(bff, WORK_HOST_BFF_ENVIRONMENT_KEYS),
    },
  }
}

export { WORK_HOST_AMBIENT_ENVIRONMENT_KEYS, WORK_HOST_BFF_ENVIRONMENT_KEYS, WORK_HOST_RUNTIME_ENVIRONMENT_KEYS }

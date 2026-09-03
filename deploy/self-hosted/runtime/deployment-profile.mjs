const GIB = 1024 ** 3

const PROFILE_DEFINITIONS = Object.freeze({
  core: Object.freeze({
    name: 'core',
    revision: 'core/v1',
    components: Object.freeze({ knowledge: false, zero: false }),
    host: Object.freeze({ logicalCpus: 4, memoryBytes: 16 * GIB, freeBytes: 100 * GIB }),
    project: Object.freeze({ cpus: 2, memoryMb: 4_096, diskGb: 40 }),
  }),
  standard: Object.freeze({
    name: 'standard',
    revision: 'standard/v1',
    components: Object.freeze({ knowledge: true, zero: true }),
    host: Object.freeze({ logicalCpus: 8, memoryBytes: 32 * GIB, freeBytes: 200 * GIB }),
    project: Object.freeze({ cpus: 4, memoryMb: 8_192, diskGb: 64 }),
  }),
  dense: Object.freeze({
    name: 'dense',
    revision: 'dense/v1',
    components: Object.freeze({ knowledge: true, zero: true }),
    host: Object.freeze({ logicalCpus: 16, memoryBytes: 64 * GIB, freeBytes: 500 * GIB }),
    project: Object.freeze({ cpus: 2, memoryMb: 6_144, diskGb: 64 }),
  }),
})

function normalized(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : fallback
}

export function resolveDeploymentProfile(value) {
  const name = normalized(value, 'standard')
  const profile = PROFILE_DEFINITIONS[name]
  if (!profile) throw new Error(`Deployment profile must be one of: ${Object.keys(PROFILE_DEFINITIONS).join(', ')}`)
  return profile
}

export function resolveProjectRuntime(value, options = {}) {
  const runtime = normalized(value, options.defaultRuntime ?? 'vm')
  const allowed = options.allowAuto === true ? ['container', 'vm', 'auto'] : ['container', 'vm']
  if (!allowed.includes(runtime)) throw new Error(`Project runtime must be one of: ${allowed.join(', ')}`)
  return runtime
}

export function isolationClass(runtime) {
  const selected = resolveProjectRuntime(runtime)
  return selected === 'vm' ? 'vm' : 'container'
}

export function profileEnvironment(profileValue, runtimeValue) {
  const profile = resolveDeploymentProfile(profileValue)
  const runtime = resolveProjectRuntime(runtimeValue)
  return Object.freeze({
    OPENLINK_DEPLOYMENT_PROFILE: profile.name,
    OPENLINK_DEPLOYMENT_PROFILE_REVISION: profile.revision,
    OPENLINK_PROJECT_RUNTIME: runtime,
    OPENLINK_PROJECT_ISOLATION: isolationClass(runtime),
    OPENLINK_KNOWLEDGE_ENABLED: profile.components.knowledge ? '1' : '0',
    OPENLINK_ZERO_ENABLED: profile.components.zero ? '1' : '0',
    OPENLINK_PROJECT_VM_CPUS: String(profile.project.cpus),
    OPENLINK_PROJECT_VM_MEMORY_MB: String(profile.project.memoryMb),
    OPENLINK_PROJECT_VM_DISK_GB: String(profile.project.diskGb),
    OPENLINK_MINIMUM_LOGICAL_CPUS: String(profile.host.logicalCpus),
    OPENLINK_MINIMUM_MEMORY_BYTES: String(profile.host.memoryBytes),
    OPENLINK_MINIMUM_FREE_BYTES: String(profile.host.freeBytes),
  })
}

export function listDeploymentProfiles() {
  return Object.values(PROFILE_DEFINITIONS)
}


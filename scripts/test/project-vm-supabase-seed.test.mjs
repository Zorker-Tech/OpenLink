import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')

test('Golden Disk seeder imports into the target graphroot without network pulls or booting the disk', async () => {
  const source = await readFile(resolve(root, 'services/agent-host/project-vm-seed-supabase.sh'), 'utf8')
  assert.match(source, /losetup --find --show --partscan/)
  assert.match(source, /lsblk --noheadings --raw --paths --output PATH "\$loop"/)
  assert.match(source, /blkid -s LABEL -o value "\$partition"/)
  assert.match(source, /\(\( \$\{#root_partitions\[@\]\} == 1 \)\)/)
  assert.match(source, /podman --root "\$graphroot" --runroot "\$runroot" load --input/)
  assert.match(source, /sha256sum -c/)
  assert.match(source, /artifact lock checksum does not match bootc image/)
  assert.match(source, /observed_id=.*image inspect/)
  assert.match(source, /observed_id="sha256:\$observed_id"/)
  assert.doesNotMatch(source, /podman\s+(?:image\s+)?pull|docker\s+pull|curl\s+.*registry/)
  assert.doesNotMatch(source, /qemu|vfkit|machine start/)
})

test('disk build requires a complete attested image manifest before reuse and seeds before publication', async () => {
  const source = await readFile(resolve(root, 'scripts/build-project-vm-disk.mjs'), 'utf8')
  assert.match(source, /readImageArtifactManifest\(projectSupabaseImageManifestPath, projectSupabaseLock\)/)
  assert.match(source, /manifest\.diskProjectSupabase\?\.imageManifestSha256 === projectSupabaseImageManifestSha256/)
  const buildIndex = source.indexOf('const buildCommand')
  const seedIndex = source.indexOf('const seedCommand')
  const stagingIndex = source.indexOf('const temporaryDisk = await stat(temporaryRawDiskPath)')
  const publishIndex = source.indexOf('rename(temporaryRawDiskPath, rawDiskPath)')
  assert.ok(buildIndex >= 0 && seedIndex > buildIndex && stagingIndex > seedIndex, 'disk must be installed, seeded, then checked in staging')
  assert.ok(publishIndex > stagingIndex, 'Golden Disk must be atomically published only after its staged artifact is complete')
  assert.match(source, /timeout: 60 \* 60 \* 1000/)
  assert.match(source, /'machine', 'init',[\s\S]*\], artifactOptions\)/)
  assert.match(source, /machineName\.length > 30/)
  assert.match(source, /\['sudo', 'truncate', '-s', `\$\{diskSizeGb\}G`, guestDisk\]/)
  assert.match(source, /'exec bootc "\$@"'/)
  assert.match(source, /'install', 'to-disk', '--filesystem', 'xfs'/)
  assert.match(source, /'chmod 0555 \/proc'/)
  assert.match(source, /'test "\$\(stat -Lc %a \/proc\)" = 555'/)
  assert.match(source, /--volume', `\$\{outputRoot\}:\$\{guestOutputRoot\}`/)
  assert.match(source, /--volume', `\$\{projectSupabaseImageRoot\}:\$\{guestProjectSupabaseImageRoot\}:ro`/)
  assert.match(source, /'tar', '--sparse',[\s\S]*guestCompressedDisk/)
  const removeBuilderIndex = source.indexOf("'machine', 'rm', '--force', machineName")
  const extractIndex = source.indexOf("await run('python3', [sparseExtractor, compressedDiskPath, rawDiskName, temporaryRawDiskPath]")
  assert.ok(removeBuilderIndex > seedIndex && extractIndex > removeBuilderIndex, 'builder disk must be released before extracting the staged Golden Disk')
  assert.match(source, /diskProjectSupabase:[\s\S]*preloaded: true/)
})

test('bootc base image includes only lock/configuration and never project secrets', async () => {
  const source = await readFile(resolve(root, 'services/agent-host/project-vm-base.Containerfile'), 'utf8')
  assert.match(source, /project-supabase\/runtime\.lock\.json/)
  assert.match(source, /project-supabase\/configuration/)
  assert.doesNotMatch(source, /\.env|POSTGRES_PASSWORD|SERVICE_ROLE_KEY|JWT_SECRET/)
})

test('bootc base image identity binds the resolved immutable machine-os platform digest', async () => {
  const source = await readFile(resolve(root, 'scripts/build-project-vm-base.mjs'), 'utf8')
  assert.match(source, /platform: \{ os: 'linux', architecture, digest: descriptor\.digest \}/)
  assert.match(source, /baseImagePlatform: machineOs\.platform/)
  assert.match(source, /const artifactOptions = \{ cwd: root, timeout: 60 \* 60 \* 1000 \}/)
  const resolveIndex = source.indexOf('const machineOs = await ensureMachineOsArchive(baseImage)')
  const fingerprintIndex = source.indexOf("const fingerprint = createHash('sha256')")
  assert.ok(resolveIndex >= 0 && resolveIndex < fingerprintIndex, 'platform digest must be resolved before calculating the OCI fingerprint')
})

test('image acquisition records config image IDs separately from locked platform manifests', async () => {
  const source = await readFile(resolve(root, 'scripts/build-project-supabase-images.mjs'), 'utf8')
  assert.match(source, /archiveImageId\(path, reference\)/)
  assert.match(source, /tar', \['-xOf', path, 'manifest\.json'\]/)
  assert.match(source, /imageId: await archiveImageId/)
  assert.doesNotMatch(source, /dockerImageId/)
})

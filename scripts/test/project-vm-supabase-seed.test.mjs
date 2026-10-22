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
  assert.match(source, /manifest\.diskBootContract === diskBootContract/)
  assert.match(source, /manifest\.diskRecipeSha256 === diskRecipeSha256/)
  assert.match(source, /\[IO\.File\]::Replace\(\$Source, \$Destination, \$Backup, \$true\)/)
  assert.match(source, /publishGoldenDisk\(temporaryDiskPath, diskPath, previousDiskBackup, artifactOptions\)/)
  const stagingIndex = source.indexOf('const temporaryDisk = await stat(temporaryDiskPath)')
  const publishIndex = source.indexOf('publishGoldenDisk(temporaryDiskPath, diskPath, previousDiskBackup, artifactOptions)')
  assert.ok(buildIndex >= 0 && seedIndex > buildIndex && stagingIndex > seedIndex, 'disk must be installed, seeded, then checked in staging')
  assert.ok(publishIndex > stagingIndex, 'Golden Disk must be atomically published only after its staged artifact is complete')
  assert.match(source, /timeout: 60 \* 60 \* 1000/)
  assert.match(source, /'machine', 'init',[\s\S]*\], artifactOptions\)/)
  assert.match(source, /OPENLINK_PROJECT_VM_IMAGE_MEMORY_MB \|\| '6144'/)
  assert.match(source, /machineName\.length > 30/)
  assert.match(source, /\['sudo', 'truncate', '-s', `\$\{diskSizeGb\}G`, guestRawDisk\]/)
  assert.match(source, /sfdisk --wipe always --wipe-partitions always/)
  assert.match(source, /<<OPENLINK_PARTITIONS/)
  assert.match(source, /21686148-6449-6E6F-744E-656564454649/)
  assert.match(source, /mkfs\.fat -F 32 -n EFI-SYSTEM/)
  assert.match(source, /command -v mkfs\.ext4 >\/dev\/null \|\| \{ echo "mkfs\.ext4 is required for the Project VM boot filesystem/)
  assert.match(source, /mkfs\.ext4 -F -L boot/)
  assert.match(source, /mkfs\.xfs -f -L root/)
  assert.match(source, /bootc install to-filesystem --generic-image --karg=ignition\.platform\.id=\$\{artifactContract\.ignitionPlatform\} --root-mount-spec=UUID=\$root_uuid --boot-mount-spec=UUID=\$boot_uuid/)
  assert.doesNotMatch(source, /--karg=ignition\.firstboot|--karg=rd\.neednet=1|--karg=ip=dhcp/)
  assert.match(source, /writeFile\(resolve\(outputRoot, 'project-vm-install-disk\.sh'\), `\$\{diskInstallScript\}\\n`/)
  assert.match(source, /`\$\{guestOutputRoot\}\/project-vm-install-disk\.sh:\/tmp\/project-vm-install-disk\.sh:ro`/)
  assert.match(source, /'bash', '\/tmp\/project-vm-install-disk\.sh'/)
  assert.match(source, /sed -i 's\/\^options \/options \$ignition_firstboot \/'/)
  assert.match(source, /grep -Fx 'set ignition_network_kcmdline=\\"rd\.neednet=1 ip=dhcp\\"'/)
  assert.ok(
    source.includes(String.raw`printf '%s\\n' 'set ignition_network_kcmdline=\"rd.neednet=1 ip=dhcp\"'`),
    'the one-shot Ignition network marker must be written verbatim',
  )
  assert.match(source, /const diskLayout = artifactContract\.diskLayout/)
  assert.match(source, /diskFilesystem: 'boot-ext4-root-xfs'/)
  assert.match(source, /'chmod 0555 \/proc'/)
  assert.match(source, /'test "\$\(stat -Lc %a \/proc\)" = 555'/)
  assert.match(source, /--volume', `\$\{outputRoot\}:\$\{guestOutputRoot\}`/)
  assert.match(source, /--volume', `\$\{projectSupabaseImageRoot\}:\$\{guestProjectSupabaseImageRoot\}:ro`/)
  assert.match(source, /'tar', '--sparse',[\s\S]*guestCompressedDisk/)
  // The conversion and integrity check must follow the platform artifact
  // contract (raw on AppleHV/APFS, vhdx on Hyper-V) instead of hardcoding a
  // single format, so both native hosts exercise the same contract test.
  assert.match(source, /'qemu-img', 'convert', '-p', '-f', 'raw', '-O', artifactContract\.diskFormat,/)
  assert.match(source, /'qemu-img', 'check', '-f', artifactContract\.diskFormat, guestDisk,/)
  assert.match(source, /convertCommand = \[[\s\S]*'--privileged', '--pid=host', '--ipc=host'/)
  assert.match(source, /verifyCommand = \[[\s\S]*'--security-opt', 'label=type:unconfined_t'/)
  const removeBuilderIndex = source.indexOf('removePodmanMachine(podman, machineName, artifactOptions)')
  const extractIndex = source.indexOf("await run('python3', [sparseExtractor, compressedDiskPath, buildRawDiskName, temporaryDiskPath]")
  assert.ok(removeBuilderIndex > seedIndex && extractIndex > removeBuilderIndex, 'builder disk must be released before extracting the staged Golden Disk')
  assert.match(source, /diskProjectSupabase:[\s\S]*preloaded: true/)
  assert.match(source, /diskBootContract,[\s\S]*diskRecipeSha256,/)
  assert.match(source, /diskPlatform:[\s\S]*cloneStrategy: artifactContract\.cloneStrategy/)
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

#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

disk=${1:?target raw disk is required}
artifacts=${2:?Project Supabase image artifact directory is required}
target=${3:-/run/openlink-project-vm-seed}
lock=/usr/lib/openlink/project-supabase/runtime.lock.json

fail() {
  printf 'openlink-project-supabase-seed: %s\n' "$*" >&2
  exit 1
}

for command in blkid jq losetup lsblk mount umount podman sha256sum findmnt; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
test -f "$disk" || fail "target disk does not exist"
test -f "$lock" || fail "runtime lock does not exist in bootc image"
test -f "$artifacts/manifest.json" || fail "image artifact manifest is missing"

architecture=$(uname -m)
case "$architecture" in
  x86_64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) fail "unsupported architecture: $architecture" ;;
esac

test "$(jq -r '.architecture' "$artifacts/manifest.json")" = "$architecture" || fail "artifact architecture does not match builder"
test "$(jq -r '.release.tag' "$artifacts/manifest.json")" = "$(jq -r '.release.tag' "$lock")" || fail "artifact release tag does not match lock"
test "$(jq -r '.release.commit' "$artifacts/manifest.json")" = "$(jq -r '.release.commit' "$lock")" || fail "artifact release commit does not match lock"
test "$(jq -r '.configurationTreeSha256' "$artifacts/manifest.json")" = "$(jq -r '.configuration.treeSha256' "$lock")" || fail "artifact configuration does not match lock"
lock_sha=$(sha256sum "$lock" | awk '{print $1}')
test "$(jq -r '.lockSha256' "$artifacts/manifest.json")" = "$lock_sha" || fail "artifact lock checksum does not match bootc image"

loop=''
mounted=0
bind_mounted=0
cleanup() {
  set +e
  if (( bind_mounted )); then umount /var/lib/containers/storage; fi
  if (( mounted )); then umount "$target"; fi
  if [[ -n "$loop" ]]; then losetup -d "$loop"; fi
  rm -rf "$target"
}
trap cleanup EXIT

rm -rf "$target"
mkdir -p "$target"
loop=$(losetup --find --show --partscan "$disk")

# bootc generic images label their writable root filesystem `root`. Enumerate
# only descendants of this loop device, then probe the filesystems directly.
# `lsblk`'s LABEL/FSTYPE columns are backed by the udev cache and can be empty
# immediately after `losetup --partscan`; blkid reads the on-disk superblock and
# removes that race without allowing a host filesystem to enter consideration.
mapfile -t partitions < <(lsblk --noheadings --raw --paths --output PATH "$loop" | tail -n +2)
root_partitions=()
for partition in "${partitions[@]}"; do
  label=$(blkid -s LABEL -o value "$partition" 2>/dev/null || true)
  fstype=$(blkid -s TYPE -o value "$partition" 2>/dev/null || true)
  if [[ "$label" = root && "$fstype" =~ ^(xfs|ext4|btrfs)$ ]]; then
    root_partitions+=("$partition")
  fi
done
(( ${#root_partitions[@]} == 1 )) || fail "target disk must contain exactly one supported filesystem labeled root"
root_partition=${root_partitions[0]}
mount "$root_partition" "$target"
mounted=1
findmnt --mountpoint "$target" >/dev/null || fail "target root filesystem did not mount"

# bootc/ostree deployments bind-mount /var from a deployment-specific
# subdirectory on the root filesystem (/ostree/deploy/<osname>/var).  Writing
# to /var on the raw root partition would be invisible after boot because the
# ostree initramfs overlays that path with the deployment's var directory.
# Detect and use the real var directory so preloaded images and the seed
# attestation are visible to the booted VM's Podman.
var_root=""
for candidate in "$target"/ostree/deploy/*/var; do
  if [ -d "$candidate" ]; then
    var_root="$candidate"
    break
  fi
done
if [ -z "$var_root" ]; then
  fail "could not find ostree var directory under $target/ostree/deploy/*/var"
fi

# Bind-mount the ostree var's containers storage to /var/lib/containers/storage
# so that the Podman db.sql records absolute paths that match what the booted
# VM's Podman expects (/var/lib/containers/storage).  Without this bind mount,
# the db.sql stores paths under the temporary seed mount point (e.g.
# /run/openlink-project-vm-seed/ostree/deploy/.../libpod), causing a
# "database configuration mismatch" error on first boot.
mkdir -p /var/lib/containers/storage "$var_root/lib/containers/storage"
mount --bind "$var_root/lib/containers/storage" /var/lib/containers/storage
bind_mounted=1

graphroot="/var/lib/containers/storage"
runroot=/run/containers/storage
state="$var_root/lib/openlink/project-supabase"
mkdir -p "$graphroot" "$runroot" "$state"
chmod 0700 "$state"

image_count=$(jq -r '.images | length' "$artifacts/manifest.json")
lock_count=$(jq -r '.services | length' "$lock")
test "$image_count" -eq "$lock_count" || fail "image artifact count does not match lock"

for index in $(seq 0 $((image_count - 1))); do
  service=$(jq -r ".images[$index].service" "$artifacts/manifest.json")
  image=$(jq -r ".images[$index].image" "$artifacts/manifest.json")
  archive=$(jq -r ".images[$index].archive" "$artifacts/manifest.json")
  archive_sha=$(jq -r ".images[$index].archiveSha256" "$artifacts/manifest.json")
  image_id=$(jq -r ".images[$index].imageId" "$artifacts/manifest.json")
  [[ "$archive" =~ ^[A-Za-z0-9._-]+$ ]] || fail "unsafe archive name for $service"
  test -f "$artifacts/$archive" || fail "archive for $service is missing"
  printf '%s  %s\n' "$archive_sha" "$artifacts/$archive" | sha256sum -c - >/dev/null || fail "archive checksum failed for $service"
  expected_image=$(jq -r --arg service "$service" '.services[] | select(.name == $service) | .image' "$lock")
  expected_digest=$(jq -r --arg service "$service" --arg architecture "$architecture" '.services[] | select(.name == $service) | .platforms[$architecture].digest' "$lock")
  test "$expected_image" = "$image" || fail "image reference mismatch for $service"
  artifact_digest=$(jq -r ".images[$index].platformDigest" "$artifacts/manifest.json")
  test "$expected_digest" = "$artifact_digest" || fail "platform digest mismatch for $service"
  podman --root "$graphroot" --runroot "$runroot" load --input "$artifacts/$archive" >/dev/null
  observed_id=$(podman --root "$graphroot" --runroot "$runroot" image inspect --format '{{.Id}}' "$image")
  [[ "$observed_id" =~ ^[a-f0-9]{64}$ ]] && observed_id="sha256:$observed_id"
  [[ "$observed_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "loaded image id format is invalid for $service"
  test "$observed_id" = "$image_id" || fail "loaded image id mismatch for $service"
done

podman --root "$graphroot" --runroot "$runroot" image list --format '{{.Repository}}:{{.Tag}}' >/dev/null
image_artifacts=$(jq '[.images[] | {service,image,platformDigest,imageId}]' "$artifacts/manifest.json")
jq -n \
  --arg release "$(jq -r '.release.tag' "$lock")" \
  --arg commit "$(jq -r '.release.commit' "$lock")" \
  --arg architecture "$architecture" \
  --arg configuration "$(jq -r '.configuration.treeSha256' "$lock")" \
  --argjson imageArtifacts "$image_artifacts" \
  '{schemaVersion:1,release:$release,commit:$commit,architecture:$architecture,configurationTreeSha256:$configuration,imageArtifacts:$imageArtifacts,seededAt:(now|todateiso8601)}' \
  > "$state/seed.json.tmp"
chmod 0600 "$state/seed.json.tmp"
mv -f "$state/seed.json.tmp" "$state/seed.json"
sync -f "$state/seed.json"
sync -f "$graphroot"

umount /var/lib/containers/storage
bind_mounted=0
umount "$target"
mounted=0
printf '{"release":"%s","architecture":"%s","images":%s}\n' "$(jq -r '.release.tag' "$lock")" "$architecture" "$image_count"

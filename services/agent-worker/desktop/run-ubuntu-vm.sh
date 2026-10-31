#!/usr/bin/env bash
set -euo pipefail

iso="${OPENLINK_DESKTOP_ISO:-/opt/openlink/ubuntu-desktop.iso}"
session_root="${OPENLINK_AGENT_SESSION_ROOT:-/openlink/session}"
workspace_root="${OPENLINK_AGENT_WORKSPACE_ROOT:-/workspace}"
# Shared, project-scoped scratch cache. Agent Host bind-mounts the Project VM
# directory that owns this path into every ISO desktop session, so the
# installed golden disk is built once per Project instead of once per chat.
desktop_cache_root="${OPENLINK_DESKTOP_CACHE_ROOT:-/opt/openlink/desktop-cache}"
vm_root="$session_root/ubuntu-desktop"
disk="$vm_root/system.qcow2"
seed="$vm_root/seed.iso"
installed_marker="$vm_root/installed"
cached_iso="$desktop_cache_root/iso"
golden_disk="$desktop_cache_root/ubuntu-desktop-golden.qcow2"
golden_marker="$desktop_cache_root/ubuntu-desktop-golden.ready"
golden_build_session="$desktop_cache_root/.ubuntu-desktop-golden-session"
golden_lock="$desktop_cache_root/.ubuntu-desktop-golden.lock"
# QMP lives in the container's /tmp: the session volume can sit on a shared
# filesystem where Unix sockets are not dependable. The Agent Worker uses the
# same path to pause (stop) and resume (cont) the installed desktop VM.
qmp_socket="/tmp/openlink-ubuntu-vm-qmp.sock"

# /tmp is container-local. This process owns the VNC endpoint lifecycle for
# the current container run, so clear any marker left by an earlier failure
# before starting the installer or installed VM.
rm -f /tmp/openlink-ubuntu-vm-vnc.ready

prepare_workspace_share() {
  if [[ ! -d "$workspace_root" ]]; then
    echo "Project workspace is missing: $workspace_root" >&2
    return 1
  fi
  if ! command -v setfacl >/dev/null 2>&1 || ! command -v getfacl >/dev/null 2>&1; then
    echo "Ubuntu Desktop workspace sharing requires the acl utilities" >&2
    return 1
  fi

  local access_acl default_acl
  access_acl="$(getfacl -cp "$workspace_root" | grep -c '^user:openlink:rwx$' || true)"
  default_acl="$(getfacl -cp "$workspace_root" | grep -c '^default:user:openlink:rwx$' || true)"
  if [[ "$access_acl" == 1 && "$default_acl" == 1 ]]; then
    return 0
  fi

  # The Project VM keeps the workspace root private (0700). Grant only the
  # desktop account access, and keep OpenLink's other session/control data
  # outside the desktop share.
  setfacl -m u:openlink:rwx "$workspace_root"
  setfacl -d -m u:openlink:rwx "$workspace_root"
  find "$workspace_root" -mindepth 1 \
    \( -path "$workspace_root/.openlink" -o -path "$workspace_root/.openlink/*" \) -prune -o \
    -exec setfacl -m u:openlink:rwX -- {} +
  find "$workspace_root" -mindepth 1 \
    \( -path "$workspace_root/.openlink" -o -path "$workspace_root/.openlink/*" \) -prune -o \
    -type d -exec setfacl -d -m u:openlink:rwx -- {} +
}

ensure_desktop_cache() {
  mkdir -p "$desktop_cache_root" "$cached_iso" || return 1
  if [[ "$(id -u)" -eq 0 ]]; then
    # The cache directory is bind-mounted from the Project VM. qemu runs as
    # the desktop account, so the shared tree must stay owned by that account
    # instead of the container root that created the mount point.
    chown openlink:openlink "$desktop_cache_root" "$cached_iso" || return 1
  fi
}

golden_identity() {
  printf '%s:%s' "$(basename "$iso")" "$(stat -c '%s' "$iso")"
}

golden_ready() {
  [[ -s "$golden_disk" && -f "$golden_marker" ]] || return 1
  [[ "$(cat "$golden_marker" 2>/dev/null || true)" == "$(golden_identity)" ]]
}

stage_installer_kernel() {
  if [[ -s "$cached_iso/vmlinuz" && -s "$cached_iso/initrd" ]]; then
    return 0
  fi
  mkdir -p "$cached_iso" || return 1
  if [[ "$(id -u)" -eq 0 ]]; then
    chown openlink:openlink "$cached_iso" || return 1
  fi
  runuser -u openlink -- xorriso -osirrox on -indev "$iso" \
    -extract /casper/vmlinuz "$cached_iso/vmlinuz" \
    -extract /casper/initrd "$cached_iso/initrd" >/dev/null 2>&1 || return 1
}

write_installer_seed() {
  local session_share="$1"
  local instance_id="$2"
  local password_file="$3"
  local password password_hash

  mkdir -p "$session_share/ubuntu-desktop"
  if [[ ! -s "$password_file" ]]; then
    openssl rand -hex 24 >"$password_file"
    chmod 600 "$password_file"
  fi
  password="$(cat "$password_file")"
  password_hash="$(printf '%s' "$password" | openssl passwd -6 -stdin)"

  cat >"$vm_root/user-data" <<EOF
#cloud-config
autoinstall:
  version: 1
  locale: en_US.UTF-8
  keyboard:
    layout: us
  timezone: UTC
  source:
    id: ubuntu-desktop
  storage:
    layout:
      name: direct
  identity:
    hostname: openlink-desktop
    username: openlink
    password: '$password_hash'
  shutdown: reboot
  late-commands:
    - curtin in-target --target=/target -- mkdir -p /mnt/openlink-workspace
    - curtin in-target --target=/target -- sh -c "printf '%s\\n' 'openlink-workspace /mnt/openlink-workspace 9p trans=virtio,version=9p2000.L,rw,_netdev 0 0' >> /etc/fstab"
    - curtin in-target --target=/target -- sed -i '/^\\[daemon\\]/a AutomaticLoginEnable=true\\nAutomaticLogin=openlink' /etc/gdm3/custom.conf
    - mkdir -p /run/openlink-session
    - mount -t 9p -o trans=virtio,version=9p2000.L openlink-session /run/openlink-session
    - mkdir -p /run/openlink-session/ubuntu-desktop
    - touch /run/openlink-session/ubuntu-desktop/installed
EOF
  cat >"$vm_root/meta-data" <<EOF
instance-id: $instance_id
local-hostname: openlink-desktop
EOF
  xorriso -as mkisofs -quiet -V CIDATA -J -R \
    -o "$seed" "$vm_root/user-data" "$vm_root/meta-data" || return 1
}

run_installer() {
  local target_disk="$1"
  local session_share="$2"
  local password_file="$3"
  local install_log="$4"

  mkdir -p "$session_share/ubuntu-desktop"
  if [[ "$(id -u)" -eq 0 ]]; then
    # The guest writes only the installed marker through the 9p session
    # share. Do not recursively re-own the real session tree: it contains
    # Worker-owned Pi transcripts and artifacts.
    chown -R openlink:openlink "$session_share/ubuntu-desktop"
  fi
  stage_installer_kernel || return 1
  write_installer_seed "$session_share" "openlink-$(basename "$session_root")" "$password_file" || return 1

  rm -f "$qmp_socket"
  runuser -u openlink -- qemu-system-x86_64 \
    -name openlink-ubuntu-desktop-installer \
    "${qemu_machine_args[@]}" \
    -smp "${OPENLINK_DESKTOP_VCPUS:-$qemu_vcpus}" -m "${OPENLINK_DESKTOP_MEMORY:-$qemu_memory}" \
    -kernel "$cached_iso/vmlinuz" -initrd "$cached_iso/initrd" \
    -append 'boot=casper autoinstall quiet splash ---' \
    -drive if=none,id=system,file="$target_disk",format=qcow2,cache=none \
    -device virtio-blk-pci,drive=system,bootindex=2 \
    -device ich9-ahci,id=sata \
    -drive if=none,id=ubuntu-iso,file="$iso",media=cdrom,readonly=on \
    -device ide-cd,drive=ubuntu-iso,bus=sata.0,unit=0,bootindex=1 \
    -drive if=none,id=seed-iso,file="$seed",media=cdrom,readonly=on \
    -device ide-cd,drive=seed-iso,bus=sata.1,unit=0 \
    -virtfs "local,path=$workspace_root,mount_tag=openlink-workspace,security_model=none,id=workspace" \
    -virtfs "local,path=$session_share,mount_tag=openlink-session,security_model=none,id=session" \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
    -device qemu-xhci -device usb-kbd -device usb-tablet \
    -vga virtio -display none -vnc 127.0.0.1:0 \
    -qmp "unix:$qmp_socket,server=on,wait=off" \
    -no-reboot \
    >>"$install_log" 2>&1 &
  local install_pid=$!

  local opened=false
  for _ in $(seq 1 300); do
    if (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then
      opened=true
      break
    fi
    if ! kill -0 "$install_pid" 2>/dev/null; then
      wait "$install_pid" || true
      echo "Ubuntu Desktop installer VM exited before opening VNC" >&2
      tail -n 80 "$install_log" >&2 || true
      return 1
    fi
    sleep 0.2
  done
  if [[ "$opened" != true ]]; then
    echo "Ubuntu Desktop installer VM did not open VNC" >&2
    tail -n 80 "$install_log" >&2 || true
    return 1
  fi
  # Expose the installer framebuffer through the already-running websockify.
  # The chat tab therefore gets a live desktop surface during the first-boot
  # install instead of timing out, and noVNC reconnects to the installed VM
  # when it takes over port 5900.
  touch /tmp/openlink-ubuntu-vm-vnc.ready

  wait "$install_pid" || true
  if [[ ! -e "$session_share/ubuntu-desktop/installed" ]]; then
    echo "Ubuntu Desktop autoinstall did not complete; see $install_log" >&2
    tail -n 120 "$install_log" >&2 || true
    return 1
  fi
}

build_golden_disk() {
  golden_ready && return 0
  ensure_desktop_cache
  # Serialize with other sessions in this Project VM. The lock file lives on
  # the shared cache volume, not on /tmp, so independent sandboxes contend on
  # the same durable lock.
  exec 9>"$golden_lock" || return 1
  if ! flock 9; then
    exec 9>&-
    return 1
  fi
  if golden_ready; then
    exec 9>&-
    return 0
  fi

  echo "Building the shared Ubuntu Desktop golden disk for this Project VM"
  rm -f "$golden_disk" "$golden_marker"
  local building="$desktop_cache_root/.ubuntu-desktop-golden-building.qcow2"
  rm -f "$building"
  runuser -u openlink -- qemu-img create -f qcow2 "$building" 64G || { exec 9>&-; return 1; }
  rm -rf "$golden_build_session"
  mkdir -p "$golden_build_session/ubuntu-desktop"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R openlink:openlink "$golden_build_session"
  fi

  if ! run_installer "$building" "$golden_build_session" "$desktop_cache_root/login-password" "$vm_root/qemu-install.log"; then
    rm -f "$building"
    rm -rf "$golden_build_session"
    exec 9>&-
    return 1
  fi
  if ! runuser -u openlink -- qemu-img check -r leaks "$building" >/dev/null 2>&1; then
    echo "The installed Ubuntu Desktop golden disk failed qemu-img check" >&2
    rm -f "$building"
    rm -rf "$golden_build_session"
    exec 9>&-
    return 1
  fi

  chmod 0444 "$building"
  mv "$building" "$golden_disk"
  golden_identity >"$golden_marker"
  rm -rf "$golden_build_session"
  exec 9>&-
  echo "Published the shared Ubuntu Desktop golden disk"
}

create_overlay_disk() {
  rm -f "$disk"
  runuser -u openlink -- qemu-img create -f qcow2 -F qcow2 -b "$golden_disk" "$disk" || return 1
  if ! runuser -u openlink -- qemu-img info "$disk" | grep -Fqx "backing file: $golden_disk"; then
    echo "Ubuntu Desktop overlay does not reference the shared golden disk" >&2
    return 1
  fi
  touch "$installed_marker"
}

if [[ ! -r "$iso" ]]; then
  echo "Ubuntu Desktop ISO is missing: $iso" >&2
  exit 1
fi
prepare_workspace_share
if [[ "$(id -u)" -eq 0 && -c /dev/kvm ]]; then
  kvm_gid="$(stat -c '%g' /dev/kvm)"
  if [[ "$kvm_gid" != 0 ]] && ! id -G openlink | tr ' ' '\n' | grep -qx "$kvm_gid"; then
    kvm_group="$(getent group "$kvm_gid" | cut -d: -f1 || true)"
    if [[ -z "$kvm_group" ]]; then
      kvm_group="openlink-kvm-${kvm_gid}"
      groupadd --gid "$kvm_gid" "$kvm_group"
    fi
    usermod --append --groups "$kvm_group" openlink
  fi
fi

qemu_machine_args=(-machine q35 -accel tcg,thread=multi -cpu max)
qemu_vcpus=2
qemu_memory=4G
if [[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] \
  && runuser -u openlink -- test -r /dev/kvm -a -w /dev/kvm; then
  qemu_machine_args=(-machine q35 -accel kvm -cpu host)
  qemu_vcpus=4
  qemu_memory=6G
  echo "Starting Ubuntu Desktop with KVM acceleration"
else
  echo "Starting Ubuntu Desktop with QEMU TCG software emulation; startup will be slower"
fi

mkdir -p "$vm_root"
if [[ "$(id -u)" -eq 0 ]]; then
  chown -R openlink:openlink "$vm_root"
fi

if [[ ! -e "$installed_marker" ]]; then
  # New sessions share one installed golden disk and only materialise a thin
  # COW overlay. The first session in a Project VM builds the golden disk once;
  # every later chat and restart boots a fresh overlay in seconds.
  if golden_ready || build_golden_disk; then
    create_overlay_disk
  else
    # Golden construction failed (for example the host cannot complete an
    # unattended install). Preserve the previous per-session install behavior
    # instead of leaving the desktop permanently unavailable.
    echo "Falling back to a per-session Ubuntu Desktop install" >&2
    if [[ ! -s "$disk" ]]; then
      runuser -u openlink -- qemu-img create -f qcow2 "$disk" 64G
    fi
    run_installer "$disk" "$session_root" "$vm_root/login-password" "$vm_root/qemu-install.log"
  fi
fi

rm -f "$qmp_socket"
runuser -u openlink -- qemu-system-x86_64 \
  -name openlink-ubuntu-desktop \
  "${qemu_machine_args[@]}" \
  -smp "${OPENLINK_DESKTOP_VCPUS:-$qemu_vcpus}" -m "${OPENLINK_DESKTOP_MEMORY:-$qemu_memory}" \
  -drive if=none,id=system,file="$disk",format=qcow2,cache=none \
  -device virtio-blk-pci,drive=system,bootindex=1 \
  -virtfs "local,path=$workspace_root,mount_tag=openlink-workspace,security_model=none,id=workspace" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -device qemu-xhci -device usb-kbd -device usb-tablet \
  -vga virtio -display none -vnc 127.0.0.1:0 \
  -qmp "unix:$qmp_socket,server=on,wait=off" \
  >>"$vm_root/qemu.log" 2>&1 &
vm_pid=$!

for _ in $(seq 1 100); do
  if (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then break; fi
  if ! kill -0 "$vm_pid" 2>/dev/null; then
    wait "$vm_pid" || true
    echo "Ubuntu Desktop VM exited before opening VNC" >&2
    tail -n 80 "$vm_root/qemu.log" >&2 || true
    exit 1
  fi
  sleep 0.2
done

touch /tmp/openlink-ubuntu-vm-vnc.ready
wait "$vm_pid"

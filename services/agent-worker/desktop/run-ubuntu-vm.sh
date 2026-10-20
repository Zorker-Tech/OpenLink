#!/usr/bin/env bash
set -euo pipefail

iso="${OPENLINK_DESKTOP_ISO:-/opt/openlink/ubuntu-desktop.iso}"
session_root="${OPENLINK_AGENT_SESSION_ROOT:-/openlink/session}"
workspace_root="${OPENLINK_AGENT_WORKSPACE_ROOT:-/workspace}"
vm_root="$session_root/ubuntu-desktop"
disk="$vm_root/system.qcow2"
seed="$vm_root/seed.iso"
installed_marker="$vm_root/installed"
cached_iso="$vm_root/iso"

if [[ ! -r "$iso" ]]; then
  echo "Ubuntu Desktop ISO is missing: $iso" >&2
  exit 1
fi
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

mkdir -p "$vm_root" "$cached_iso"
chown -R openlink:openlink "$vm_root"
if [[ ! -s "$disk" ]]; then
  runuser -u openlink -- qemu-img create -f qcow2 "$disk" 64G
fi

if [[ ! -e "$installed_marker" ]]; then
  password_file="$vm_root/login-password"
  if [[ ! -s "$password_file" ]]; then
    openssl rand -hex 24 >"$password_file"
    chmod 600 "$password_file"
  fi
  password="$(cat "$password_file")"
  password_hash="$(printf '%s' "$password" | openssl passwd -6 -stdin)"

  runuser -u openlink -- xorriso -osirrox on -indev "$iso" \
    -extract /casper/vmlinuz "$cached_iso/vmlinuz" \
    -extract /casper/initrd "$cached_iso/initrd" >/dev/null 2>&1

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
    - touch /run/openlink-session/ubuntu-desktop/installed
EOF
  cat >"$vm_root/meta-data" <<EOF
instance-id: openlink-$(basename "$session_root")
local-hostname: openlink-desktop
EOF
  xorriso -as mkisofs -quiet -V CIDATA -J -R \
    -o "$seed" "$vm_root/user-data" "$vm_root/meta-data"

  runuser -u openlink -- qemu-system-x86_64 \
    -name openlink-ubuntu-desktop-installer \
    "${qemu_machine_args[@]}" \
    -smp "${OPENLINK_DESKTOP_VCPUS:-$qemu_vcpus}" -m "${OPENLINK_DESKTOP_MEMORY:-$qemu_memory}" \
    -kernel "$cached_iso/vmlinuz" -initrd "$cached_iso/initrd" \
    -append 'boot=casper autoinstall quiet splash ---' \
    -drive if=none,id=system,file="$disk",format=qcow2,cache=none \
    -device virtio-blk-pci,drive=system,bootindex=2 \
    -device ich9-ahci,id=sata \
    -drive if=none,id=ubuntu-iso,file="$iso",media=cdrom,readonly=on \
    -device ide-cd,drive=ubuntu-iso,bus=sata.0,unit=0,bootindex=1 \
    -drive if=none,id=seed-iso,file="$seed",media=cdrom,readonly=on \
    -device ide-cd,drive=seed-iso,bus=sata.0,unit=1 \
    -virtfs "local,path=$workspace_root,mount_tag=openlink-workspace,security_model=none,id=workspace" \
    -virtfs "local,path=$session_root,mount_tag=openlink-session,security_model=none,id=session" \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
    -device qemu-xhci -device usb-kbd -device usb-tablet \
    -vga virtio -display none -vnc 127.0.0.1:0 \
    -no-reboot \
    >>"$vm_root/qemu-install.log" 2>&1 &
  install_pid=$!

  for _ in $(seq 1 300); do
    if (echo >/dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then
      touch /tmp/openlink-ubuntu-vm-vnc.ready
      break
    fi
    if ! kill -0 "$install_pid" 2>/dev/null; then
      wait "$install_pid" || true
      echo "Ubuntu Desktop installer VM exited before opening VNC" >&2
      tail -n 80 "$vm_root/qemu-install.log" >&2 || true
      exit 1
    fi
    sleep 0.2
  done

  if ! kill -0 "$install_pid" 2>/dev/null; then
    echo "Ubuntu Desktop installer VM is not running" >&2
    exit 1
  fi
  wait "$install_pid" || true
  if [[ ! -e "$installed_marker" ]]; then
    echo "Ubuntu Desktop autoinstall did not complete; see $vm_root/qemu-install.log" >&2
    tail -n 120 "$vm_root/qemu-install.log" >&2 || true
    exit 1
  fi
fi

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

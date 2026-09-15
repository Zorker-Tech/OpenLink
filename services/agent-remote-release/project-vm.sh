#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

REMOTE_ROOT=${OPENLINK_REMOTE_ROOT:?OPENLINK_REMOTE_ROOT is required}
VM_ROOT="${REMOTE_ROOT}/project-vms"
IMAGE_ROOT="${REMOTE_ROOT}/images"
BASE_URL=${OPENLINK_PROJECT_VM_BASE_IMAGE_URL:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}
BASE_SHA256=${OPENLINK_PROJECT_VM_BASE_IMAGE_SHA256:?OPENLINK_PROJECT_VM_BASE_IMAGE_SHA256 is required}
GUEST_USER=${OPENLINK_PROJECT_VM_GUEST_USER:-openlink}
PODMAN_BINARY=${OPENLINK_PROJECT_VM_PODMAN_BINARY:?OPENLINK_PROJECT_VM_PODMAN_BINARY is required}
PODMAN_SHA256=${OPENLINK_PROJECT_VM_PODMAN_SHA256:?OPENLINK_PROJECT_VM_PODMAN_SHA256 is required}

# Proxy values are explicitly supplied by the Agent Host operator because SSH
# does not forward the host process environment. They are used only on the
# remote target for Ubuntu image/package and Podman bootstrap downloads.
if [[ -n "${OPENLINK_PROJECT_VM_HTTP_PROXY:-}" ]]; then
  export HTTP_PROXY="$OPENLINK_PROJECT_VM_HTTP_PROXY" http_proxy="$OPENLINK_PROJECT_VM_HTTP_PROXY"
fi
if [[ -n "${OPENLINK_PROJECT_VM_HTTPS_PROXY:-}" ]]; then
  export HTTPS_PROXY="$OPENLINK_PROJECT_VM_HTTPS_PROXY" https_proxy="$OPENLINK_PROJECT_VM_HTTPS_PROXY"
fi

fail() {
  printf 'openlink-project-vm: %s\n' "$*" >&2
  exit 1
}

[[ "$PODMAN_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail "OPENLINK_PROJECT_VM_PODMAN_SHA256 is invalid"

usage() {
  cat >&2 <<'EOF'
usage:
  project-vm.sh ensure <machine> <cpus> <memory_mb> <disk_gb> <disk_mode> <ssh_port> <opensandbox_port> <browser_port> <code_server_port>
  project-vm.sh exec <machine> <command> [args...]
  project-vm.sh copy <machine> <source_on_host> <destination_in_guest>
  project-vm.sh stop <machine>
  project-vm.sh remove <machine>
  project-vm.sh inspect <machine>
EOF
  exit 64
}

machine_name() {
  local value="${1:-}"
  [[ "$value" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "machine name is invalid"
  printf '%s' "$value"
}

positive_integer() {
  local value="${1:-}" label="${2:-value}"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "${label} is invalid"
  (( value > 0 )) || fail "${label} must be positive"
  printf '%s' "$value"
}

disk_mode() {
  local value="${1:-}"
  [[ "$value" == thin || "$value" == thick ]] || fail "disk mode must be thin or thick"
  printf '%s' "$value"
}

port_number() {
  local value="$(positive_integer "${1:-}" "${2:-port}")"
  (( value >= 1024 && value <= 65535 )) || fail "${2:-port} is outside the unprivileged range"
  printf '%s' "$value"
}

machine_dir() {
  printf '%s/%s' "$VM_ROOT" "$(machine_name "$1")"
}

require_host_dependencies() {
  local missing=()
  for command in qemu-system-x86_64 qemu-img cloud-localds ssh scp curl sha256sum; do
    command -v "$command" >/dev/null 2>&1 || missing+=("$command")
  done
  if (( ${#missing[@]} )); then
    command -v sudo >/dev/null 2>&1 || fail "missing ${missing[*]} and sudo is unavailable"
    command -v apt-get >/dev/null 2>&1 || fail "missing ${missing[*]}; only Debian/Ubuntu apt hosts are supported"
    sudo -n apt-get update
    sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y \
      ca-certificates curl openssh-client netcat-openbsd qemu-system-x86 qemu-utils cloud-image-utils
  fi
  command -v sudo >/dev/null 2>&1 || fail "sudo is required to access KVM"
  sudo -n true >/dev/null 2>&1 || fail "the SSH account needs passwordless sudo for KVM access"
  grep -Eq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo || fail "CPU_VIRTUALIZATION_UNAVAILABLE: enable VT-x/AMD-V in firmware or expose nested virtualization"
  if [[ ! -e /dev/kvm ]]; then
    sudo -n modprobe kvm || fail "KVM_MODULES_INACTIVE: unable to load the generic KVM module"
    if grep -Eq '(^|[[:space:]])vmx([[:space:]]|$)' /proc/cpuinfo; then
      sudo -n modprobe kvm_intel || fail "KVM_MODULES_INACTIVE: unable to load kvm_intel"
    else
      sudo -n modprobe kvm_amd || fail "KVM_MODULES_INACTIVE: unable to load kvm_amd"
    fi
  fi
  [[ -e /dev/kvm ]] || fail "NESTED_VIRTUALIZATION_UNAVAILABLE: KVM modules loaded but /dev/kvm was not created"
  sudo -n test -r /dev/kvm && sudo -n test -w /dev/kvm || fail "KVM_PERMISSION_DENIED: the SSH account's sudo policy cannot access /dev/kvm"
}

base_image() {
  mkdir -p "$IMAGE_ROOT"
  local filename="$(basename "$BASE_URL")"
  [[ "$filename" =~ ^[A-Za-z0-9._-]+$ ]] || fail "base image URL has an unsafe filename"
  local image="${IMAGE_ROOT}/${filename}"
  if [[ -f "$image" ]]; then
    local digest
    digest="$(sha256sum "$image" | awk '{print $1}')"
    [[ "$digest" == "$BASE_SHA256" ]] || rm -f "$image"
  fi
  if [[ ! -f "$image" ]]; then
    local temporary="${image}.tmp.$$"
    curl --fail --location --retry 3 --connect-timeout 15 --output "$temporary" "$BASE_URL"
    # base_image is consumed through command substitution; stdout is its
    # return channel and must contain only the absolute backing-image path.
    # Keep the successful checksum diagnostic out of that channel while a
    # verification failure still propagates through `set -o pipefail`.
    printf '%s  %s\n' "$BASE_SHA256" "$temporary" | sha256sum -c - >/dev/null
    mv -f "$temporary" "$image"
  fi
  printf '%s' "$image"
}

guest_ssh_options() {
  local directory="$(machine_dir "$1")"
  printf '%s\n' \
    -i "${directory}/ssh/id_ed25519" \
    -p "$(cat "${directory}/ssh/ssh-port")" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5
}

guest_scp_options() {
  local directory="$(machine_dir "$1")"
  # OpenSSH deliberately uses different port flags: ssh(1) accepts -p while
  # scp(1) requires -P because its lowercase -p means preserve metadata.
  printf '%s\n' \
    -i "${directory}/ssh/id_ed25519" \
    -P "$(cat "${directory}/ssh/ssh-port")" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5
}

guest_ssh() {
  local machine="$1"
  shift
  mapfile -t options < <(guest_ssh_options "$machine")
  local remote_command='' argument quoted
  for argument in "$@"; do
    # OpenSSH concatenates the remote command arguments and executes them via
    # the guest shell. `%q` keeps values such as `;`, `$()` and embedded quotes
    # as literal argv data instead of allowing a host-side configuration value
    # to become guest shell syntax.
    printf -v quoted '%q' "$argument"
    if [[ -n "$remote_command" ]]; then remote_command+=" "; fi
    remote_command+="$quoted"
  done
  ssh "${options[@]}" "${GUEST_USER}@127.0.0.1" -- "$remote_command"
}

guest_scp_to() {
  local machine="$1" source="$2" destination="$3"
  mapfile -t options < <(guest_scp_options "$machine")
  scp "${options[@]}" "$source" "${GUEST_USER}@127.0.0.1:$destination"
}

wait_for_guest() {
  local machine="$1"
  # Ubuntu cloud images may perform first-boot SSH key generation and package
  # initialization in parallel with the QEMU guest becoming routable. Keep
  # the VM in provisioning for up to ten minutes instead of treating a slow
  # first boot as a failed Project VM.
  local deadline=$((SECONDS + 600))
  until guest_ssh "$machine" true >/dev/null 2>&1; do
    (( SECONDS < deadline )) || fail "Project VM ${machine} did not become reachable"
    sleep 2
  done
}

bootstrap_guest() {
  local machine="$1"
  local directory="$(machine_dir "$machine")"
  [[ -x "$PODMAN_BINARY" ]] || fail "repository-built Podman binary is missing: ${PODMAN_BINARY}"
  local marker="${directory}/guest-toolchain-${PODMAN_SHA256}"
  if [[ -f "$marker" ]]; then
    return
  fi
  guest_scp_to "$machine" "$PODMAN_BINARY" /tmp/openlink-podman
  guest_ssh "$machine" env \
    "OPENLINK_EXPECTED_PODMAN_SHA256=${PODMAN_SHA256}" \
    "OPENLINK_BOOTSTRAP_HTTP_PROXY=${OPENLINK_PROJECT_VM_HTTP_PROXY:-}" \
    "OPENLINK_BOOTSTRAP_HTTPS_PROXY=${OPENLINK_PROJECT_VM_HTTPS_PROXY:-}" \
    bash -s <<'EOF'
set -Eeuo pipefail
marker="$HOME/.openlink-toolchain-v4"
installed_digest="$(sudo sha256sum /usr/local/bin/podman 2>/dev/null | awk '{print $1}' || true)"
if [[ -f "$marker" && "$installed_digest" == "$OPENLINK_EXPECTED_PODMAN_SHA256" ]]; then exit 0; fi

# SSH does not forward the remote Agent Host's proxy environment. Inject it
# explicitly into the guest bootstrap so apt, npm/corepack and later package
# downloads use the same operator-provided route as the Ubuntu image curl.
if [[ -n "${OPENLINK_BOOTSTRAP_HTTP_PROXY:-}" ]]; then
  export HTTP_PROXY="$OPENLINK_BOOTSTRAP_HTTP_PROXY" http_proxy="$OPENLINK_BOOTSTRAP_HTTP_PROXY"
fi
if [[ -n "${OPENLINK_BOOTSTRAP_HTTPS_PROXY:-}" ]]; then
  export HTTPS_PROXY="$OPENLINK_BOOTSTRAP_HTTPS_PROXY" https_proxy="$OPENLINK_BOOTSTRAP_HTTPS_PROXY"
fi
# Ubuntu cloud images may still be running their first-boot package refresh
# when SSH becomes available. Wait for every APT/dpkg lock before starting the
# Project VM toolchain installation; this is required when thin and thick
# Projects initialize concurrently from the same release.
for attempt in $(seq 1 180); do
  if ! sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; then
  echo 'OpenLink Project VM cloud-init APT transaction did not finish in time' >&2
  exit 75
fi
# QEMU user-mode networking is IPv4-first. Force APT onto IPv4 and bound each
# mirror request so an unreachable guest IPv6 route cannot leave provisioning
# apparently idle for many minutes. Operator-provided HTTP(S) proxies remain
# inherited through the environment above.
APT_OPTIONS=(
  -o Acquire::ForceIPv4=true
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
)
sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTIONS[@]}" update
sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTIONS[@]}" install -y \
  ca-certificates curl git nodejs npm python3 python3-pip build-essential cmake jq ripgrep openssh-client \
  buildah conmon crun netavark aardvark-dns slirp4netns fuse-overlayfs uidmap \
  passt iptables nftables libgpgme11 libseccomp2 libsystemd0 qemu-guest-agent
sudo install -o root -g root -m 0755 /tmp/openlink-podman /usr/local/bin/podman
printf '%s\n' "$OPENLINK_EXPECTED_PODMAN_SHA256" | sudo tee /usr/local/share/openlink-podman.sha256 >/dev/null
rm -f /tmp/openlink-podman
if command -v corepack >/dev/null 2>&1; then
  sudo corepack enable
  sudo corepack prepare pnpm@10.12.4 --activate
else
  sudo npm install --global pnpm@10.12.4
fi
for required in git node npm pnpm python3 pip3 gcc g++ make cmake curl jq rg ssh podman; do
  if ! command -v "$required" >/dev/null 2>&1; then
    printf 'OpenLink Project VM toolchain is missing required command: %s\n' "$required" >&2
    exit 64
  fi
done
if command -v systemctl >/dev/null 2>&1; then
  # The repository ships a pinned standalone Podman binary, not a distro
  # package, so no vendor podman.socket unit exists. Own a durable rootful
  # service unit explicitly instead of depending on host package artifacts.
  sudo install -d -m 0755 /run/podman /etc/systemd/system
  printf '%s\n' \
    '[Unit]' \
    'Description=OpenLink Project VM Podman API' \
    'After=network-online.target' \
    'Wants=network-online.target' \
    '' \
    '[Service]' \
    'Type=simple' \
    'ExecStart=/usr/local/bin/podman system service --time=0 unix:///run/podman/podman.sock' \
    'Restart=on-failure' \
    'RestartSec=2' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target' \
    | sudo tee /etc/systemd/system/openlink-podman.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now openlink-podman.service
else
  sudo install -d -m 0755 /run/podman
  nohup sudo -n podman system service --time=0 "unix:///run/podman/podman.sock" >/tmp/openlink-rootful-podman-service.log 2>&1 &
fi
for attempt in $(seq 1 20); do
  if [[ -S /run/podman/podman.sock ]]; then break; fi
  sleep 0.5
done
test -S /run/podman/podman.sock
touch "$marker"
EOF
  touch "$marker"
}

ensure_machine() {
  local machine="$(machine_name "${1:-}")"
  local cpus="$(positive_integer "${2:-}" cpus)"
  local memory="$(positive_integer "${3:-}" memory_mb)"
  local disk="$(positive_integer "${4:-}" disk_gb)"
  local allocation="$(disk_mode "${5:-}")"
  local ssh_port="$(port_number "${6:-}" ssh_port)"
  local opensandbox_port="$(port_number "${7:-}" opensandbox_port)"
  local browser_port="$(port_number "${8:-}" browser_port)"
  local code_server_port="$(port_number "${9:-}" code_server_port)"
  require_host_dependencies
  mkdir -p "$VM_ROOT"
  local directory="$(machine_dir "$machine")"
  mkdir -p "${directory}/ssh"
  chmod 700 "${directory}" "${directory}/ssh"
  printf '%s\n' "$ssh_port" > "${directory}/ssh/ssh-port"
  if [[ ! -f "${directory}/ssh/id_ed25519" ]]; then
    ssh-keygen -q -t ed25519 -N '' -f "${directory}/ssh/id_ed25519"
  fi
  local base="$(base_image)"
  local disk_image="${directory}/disk.qcow2"
  local disk_mode_file="${directory}/disk-mode"
  local seed_image="${directory}/seed.iso"
  if [[ -f "$disk_image" && ! -f "$disk_mode_file" ]]; then
    # All releases before allocation-mode governance created qcow2 overlays.
    # Record that deterministic migration before enforcing immutability.
    printf '%s\n' thin > "$disk_mode_file"
  fi
  if [[ -f "$disk_mode_file" ]]; then
    local existing_allocation
    existing_allocation="$(disk_mode "$(cat "$disk_mode_file")")"
    [[ "$existing_allocation" == "$allocation" ]] || fail "Project VM disk mode is immutable (${existing_allocation} != ${allocation})"
  fi
  if [[ ! -f "$disk_image" ]]; then
    if [[ "$allocation" == thin ]]; then
      qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$disk_image"
      qemu-img resize "$disk_image" "${disk}G" >/dev/null
    else
      local required_bytes available_bytes allocated_bytes
      required_bytes=$((disk * 1024 * 1024 * 1024 + 2 * 1024 * 1024 * 1024))
      available_bytes="$(df -PB1 "$directory" | awk 'NR == 2 { print $4 }')"
      [[ "$available_bytes" =~ ^[0-9]+$ ]] || fail "unable to determine free space for thick Project VM disk"
      (( available_bytes >= required_bytes )) || fail "thick Project VM disk requires ${required_bytes} free bytes but only ${available_bytes} are available"
      qemu-img convert -q -f qcow2 -O qcow2 -o preallocation=full "$base" "$disk_image"
      qemu-img resize --preallocation=full "$disk_image" "${disk}G" >/dev/null
      allocated_bytes="$(du -B1 "$disk_image" | awk '{ print $1 }')"
      (( allocated_bytes >= disk * 1024 * 1024 * 1024 * 95 / 100 )) || fail "thick Project VM disk allocation is incomplete (${allocated_bytes} bytes)"
    fi
    printf '%s\n' "$allocation" > "$disk_mode_file"
  fi
  if [[ ! -f "$seed_image" ]]; then
    local public_key
    public_key="$(cat "${directory}/ssh/id_ed25519.pub")"
    local apt_proxy_config=''
    if [[ -n "${OPENLINK_PROJECT_VM_HTTP_PROXY:-}" ]]; then
      apt_proxy_config+="      Acquire::http::Proxy \"${OPENLINK_PROJECT_VM_HTTP_PROXY}\";"$'\n'
    fi
    if [[ -n "${OPENLINK_PROJECT_VM_HTTPS_PROXY:-}" ]]; then
      apt_proxy_config+="      Acquire::https::Proxy \"${OPENLINK_PROJECT_VM_HTTPS_PROXY}\";"$'\n'
    fi
    cat > "${directory}/user-data" <<EOF
#cloud-config
hostname: ${machine}
manage_etc_hosts: true
users:
  - default
  - name: ${GUEST_USER}
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${public_key}
$(if [[ -n "$apt_proxy_config" ]]; then
  printf 'write_files:\n'
  printf '  - path: /etc/apt/apt.conf.d/80-openlink-proxy\n'
  printf '    permissions: "0644"\n'
  printf '    content: |\n%s' "$apt_proxy_config"
fi)
# Package installation is owned by bootstrap_guest below. Keeping cloud-init
# declarative here avoids a second apt transaction racing the Project VM's
# complete toolchain installation and lets SSH become available immediately.
package_update: false
packages: []
runcmd:
  - systemctl enable --now ssh
  - systemctl enable --now qemu-guest-agent
EOF
    cat > "${directory}/meta-data" <<EOF
instance-id: ${machine}
local-hostname: ${machine}
EOF
    # meta-data already owns instance-id and local-hostname. Ubuntu 24.04's
    # cloud-localds rejects --hostname when an explicit metadata file is also
    # supplied, so keep one authoritative metadata source.
    cloud-localds "$seed_image" "${directory}/user-data" "${directory}/meta-data"
  fi
  local pid_file="${directory}/qemu.pid"
  # QEMU is launched through passwordless sudo and therefore runs as root.
  # A plain user-scoped kill -0 reports EPERM for a healthy VM and would make
  # retries delete its pidfile and attempt a duplicate boot on the same ports.
  if [[ -f "$pid_file" ]] && sudo -n kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    wait_for_guest "$machine"
    bootstrap_guest "$machine"
    return
  fi
  rm -f "$pid_file"
  sudo -n qemu-system-x86_64 \
    -name "$machine" \
    -machine q35,accel=kvm \
    -enable-kvm \
    -cpu host \
    -smp "$cpus" \
    -m "${memory}M" \
    -drive "file=${disk_image},if=virtio,format=qcow2" \
    -drive "file=${seed_image},if=virtio,format=raw,readonly=on" \
    -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${ssh_port}-:22,hostfwd=tcp:127.0.0.1:${opensandbox_port}-:${opensandbox_port},hostfwd=tcp:127.0.0.1:${browser_port}-:${browser_port},hostfwd=tcp:127.0.0.1:${code_server_port}-:${code_server_port}" \
    -display none \
    -monitor none \
    -serial none \
    -daemonize \
    -pidfile "$pid_file" \
    -D "${directory}/qemu.log"
  sudo -n chown "$(id -u):$(id -g)" "$pid_file" "${directory}/qemu.log" 2>/dev/null || true
  wait_for_guest "$machine"
  bootstrap_guest "$machine"
}

stop_machine() {
  local machine="$(machine_name "${1:-}")"
  local directory="$(machine_dir "$machine")"
  local pid_file="${directory}/qemu.pid"
  if [[ -f "$pid_file" ]]; then
    local pid="$(cat "$pid_file")"
    if sudo -n kill -0 "$pid" 2>/dev/null; then sudo -n kill "$pid"; fi
    for _ in {1..30}; do
      sudo -n kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    sudo -n kill -9 "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  fi
}

remove_machine() {
  local machine="$(machine_name "${1:-}")"
  stop_machine "$machine"
  rm -rf "$(machine_dir "$machine")"
}

inspect_machine() {
  local machine="$(machine_name "${1:-}")"
  local directory="$(machine_dir "$machine")"
  local running=false
  if [[ -f "${directory}/qemu.pid" ]] && sudo -n kill -0 "$(cat "${directory}/qemu.pid")" 2>/dev/null; then running=true; fi
  printf '{"name":"%s","running":%s,"sshPort":%s}\n' "$machine" "$running" "$(cat "${directory}/ssh/ssh-port" 2>/dev/null || echo null)"
}

command="${1:-}"
case "$command" in
  ensure)
    [[ $# -eq 10 ]] || usage
    ensure_machine "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}"
    ;;
  exec)
    [[ $# -ge 3 ]] || usage
    machine_name "$2" >/dev/null
    machine="$2"
    shift 2
    guest_ssh "$machine" "$@"
    ;;
  copy)
    [[ $# -eq 4 ]] || usage
    machine_name "$2" >/dev/null
    [[ -f "$3" ]] || fail "source artifact does not exist"
    guest_scp_to "$2" "$3" "$4"
    ;;
  stop)
    [[ $# -eq 2 ]] || usage
    stop_machine "$2"
    ;;
  remove)
    [[ $# -eq 2 ]] || usage
    remove_machine "$2"
    ;;
  inspect)
    [[ $# -eq 2 ]] || usage
    inspect_machine "$2"
    ;;
  *)
    usage
    ;;
esac

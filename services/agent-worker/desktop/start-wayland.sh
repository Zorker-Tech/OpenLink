#!/usr/bin/env bash
# T2 preview desktop: GNOME Shell 51 headless Wayland plus GNOME Remote
# Desktop's RDP server. A local FreeRDP client renders the session into Xvfb
# so the existing x11vnc/websockify Desktop Gateway remains the public surface.
set -euo pipefail

start_background() {
  local name="$1"
  shift
  local pid_file="/tmp/openlink-desktop-${name}.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    return
  fi
  "$@" >>"/tmp/openlink-desktop-${name}.log" 2>&1 &
  echo "$!" >"$pid_file"
}

wait_for_file() {
  local path="$1"
  for _ in $(seq 1 150); do
    [[ -e "$path" ]] && return 0
    sleep 0.2
  done
  echo "Timed out waiting for $path" >&2
  return 1
}

wait_for_process() {
  local process_name="$1"
  local pid_file="$2"
  for _ in $(seq 1 150); do
    pgrep -u openlink -x "$process_name" >/dev/null 2>&1 && return 0
    if [[ -f "$pid_file" ]] && ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  return 1
}

wait_for_port() {
  local port="$1"
  for _ in $(seq 1 150); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&- 3<&- 2>/dev/null || true
      return 0
    fi
    sleep 0.2
  done
  return 1
}

mkdir -p /run/user/1000 /tmp/openlink-runtime-openlink
chown openlink:openlink /run/user/1000 /tmp/openlink-runtime-openlink
chmod 700 /run/user/1000 /tmp/openlink-runtime-openlink

# GNOME Shell 51 is Wayland-only. Start the systemd user manager and its
# D-Bus bus; GNOME Remote Desktop's user service needs both.
desktop_bus=/run/user/1000/bus
systemctl start user@1000.service 2>/dev/null || true
for _ in $(seq 1 50); do
  [[ -S "$desktop_bus" ]] && break
  runuser -u openlink -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start dbus.socket >/dev/null 2>&1 || true
  sleep 0.2
done
if [[ ! -S "$desktop_bus" ]]; then
  echo "T2 GNOME requires the systemd user D-Bus bus" >&2
  exit 1
fi

desktop_env=(
  HOME=/home/openlink
  XDG_RUNTIME_DIR=/run/user/1000
  DBUS_SESSION_BUS_ADDRESS=unix:path="$desktop_bus"
  XDG_SESSION_TYPE=wayland
  XDG_CURRENT_DESKTOP=GNOME
  GNOME_SHELL_SESSION_MODE=user
  LIBGL_ALWAYS_SOFTWARE=1
)

# A headless session has no PAM login to unlock a keyring. Create/unlock an
# empty-password login keyring so GNOME Remote Desktop can store and retrieve
# its RDP credentials through libsecret.
keyring_root=/home/openlink/.local/share/keyrings
mkdir -p "$keyring_root"
chown -R openlink:openlink /home/openlink/.local/share
# The distro keyring unit starts a locked login collection before this
# service and cannot be unlocked without PAM. Mask it and own a fresh
# empty-password collection for the RDP credentials.
runuser -u openlink -- env "${desktop_env[@]}" systemctl --user stop gnome-keyring-daemon.socket gnome-keyring-daemon.service >/dev/null 2>&1 || true
runuser -u openlink -- env "${desktop_env[@]}" systemctl --user mask gnome-keyring-daemon.socket gnome-keyring-daemon.service >/dev/null 2>&1 || true
pkill -9 -x gnome-keyring-d 2>/dev/null || true
rm -rf "$keyring_root"
mkdir -p "$keyring_root"
chown -R openlink:openlink /home/openlink/.local/share
printf '\n' | runuser -u openlink -- env "${desktop_env[@]}" gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1 || true
for _ in $(seq 1 50); do
  runuser -u openlink -- env "${desktop_env[@]}" busctl --user list 2>/dev/null | grep -q org.freedesktop.secrets && break
  sleep 0.2
done

# Ubuntu Shell extensions assume a GDM-managed seat and crash the headless
# session. T2 runs the vanilla GNOME Shell session instead.
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell disable-user-extensions true >/dev/null 2>&1 || true
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell enabled-extensions "@as []" >/dev/null 2>&1 || true

rdp_root=/var/lib/openlink/project-desktop/rdp
mkdir -p "$rdp_root"
chown -R openlink:openlink /var/lib/openlink/project-desktop
chmod 700 /var/lib/openlink/project-desktop "$rdp_root"
if [[ ! -s "$rdp_root/cert.pem" || ! -s "$rdp_root/key.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$rdp_root/key.pem" -out "$rdp_root/cert.pem" \
    -days 3650 -subj "/CN=OpenLink T2 Project Desktop" >/dev/null 2>&1
  chown openlink:openlink "$rdp_root/cert.pem" "$rdp_root/key.pem"
  chmod 600 "$rdp_root/cert.pem" "$rdp_root/key.pem"
fi
if [[ ! -s "$rdp_root/password" ]]; then
  openssl rand -hex 16 >"$rdp_root/password"
  chown openlink:openlink "$rdp_root/password"
  chmod 600 "$rdp_root/password"
fi
rdp_password="$(cat "$rdp_root/password")"

# Headless Wayland display server. It owns the virtual monitor and provides
# the PipeWire screencast source consumed by GNOME Remote Desktop.
start_background gnome runuser -u openlink -- env "${desktop_env[@]}" \
  gnome-shell --headless --no-x11 --virtual-monitor 1280x800 --mode=user
desktop_process_name=gnome-shell
desktop_pid_file=/tmp/openlink-desktop-gnome.pid
if ! wait_for_process "$desktop_process_name" "$desktop_pid_file"; then
  echo "T2 GNOME Shell headless session did not start" >&2
  tail -n 80 /tmp/openlink-desktop-gnome.log >&2 || true
  exit 1
fi

# Configure the RDP server for the headless session.
runuser -u openlink -- env "${desktop_env[@]}" grdctl rdp set-port 3389 >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" grdctl rdp set-auth-methods credentials >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" grdctl rdp set-credentials openlink "$rdp_password" >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" grdctl rdp set-tls-cert "$rdp_root/cert.pem" >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" grdctl rdp set-tls-key "$rdp_root/key.pem" >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" grdctl rdp disable-view-only >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" grdctl rdp enable >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" systemctl --user restart gnome-remote-desktop.service
if ! wait_for_port 3389; then
  echo "T2 GNOME Remote Desktop RDP server did not listen on 3389" >&2
  runuser -u openlink -- env XDG_RUNTIME_DIR=/run/user/1000 journalctl --user -u gnome-remote-desktop.service -n 80 --no-pager >&2 2>/dev/null || true
  exit 1
fi

# Render the RDP session into an X11 display so the existing VNC gateway can
# serve it. The headless GNOME session owns Xwayland displays :0/:1, so use :9.
rm -f /tmp/.X9-lock /tmp/.X11-unix/X9
start_background xvfb runuser -u openlink -- env "${desktop_env[@]}" \
  Xvfb :9 -screen 0 1280x800x24 -nolisten tcp -ac +extension RANDR
wait_for_file /tmp/.X11-unix/X9
start_background rdp-bridge runuser -u openlink -- env \
  HOME=/home/openlink \
  DISPLAY=:9 \
  XDG_RUNTIME_DIR=/run/user/1000 \
  xfreerdp /v:127.0.0.1:3389 /u:openlink "/p:${rdp_password}" /cert:ignore \
  /size:1280x800 /f /dynamic-resolution /log-level:WARN
if ! wait_for_process xfreerdp /tmp/openlink-desktop-rdp-bridge.pid; then
  echo "T2 FreeRDP bridge did not start" >&2
  tail -n 80 /tmp/openlink-desktop-rdp-bridge.log >&2 || true
  exit 1
fi

sleep 1
start_background x11vnc x11vnc -display :9 -forever -shared -rfbport 5900 -localhost -nopw -noshm -xrandr
start_background websockify /usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900

for _ in $(seq 1 30); do
  if curl --silent --fail http://127.0.0.1:6080/vnc.html >/dev/null; then break; fi
  sleep 0.2
done

websockify_pid="$(cat /tmp/openlink-desktop-websockify.pid)"
desktop_pid="$(cat "$desktop_pid_file")"
rdp_pid="$(cat /tmp/openlink-desktop-rdp-bridge.pid)"
while kill -0 "$desktop_pid" 2>/dev/null \
  && kill -0 "$rdp_pid" 2>/dev/null \
  && kill -0 "$websockify_pid" 2>/dev/null; do
  # The RDP server is managed by systemd; require its socket only when a
  # component has not already exited.
  sleep 1
done
echo "T2 desktop component exited" >&2
exit 1

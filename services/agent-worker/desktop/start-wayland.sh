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

# Enable the toolkit bridge before GNOME starts. The accessibility bus is
# resolved after the session is up because a restart can allocate a new GUID.
desktop_atspi_address=unix:path=/run/user/1000/at-spi/bus_0
runuser -u openlink -- env \
  HOME=/home/openlink \
  XDG_RUNTIME_DIR=/run/user/1000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path="$desktop_bus" \
  gsettings set org.gnome.desktop.interface toolkit-accessibility true >/dev/null 2>&1 || true

desktop_env=(
  HOME=/home/openlink
  XDG_RUNTIME_DIR=/run/user/1000
  DBUS_SESSION_BUS_ADDRESS=unix:path="$desktop_bus"
  AT_SPI_BUS_ADDRESS="$desktop_atspi_address"
  GTK_MODULES=gail:atk-bridge
  XDG_SESSION_TYPE=wayland
  XDG_CURRENT_DESKTOP=ubuntu:GNOME
  XDG_SESSION_DESKTOP=ubuntu
  DESKTOP_SESSION=ubuntu
  GNOME_SHELL_SESSION_MODE=ubuntu
  LIBGL_ALWAYS_SOFTWARE=1
)

# Always start from a clean session so the keyring, extension and settings
# changes cannot be left in a half-applied state from a previous run.
if runuser -u openlink -- env "${desktop_env[@]}" systemctl --user is-active --quiet gnome-session@ubuntu.target \
  || pgrep -u openlink -x gnome-shell >/dev/null 2>&1; then
  runuser -u openlink -- env "${desktop_env[@]}" systemctl --user start gnome-session-shutdown.target >/dev/null 2>&1 || true
  for _ in $(seq 1 75); do
    if ! runuser -u openlink -- env "${desktop_env[@]}" systemctl --user is-active --quiet gnome-session@ubuntu.target \
      && ! pgrep -u openlink -x gnome-shell >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
  pkill -TERM -u openlink -x gnome-shell 2>/dev/null || true
fi

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

# Enable the Ubuntu desktop extensions plus the OpenLink headless extension.
# The latter hides the screen-sharing / screen-recording top-bar indicators:
# in T2 the RDP surface is the only display, so the indicator's stop action
# would terminate it and leave a black desktop.
extension_source=/opt/openlink/desktop/gnome-extensions/openlink-headless@openlink
extension_root=/home/openlink/.local/share/gnome-shell/extensions/openlink-headless@openlink
if [[ ! -f "$extension_source/metadata.json" || ! -f "$extension_source/extension.js" ]]; then
  echo "T2 headless GNOME extension is missing" >&2
  exit 1
fi
mkdir -p "$extension_root"
cp "$extension_source/metadata.json" "$extension_root/metadata.json"
cp "$extension_source/extension.js" "$extension_root/extension.js"
chown -R openlink:openlink "$extension_root"
chmod 0755 "$extension_root"
chmod 0644 "$extension_root/metadata.json" "$extension_root/extension.js"
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell disable-user-extensions false >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell enabled-extensions \
  "['openlink-headless@openlink','ubuntu-dock@ubuntu.com','ding@rastersoft.com','ubuntu-appindicators@ubuntu.com','tiling-assistant@ubuntu.com']" >/dev/null

# Use the familiar always-visible Ubuntu dock on the left. Ubuntu 26.10 ships
# the dock at the bottom with autohide enabled; a headless RDP user cannot
# discover it reliably, and an empty desktop looks like a stripped GNOME
# session.
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell.extensions.dash-to-dock dock-position "'LEFT'" >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell.extensions.dash-to-dock extend-height true >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell.extensions.dash-to-dock dock-fixed true >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell.extensions.dash-to-dock autohide false >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell.extensions.dash-to-dock show-apps-at-top true >/dev/null
# Use a normal Ubuntu application set. The worker userspace also carries the
# E1 Xfce/X11 tools; those entries are hidden by the base image, and the
# installer launcher is not useful on a provisioned project desktop.
runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.shell favorite-apps   "['google-chrome.desktop','org.gnome.Nautilus.desktop','org.gnome.Terminal.desktop','org.gnome.Settings.desktop','snap-store_snap-store.desktop','org.gnome.Yelp.desktop','libreoffice-writer.desktop']" >/dev/null

# Make Chrome the project browser. The image launcher forces the Wayland ozone
# backend because T2 does not start Xwayland.
runuser -u openlink -- env "${desktop_env[@]}" xdg-settings set default-web-browser google-chrome.desktop >/dev/null 2>&1 || true
runuser -u openlink -- env "${desktop_env[@]}" xdg-mime default google-chrome.desktop x-scheme-handler/http x-scheme-handler/https >/dev/null 2>&1 || true

# Use the product wallpaper set baked into the image. The light/dark pair is
# also registered with GNOME's background picker through astreusn.xml.
background_light=/usr/share/backgrounds/astreusn/astreusn-ubuntu-light-3840x2160.png
background_dark=/usr/share/backgrounds/astreusn/astreusn-ubuntu-dark-3840x2160.png
if [[ -f "$background_light" && -f "$background_dark" ]]; then
  runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.desktop.background picture-uri "file://$background_light" >/dev/null
  runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.desktop.background picture-uri-dark "file://$background_dark" >/dev/null
  runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.desktop.background picture-options "'zoom'" >/dev/null
  runuser -u openlink -- env "${desktop_env[@]}" gsettings set org.gnome.desktop.screensaver picture-uri "file://$background_dark" >/dev/null 2>&1 || true
else
  echo "T2 wallpaper assets are missing; keeping the GNOME default" >&2
fi

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

# Run the real Ubuntu session target rather than a bare gnome-shell process.
# This starts gnome-session, settings daemons, portals and the shell as one
# managed session, which is what Settings and the desktop expect.
shell_dropin_dir=/home/openlink/.config/systemd/user/org.gnome.Shell@.service.d
mkdir -p "$shell_dropin_dir"
cat >"$shell_dropin_dir/openlink-headless.conf" <<'OPENLINK_SHELL_DROPIN'
[Service]
ExecStart=
ExecStart=/usr/bin/gnome-shell --headless --no-x11 --virtual-monitor 1280x800 --mode=%i
OPENLINK_SHELL_DROPIN
chown -R openlink:openlink /home/openlink/.config/systemd/user
runuser -u openlink -- env "${desktop_env[@]}" systemctl --user set-environment \
  XDG_SESSION_TYPE=wayland \
  XDG_CURRENT_DESKTOP=ubuntu:GNOME \
  XDG_SESSION_DESKTOP=ubuntu \
  DESKTOP_SESSION=ubuntu \
  GNOME_SHELL_SESSION_MODE=ubuntu \
  LIBGL_ALWAYS_SOFTWARE=1 >/dev/null
runuser -u openlink -- env "${desktop_env[@]}" systemctl --user daemon-reload

runuser -u openlink -- env "${desktop_env[@]}" systemctl --user start gnome-session@ubuntu.target
session_ready=false
for _ in $(seq 1 150); do
  if runuser -u openlink -- env "${desktop_env[@]}" systemctl --user is-active --quiet org.gnome.Shell@ubuntu.service \
    && pgrep -u openlink -x gnome-shell >/dev/null 2>&1; then
    session_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$session_ready" != true ]]; then
  echo "T2 Ubuntu GNOME session did not start" >&2
  runuser -u openlink -- env "${desktop_env[@]}" systemctl --user status gnome-session@ubuntu.target org.gnome.Shell@ubuntu.service --no-pager -n 80 >&2 2>/dev/null || true
  exit 1
fi

# Resolve the live accessibility bus and start its registry before the bridge
# so agent-desktop sees GNOME and Chrome instead of timing out.
if command -v dbus-send >/dev/null 2>&1; then
  resolved_atspi_address="$(runuser -u openlink -- env \
    HOME=/home/openlink \
    XDG_RUNTIME_DIR=/run/user/1000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path="$desktop_bus" \
    dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress 2>/dev/null \
    | sed -n 's/.*string "\(.*\)".*/\1/p' || true)"
  if [[ -n "$resolved_atspi_address" ]]; then
    desktop_atspi_address="$resolved_atspi_address"
  fi
fi
if [[ -x /usr/libexec/at-spi2-registryd ]]; then
  pkill -u openlink -x at-spi2-registryd 2>/dev/null || true
  start_background at-spi-registry runuser -u openlink -- env \
    HOME=/home/openlink \
    XDG_RUNTIME_DIR=/run/user/1000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path="$desktop_bus" \
    AT_SPI_BUS_ADDRESS="$desktop_atspi_address" \
    /usr/libexec/at-spi2-registryd
fi

# Expose agent-desktop to session containers through a constrained socket.
# The real binary must run in this host PID namespace; the session container
# only receives a CLI client and the socket.
desktop_tool_socket=/run/user/1000/openlink-desktop-tool.sock
rm -f "$desktop_tool_socket"
start_background desktop-tool runuser -u openlink -- env "${desktop_env[@]}" \
  AT_SPI_BUS_ADDRESS="$desktop_atspi_address" \
  WAYLAND_DISPLAY=wayland-0 \
  OPENLINK_DESKTOP_TOOL_SOCKET="$desktop_tool_socket" \
  /usr/local/bin/node /opt/openlink/desktop/desktop-tool-bridge.mjs
if ! wait_for_file "$desktop_tool_socket"; then
  echo "T2 agent-desktop bridge did not start" >&2
  tail -n 80 /tmp/openlink-desktop-desktop-tool.log >&2 || true
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
rdp_pid="$(cat /tmp/openlink-desktop-rdp-bridge.pid)"
tool_pid="$(cat /tmp/openlink-desktop-desktop-tool.pid)"
while pgrep -u openlink -x gnome-shell >/dev/null 2>&1 \
  && kill -0 "$rdp_pid" 2>/dev/null \
  && kill -0 "$websockify_pid" 2>/dev/null \
  && kill -0 "$tool_pid" 2>/dev/null; do
  # The RDP server and the GNOME session are managed by systemd; require their
  # units to stay active while the bridge processes are alive.
  sleep 1
done
echo "T2 desktop component exited" >&2
exit 1

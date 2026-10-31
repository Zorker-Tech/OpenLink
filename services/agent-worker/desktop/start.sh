#!/usr/bin/env bash
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
  for _ in $(seq 1 100); do
    pgrep -u openlink -x "$process_name" >/dev/null 2>&1 && return 0
    if [[ -f "$pid_file" ]] && ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  return 1
}

configure_xfce_wallpaper() {
  local wallpaper=/usr/share/xfce4/backdrops/xubuntu-wallpaper.png
  if [[ ! -r "$wallpaper" ]]; then
    echo "Ubuntu desktop wallpaper is missing: $wallpaper" >&2
    return 1
  fi

  if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    echo "Xfce wallpaper configuration must run inside its D-Bus session" >&2
    return 1
  fi

  local property
  for property in \
    /xfce4-desktop/backdrop/screen0/monitor0/image \
    /xfce4-desktop/backdrop/screen0/monitor0/workspace-0/image; do
    xfconf-query -c xfce4-desktop -p "$property" -n -t string -s "$wallpaper"
  done
}

run_xfce_session() {
  startxfce4 &
  local xfce_launcher_pid=$!
  local started=false
  for _ in $(seq 1 100); do
    if pgrep -u openlink -x xfce4-session >/dev/null 2>&1; then
      started=true
      break
    fi
    if ! kill -0 "$xfce_launcher_pid" 2>/dev/null; then
      wait "$xfce_launcher_pid" || true
      break
    fi
    sleep 0.2
  done

  if [[ "$started" != true ]]; then
    echo "Xfce did not start" >&2
    return 1
  fi

  configure_xfce_wallpaper
  wait "$xfce_launcher_pid"
}

if [[ "${1:-}" == "--run-xfce-session" ]]; then
  run_xfce_session
  exit $?
fi

if [[ "${OPENLINK_DESKTOP_MODE:-ubuntu-container}" == "ubuntu-iso" ]]; then
  # The installer VM is a valid, observable desktop surface. Start websockify
  # up front so the chat tab can attach to the first-boot installer instead of
  # waiting (and timing out) through the whole install/golden-disk build.
  # noVNC reconnects when the installer exits and the installed VM takes over
  # the same 5900 port.
  start_background ubuntu-vm bash /opt/openlink/desktop/run-ubuntu-vm.sh
  desktop_pid_file=/tmp/openlink-desktop-ubuntu-vm.pid
  start_background websockify /usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900
  wait_for_file /tmp/openlink-ubuntu-vm-vnc.ready
else
  mkdir -p /run/user/1000 /tmp/openlink-runtime-openlink
  chown openlink:openlink /run/user/1000 /tmp/openlink-runtime-openlink
  chmod 700 /run/user/1000 /tmp/openlink-runtime-openlink

  start_background xvfb Xvfb :0 -screen 0 1280x800x24 -nolisten tcp -ac +extension RANDR
  wait_for_file /tmp/.X11-unix/X0

  start_background gnome runuser -u openlink -- env \
    HOME=/home/openlink \
    DISPLAY=:0 \
    XDG_RUNTIME_DIR=/run/user/1000 \
    XDG_SESSION_TYPE=x11 \
    XDG_CURRENT_DESKTOP=ubuntu:GNOME \
    GNOME_SHELL_SESSION_MODE=ubuntu \
    LIBGL_ALWAYS_SOFTWARE=1 \
    dbus-run-session -- gnome-session --session=ubuntu
  desktop_process_name=gnome-shell
  desktop_pid_file=/tmp/openlink-desktop-gnome.pid
  if ! wait_for_process "$desktop_process_name" "$desktop_pid_file"; then
    echo "GNOME did not start; using the Xfce desktop fallback in this sandbox" >&2
    pkill -u openlink -x gnome-session 2>/dev/null || true
    pkill -u openlink -x gnome-shell 2>/dev/null || true
    start_background xfce runuser -u openlink -- env \
      HOME=/home/openlink \
      DISPLAY=:0 \
      XDG_RUNTIME_DIR=/run/user/1000 \
      XDG_SESSION_TYPE=x11 \
      XDG_CURRENT_DESKTOP=XFCE \
      DESKTOP_SESSION=xfce \
      LIBGL_ALWAYS_SOFTWARE=1 \
      dbus-run-session -- bash /opt/openlink/desktop/start.sh --run-xfce-session
    desktop_process_name=xfce4-session
    desktop_pid_file=/tmp/openlink-desktop-xfce.pid
    if ! wait_for_process "$desktop_process_name" "$desktop_pid_file"; then
      echo "Xfce did not start; desktop session logs follow" >&2
      tail -n 80 /tmp/openlink-desktop-gnome.log /tmp/openlink-desktop-xfce.log >&2 || true
      exit 1
    fi
  fi

  sleep 1
  if ! pgrep -u openlink -x "$desktop_process_name" >/dev/null 2>&1; then
    echo "Desktop session exited during startup" >&2
    exit 1
  fi
  start_background x11vnc x11vnc -display :0 -forever -shared -rfbport 5900 -localhost -nopw -xrandr
  start_background websockify /usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900
fi

for _ in $(seq 1 30); do
  if curl --silent --fail http://127.0.0.1:6080/vnc.html >/dev/null; then break; fi
  sleep 0.2
done

websockify_pid="$(cat /tmp/openlink-desktop-websockify.pid)"
desktop_pid="$(cat "$desktop_pid_file")"
while kill -0 "$desktop_pid" 2>/dev/null && kill -0 "$websockify_pid" 2>/dev/null; do
  sleep 1
done
if ! kill -0 "$desktop_pid" 2>/dev/null; then
  echo "Desktop process exited; desktop endpoint is no longer ready" >&2
  exit 1
fi
tail --pid="$websockify_pid" -f /dev/null

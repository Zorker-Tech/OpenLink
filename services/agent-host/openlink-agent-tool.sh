#!/bin/sh
set -eu

REGISTRY="${OPENLINK_AGENT_TOOL_REGISTRY:-/var/lib/openlink/agent-tools}"
MANIFEST="$REGISTRY/manifest.tsv"
TAB=$(printf '\t')
NAME_RE='^[a-z0-9][a-z0-9._-]{0,63}$'

usage() {
  cat <<'EOF'
Usage:
  openlink-agent-tool add <name> <path> [description] [usage]
  openlink-agent-tool remove <name>
  openlink-agent-tool list
  openlink-agent-tool path
  openlink-agent-tool help

The tool file is copied into the Project VM registry, made executable inside
agent sandboxes, and recorded in manifest.tsv. Use sudo for add/remove.
EOF
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "openlink-agent-tool: run this command with sudo" >&2
    exit 1
  fi
}

validate_name() {
  if ! printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,63}$'; then
    echo "openlink-agent-tool: invalid tool name '$1'" >&2
    exit 1
  fi
}

clean_field() {
  printf '%s' "$1" | tr '\t\n' '  ' | cut -c1-300
}

lock_registry() {
  mkdir -p "$REGISTRY/bin" "$REGISTRY/tools"
  LOCK="$REGISTRY/.lock"
  i=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -gt 300 ] && { echo "openlink-agent-tool: registry is busy" >&2; exit 1; }
    sleep 0.1
  done
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM
}

write_manifest_without() {
  name=$1
  output=$2
  if [ -f "$MANIFEST" ]; then
    awk -F "$TAB" -v name="$name" '$1 != name' "$MANIFEST" > "$output"
  else
    : > "$output"
  fi
}

cmd_add() {
  [ "$#" -ge 2 ] || { usage >&2; exit 2; }
  NAME=$1
  SOURCE=$2
  DESCRIPTION=$(clean_field "${3:-}")
  USAGE=$(clean_field "${4:-}")
  validate_name "$NAME"
  require_root
  [ -e "$SOURCE" ] || { echo "openlink-agent-tool: source does not exist: $SOURCE" >&2; exit 1; }
  TARGET=$(readlink -f "$SOURCE")
  [ -f "$TARGET" ] || { echo "openlink-agent-tool: only regular files are supported: $SOURCE" >&2; exit 1; }
  BASE=$(basename "$TARGET")
  case "$BASE" in
    *[!A-Za-z0-9._+-]*) echo "openlink-agent-tool: unsupported file name '$BASE'" >&2; exit 1 ;;
  esac
  lock_registry
  mkdir -p "$REGISTRY/tools/$NAME"
  cp -f "$TARGET" "$REGISTRY/tools/$NAME/$BASE"
  chmod 0755 "$REGISTRY/tools/$NAME/$BASE"
  DIGEST=$(sha256sum "$REGISTRY/tools/$NAME/$BASE" | awk '{print $1}')
  cat > "$REGISTRY/bin/$NAME" <<EOF
#!/bin/sh
registry="\${OPENLINK_AGENT_TOOL_REGISTRY:-$REGISTRY}"
exec "\$registry/tools/$NAME/$BASE" "\$@"
EOF
  chmod 0755 "$REGISTRY/bin/$NAME"
  TEMP="$MANIFEST.$$"
  write_manifest_without "$NAME" "$TEMP"
  printf '%s\t%s\t%s\t%s\t%s\n' "$NAME" "$BASE" "$DESCRIPTION" "$USAGE" "$DIGEST" >> "$TEMP"
  sort -t "$TAB" -k1,1 "$TEMP" > "$MANIFEST"
  rm -f "$TEMP"
  echo "registered $NAME -> $REGISTRY/bin/$NAME"
}

cmd_remove() {
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  NAME=$1
  validate_name "$NAME"
  require_root
  lock_registry
  TEMP="$MANIFEST.$$"
  write_manifest_without "$NAME" "$TEMP"
  sort -t "$TAB" -k1,1 "$TEMP" > "$MANIFEST"
  rm -f "$TEMP"
  rm -f "$REGISTRY/bin/$NAME"
  rm -rf "$REGISTRY/tools/$NAME"
  echo "removed $NAME"
}

cmd_list() {
  if [ -f "$MANIFEST" ]; then
    cat "$MANIFEST"
  fi
}

case "${1:-help}" in
  add) shift; cmd_add "$@" ;;
  remove|rm) shift; cmd_remove "$@" ;;
  list|ls) cmd_list ;;
  path) echo "$REGISTRY" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac

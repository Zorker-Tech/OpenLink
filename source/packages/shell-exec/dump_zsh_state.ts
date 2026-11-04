export const ZSH_STATE_START_MARKER = "__SLATE_ZSH_STATE_START__"
export const ZSH_STATE_END_MARKER = "__SLATE_ZSH_STATE_END__"

const rawZshScript = String.raw`#!/usr/bin/env zsh

# Usage:
#   source dump_zsh_state.zsh
#   dump_zsh_state
# Or execute directly (captures a subshell's state):
#   ./dump_zsh_state.zsh

# Keep the snapshot helper local in behavior: sourcing the script does not change the caller's options.
function dump_zsh_state() {
  emulate -L zsh -o errreturn -o pipefail
  set -u

  if [[ -n "\${DUMP_ZSH_STATE_TIMING:-}" ]]; then
    typeset timing_started=\${EPOCHREALTIME}
    typeset phase_started=\${EPOCHREALTIME}
    _slate_timing() {
      typeset label="$1"
      typeset current_time=\${EPOCHREALTIME}
      typeset phase_elapsed=$((current_time - phase_started))
      typeset total_elapsed=$((current_time - timing_started))
      builtin printf "[TIMING] %-20s: %6.3fs (total: %6.3fs)\n" "$label" "$phase_elapsed" "$total_elapsed" >&2
      phase_started=$current_time
    }
  else
    _slate_timing() { :; }
  fi

  builtin zmodload -F zsh/parameter p:parameters p:options p:functions p:aliases p:galiases p:saliases 2>/dev/null || true
  _slate_timing "zmodload"

  _slate_line() {
    builtin print -r -- "$1"
  }

  _slate_encoded_block() {
    local payload="$1"
    local slot="$2"
    if [[ -n "$payload" ]]; then
      builtin printf 'slate_state_%s=$(command base64 -d <<'''SLATE_STATE_EOF_%s'''\n' "$slot" "$slot"
      command base64 <<<"$payload" | command tr -d '\n'
      builtin printf '\nSLATE_STATE_EOF_%s\n' "$slot"
      builtin printf ')\n'
      builtin printf 'eval "$slate_state_%s"\n' "$slot"
    fi
  }

  _slate_timing "helpers"
  _slate_line "__SLATE_ZSH_STATE_START__"
  _slate_line "$PWD"
  _slate_line "# shell state snapshot captured on $(command date +'%Y-%m-%d %H:%M:%S %z')"
  _slate_timing "header"
  _slate_timing "working_dir"

  local exported_state
  exported_state=$(builtin typeset -xp 2>/dev/null | command grep -viE '_proxy=|SLATE_SANDBOX|SUDO_ASKPASS|SLATE_ASKPASS|SLATE_CONVERSATION_ID|SLATE_AGENT_STORE' || true)
  _slate_encoded_block "$exported_state" "ENV_VARS_B64"
  _slate_timing "environment"

  local saved_options
  saved_options=$(setopt 2>/dev/null | command grep -vE '^(errreturn|nounset|pipefail)$' | command awk '{printf "builtin setopt %s 2>/dev/null || true\\n", $0}' || true)
  _slate_encoded_block "$saved_options" "ZSH_OPTS_B64"
  _slate_timing "options"

  local declared_functions
  declared_functions=$(builtin typeset -f 2>/dev/null || true)
  _slate_encoded_block "$declared_functions" "FUNCTIONS_B64"
  _slate_timing "functions"

  {
    builtin alias -L 2>/dev/null || true
    builtin alias -gL 2>/dev/null || true
    builtin alias -sL 2>/dev/null || true
  }
  _slate_timing "aliases"

  _slate_line "# end of zsh state snapshot"
  _slate_line "__SLATE_ZSH_STATE_END__"
  _slate_timing "finalize"
}
`

const zshScript = rawZshScript.replaceAll("\\${", "${")

export default zshScript

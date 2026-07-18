#!/usr/bin/env bash
set -euo pipefail

if [[ "${INCUS_WEB_INFO_SHOWN:-0}" == "1" || ! -t 1 ]]; then
  exit 0
fi

export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

cpu_count="$(nproc 2>/dev/null || printf '?')"
mem_line="$(free -h 2>/dev/null | awk '/^Mem:/ {print $3 " used / " $2 " total"}' || true)"
swap_line="$(free -h 2>/dev/null | awk '/^Swap:/ {print $3 " used / " $2 " total"}' || true)"
disk_line="$(df -h /workspace 2>/dev/null | awk 'NR == 2 {print $4 " free / " $2 " total (" $5 " used)"}' || true)"
home_disk_line="$(df -h "$HOME" 2>/dev/null | awk 'NR == 2 {print $4 " free / " $2 " total (" $5 " used)"}' || true)"
load_line="$(awk '{print $1 ", " $2 ", " $3}' /proc/loadavg 2>/dev/null || true)"
host_name="$(hostname 2>/dev/null || printf 'incus-web')"
identity_label=""
if [[ -r /run/incus-web/identity-label ]]; then
  identity_label="$(head -n 1 /run/incus-web/identity-label 2>/dev/null || true)"
fi
title="${identity_label:-${INCUS_WEB_WORKSPACE_LABEL:-incus-web}}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  accent=$'\033[38;2;41;182;246m'
  muted=$'\033[38;2;167;188;201m'
  value=$'\033[38;2;125;211;199m'
  warn=$'\033[38;2;198;163;107m'
  error=$'\033[38;2;199;132;144m'
  border=$'\033[38;2;28;127;172m'
  reset=$'\033[0m'
else
  accent=""
  muted=""
  value=""
  warn=""
  error=""
  border=""
  reset=""
fi

line() {
  local label="$1"
  local text="$2"
  printf '  %b%-9s%b : %b%s%b\n' "$muted" "$label" "$reset" "$value" "$text" "$reset"
}

status_text() {
  local status="$1"
  local text="$2"

  case "$status" in
    ok) printf '%bok%b %s' "$value" "$reset" "$text" ;;
    warn) printf '%bwarn%b %s' "$warn" "$reset" "$text" ;;
    *) printf '%bmissing%b %s' "$error" "$reset" "$text" ;;
  esac
}

check_commands() {
  local commands=(
    node
    npm
    python3
    go
    rustc
    cargo
    git
    gh
    zsh
    claude
    codex
    mise
    chezmoi
    incus-web-open
  )
  local missing=()
  local cmd

  for cmd in "${commands[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if ((${#missing[@]} == 0)); then
    status_text ok "all expected commands present"
  else
    status_text error "${missing[*]}"
  fi
}

check_packages() {
  local packages=(
    build-essential
    ca-certificates
    cargo
    curl
    git
    gh
    golang-go
    gnupg
    jq
    libssl-dev
    netcat-openbsd
    nodejs
    npm
    pipx
    pkg-config
    python3
    python3-pip
    python3-venv
    rustc
    sudo
    unzip
    zip
    zsh
  )
  local missing=()
  local pkg

  if ! command -v dpkg-query >/dev/null 2>&1; then
    status_text warn "dpkg-query unavailable"
    return
  fi

  for pkg in "${packages[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
      missing+=("$pkg")
    fi
  done

  if ((${#missing[@]} == 0)); then
    status_text ok "base packages installed"
  else
    status_text error "${missing[*]}"
  fi
}

check_mise() {
  local parts=()

  if command -v mise >/dev/null 2>&1; then
    parts+=("binary")
  else
    status_text warn "not installed"
    return
  fi

  [[ -f "$HOME/.config/mise/config.toml" ]] && parts+=("config")
  [[ -d "$HOME/.local/share/mise/shims" ]] && parts+=("shims")

  if ((${#parts[@]} > 1)); then
    status_text ok "${parts[*]}"
  else
    status_text warn "binary only"
  fi
}

check_dotfiles() {
  local source_dir="${HOME}/.local/share/chezmoi"
  local branch=""
  local commit=""
  local dirty=""

  if [[ ! -d "$source_dir" ]]; then
    status_text warn "not configured"
    return
  fi

  if [[ ! -d "$source_dir/.git" ]]; then
    status_text ok "source present"
    return
  fi

  branch="$(git -C "$source_dir" branch --show-current 2>/dev/null || true)"
  commit="$(git -C "$source_dir" rev-parse --short HEAD 2>/dev/null || true)"
  dirty="$(git -C "$source_dir" status --short 2>/dev/null || true)"

  if [[ -n "$dirty" ]]; then
    status_text warn "source has local changes"
  else
    status_text ok "source clean"
  fi

  [[ -z "$branch" ]] || printf ' %s' "$branch"
  [[ -z "$commit" ]] || printf ' @ %s' "$commit"
}

printf '\n'
printf '%b%s workspace%b\n' "$accent" "$title" "$reset"
printf '%b%s%b\n' "$border" "-------------------" "$reset"
line "container" "$host_name"
line "workspace" "/workspace"
line "cpu" "$cpu_count vCPU"
[[ -z "$mem_line" ]] || line "memory" "$mem_line"
[[ -z "$swap_line" ]] || line "swap" "$swap_line"
[[ -z "$disk_line" ]] || line "storage" "$disk_line"
[[ -z "$home_disk_line" ]] || line "home" "$home_disk_line"
[[ -z "$load_line" ]] || line "load" "$load_line"
printf '  %b%-9s%b : ' "$muted" "commands" "$reset"; check_commands; printf '\n'
printf '  %b%-9s%b : ' "$muted" "packages" "$reset"; check_packages; printf '\n'
printf '  %b%-9s%b : ' "$muted" "mise" "$reset"; check_mise; printf '\n'
printf '  %b%-9s%b : ' "$muted" "dotfiles" "$reset"; check_dotfiles; printf '\n'
printf '\n'

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/incus-web-lib.sh disable=SC1091
. "$ROOT/scripts/incus-web-lib.sh"

IMAGE_ALIAS="${IMAGE_ALIAS:-incus-web-agent}"
EXPORT_DIR="${EXPORT_DIR:-$ROOT/dist}"
EXPORT_NAME="${EXPORT_NAME:-$IMAGE_ALIAS}"
SMOKE_IMAGE_ALIAS="${SMOKE_IMAGE_ALIAS:-$IMAGE_ALIAS-smoke}"
SMOKE_CONTAINER_NAME="${SMOKE_CONTAINER_NAME:-incus-web-image-smoke}"
SMOKE_KEEP_CONTAINER="${SMOKE_KEEP_CONTAINER:-0}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-180}"
SMOKE_LIMIT_CPU="${SMOKE_LIMIT_CPU:-2}"
SMOKE_LIMIT_MEMORY="${SMOKE_LIMIT_MEMORY:-4GiB}"
SMOKE_LIMIT_PROCESSES="${SMOKE_LIMIT_PROCESSES:-2048}"
INCUS_NETWORK="${INCUS_NETWORK:-agentbr0}"
INCUS_NETWORK_IPV4="${INCUS_NETWORK_IPV4:-198.18.0.1/15}"
INCUS_ACL="${INCUS_ACL:-agent-block-lan}"
ENABLE_NETWORK_ACL="${ENABLE_NETWORK_ACL:-1}"
INCUS_PROFILE_NAME="${INCUS_PROFILE_NAME:-incus-web-agent}"
INCUS_PROFILE_YAML="${INCUS_PROFILE_YAML:-$ROOT/incus-web-profile.yaml}"
INCUS_WEB_SOURCE_REF="${INCUS_WEB_SOURCE_REF:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
[[ "$INCUS_WEB_SOURCE_REF" =~ ^[0-9a-f]{40}$ ]] || die "INCUS_WEB_SOURCE_REF must be an immutable 40-character commit SHA"
INCUS_PROFILE_URL="${INCUS_PROFILE_URL:-https://raw.githubusercontent.com/jmagar/incus-web/$INCUS_WEB_SOURCE_REF/incus-web-profile.yaml}"
WETTY_PORT="${WETTY_PORT:-3000}"
WEB_USER="${WEB_USER:-agent}"
HOST_WORKSPACE="${HOST_WORKSPACE:-$HOME/incus-web-data/$SMOKE_CONTAINER_NAME}"
CONTAINER_WORKSPACE="${CONTAINER_WORKSPACE:-/workspace}"
DISK_SHIFT="${DISK_SHIFT:-true}"
image_tar="$EXPORT_DIR/$EXPORT_NAME.tar.xz"

[[ -f "$image_tar" ]] || die "missing exported image tarball: $image_tar"

cleanup_smoke_container() {
  if [[ "$SMOKE_KEEP_CONTAINER" == "1" ]]; then
    log "keeping smoke container $SMOKE_CONTAINER_NAME for inspection"
    return
  fi

  log "cleaning up smoke container $SMOKE_CONTAINER_NAME"
  incus_cmd stop "$SMOKE_CONTAINER_NAME" --force >/dev/null 2>&1 || true
  incus_cmd delete "$SMOKE_CONTAINER_NAME" --force >/dev/null 2>&1 || true

  for _ in {1..10}; do
    if ! incus_cmd info "$SMOKE_CONTAINER_NAME" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  die "smoke container $SMOKE_CONTAINER_NAME still exists after cleanup"
}

timeout_container_bash() {
  local name="$1"
  shift

  if [[ "$INCUS_USE_SUDO" == "1" ]]; then
    timeout "$SMOKE_TIMEOUT" sudo incus exec "$name" -- bash -lc "$*"
  else
    timeout "$SMOKE_TIMEOUT" incus exec "$name" -- bash -lc "$*"
  fi
}

install_incus_if_needed
ensure_incus_ready
ensure_agent_network
ensure_profile_paths
ensure_incus_profile

incus_cmd delete "$SMOKE_CONTAINER_NAME" --force >/dev/null 2>&1 || true
incus_cmd image delete "$SMOKE_IMAGE_ALIAS" >/dev/null 2>&1 || true

log "importing exported image $image_tar as $SMOKE_IMAGE_ALIAS"
incus_cmd image import "$image_tar" --alias "$SMOKE_IMAGE_ALIAS"

mkdir -p "$HOST_WORKSPACE"

log "launching smoke container $SMOKE_CONTAINER_NAME"
incus_cmd init "$SMOKE_IMAGE_ALIAS" "$SMOKE_CONTAINER_NAME" \
  --profile default \
  --profile "$INCUS_PROFILE_NAME"
incus_cmd config set "$SMOKE_CONTAINER_NAME" limits.cpu "$SMOKE_LIMIT_CPU"
incus_cmd config set "$SMOKE_CONTAINER_NAME" limits.memory "$SMOKE_LIMIT_MEMORY"
incus_cmd config set "$SMOKE_CONTAINER_NAME" limits.memory.enforce hard
incus_cmd config set "$SMOKE_CONTAINER_NAME" limits.processes "$SMOKE_LIMIT_PROCESSES"
incus_cmd config device override "$SMOKE_CONTAINER_NAME" eth0 network="$INCUS_NETWORK"
incus_cmd config device override "$SMOKE_CONTAINER_NAME" workspace source="$HOST_WORKSPACE" path="$CONTAINER_WORKSPACE" shift="$DISK_SHIFT"
trap cleanup_smoke_container EXIT
incus_cmd start "$SMOKE_CONTAINER_NAME"
wait_for_running "$SMOKE_CONTAINER_NAME"

validate_container_signals "$SMOKE_CONTAINER_NAME"

log "checking distrobuilder image toolchain"
timeout_container_bash "$SMOKE_CONTAINER_NAME" "set -euo pipefail
node --version
npm --version
python3 --version
go version
rustc -V
cargo -V
git --version
gh --version
claude --version
tailscale version
su -l '$WEB_USER' -c '/usr/local/bin/agent-env codex --version'"

log "exported image smoke test passed"

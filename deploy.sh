#!/usr/bin/env bash
set -euo pipefail

INCUS_WEB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
INCUS_WEB_LIB="$INCUS_WEB_ROOT/scripts/incus-web-lib.sh"

# The immutable source ref controls every remote fallback URL, so load the
# deployment env before deriving or validating it. This also supports the
# documented curl-piped/non-git deployment path where git cannot supply HEAD.
INCUS_WEB_BOOTSTRAP_ENV_FILE="${ENV_FILE:-.env}"
if [[ -f "$INCUS_WEB_BOOTSTRAP_ENV_FILE" ]]; then
  printf '[incus-web] loading %s\n' "$INCUS_WEB_BOOTSTRAP_ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$INCUS_WEB_BOOTSTRAP_ENV_FILE"
  set +a
  INCUS_WEB_BOOTSTRAP_ENV_LOADED=1
fi
INCUS_WEB_SOURCE_REF="${INCUS_WEB_SOURCE_REF:-$(git -C "$INCUS_WEB_ROOT" rev-parse HEAD 2>/dev/null || true)}"
if [[ ! "$INCUS_WEB_SOURCE_REF" =~ ^[0-9a-f]{40}$ ]]; then
  printf '[incus-web] error: INCUS_WEB_SOURCE_REF must be an immutable 40-character commit SHA\n' >&2
  exit 1
fi
INCUS_WEB_RAW_BASE="https://raw.githubusercontent.com/jmagar/incus-web/$INCUS_WEB_SOURCE_REF"
INCUS_WEB_LIB_URL="${INCUS_WEB_LIB_URL:-$INCUS_WEB_RAW_BASE/scripts/incus-web-lib.sh}"

if [[ -f "$INCUS_WEB_LIB" ]]; then
  # shellcheck disable=SC1090 # resolved from this checkout at runtime
  . "$INCUS_WEB_LIB"
else
  INCUS_WEB_LIB_TMP="$(mktemp)"
  curl -fsSL "$INCUS_WEB_LIB_URL" -o "$INCUS_WEB_LIB_TMP"
  # shellcheck disable=SC1090
  . "$INCUS_WEB_LIB_TMP"
fi

main() {
  [[ "${INCUS_WEB_BOOTSTRAP_ENV_LOADED:-0}" == "1" ]] || load_env

  CONTAINER_NAME="${CONTAINER_NAME:-incus-web}"
  IMAGE="${IMAGE:-images:debian/trixie}"
  RECREATE="${FORCE_RECREATE:-${RECREATE:-0}}"
  INCUS_NETWORK="${INCUS_NETWORK:-agentbr0}"
  INCUS_NETWORK_IPV4="${INCUS_NETWORK_IPV4:-198.18.0.1/15}"
  INCUS_ACL="${INCUS_ACL:-agent-block-lan}"
  ENABLE_NETWORK_ACL="${ENABLE_NETWORK_ACL:-1}"
  INCUS_PROFILE_NAME="${INCUS_PROFILE_NAME:-incus-web-agent}"
  INCUS_PROFILE_YAML="${INCUS_PROFILE_YAML:-$SCRIPT_DIR/incus-web-profile.yaml}"
  INCUS_PROFILE_URL="${INCUS_PROFILE_URL:-$INCUS_WEB_RAW_BASE/incus-web-profile.yaml}"
  ACCESS_MODE="${ACCESS_MODE:-tailscale}"
  INCUS_WEB_ALLOW_NO_ACCESS="${INCUS_WEB_ALLOW_NO_ACCESS:-0}"
  TS_HOSTNAME="${TS_HOSTNAME:-$CONTAINER_NAME}"
  TS_EXTRA_ARGS="${TS_EXTRA_ARGS:---accept-routes=false}"
  TAILSCALE_SERVE_PORT="${TAILSCALE_SERVE_PORT:-443}"
  PUBLIC_URL="${PUBLIC_URL:-}"
  OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-}"
  OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-}"
  OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-}"
  OIDC_COOKIE_SECRET="${OIDC_COOKIE_SECRET:-}"
  OIDC_EMAIL_DOMAINS="${OIDC_EMAIL_DOMAINS:-*}"
  OIDC_ALLOWED_EMAILS="${OIDC_ALLOWED_EMAILS:-}"
  OIDC_PROVIDER_DISPLAY_NAME="${OIDC_PROVIDER_DISPLAY_NAME:-OIDC}"
  OIDC_PROXY_PORT="${OIDC_PROXY_PORT:-4180}"
  OIDC_HOST_BIND="${OIDC_HOST_BIND:-127.0.0.1}"
  OIDC_HOST_PORT="${OIDC_HOST_PORT:-}"
  OIDC_COOKIE_SECURE="${OIDC_COOKIE_SECURE:-true}"
  OIDC_REVERSE_PROXY="${OIDC_REVERSE_PROXY:-true}"
  OIDC_SKIP_PROVIDER_BUTTON="${OIDC_SKIP_PROVIDER_BUTTON:-true}"
  OIDC_COOKIE_REFRESH="${OIDC_COOKIE_REFRESH:-1h}"
  OIDC_COOKIE_EXPIRE="${OIDC_COOKIE_EXPIRE:-8h}"
  OAUTH2_PROXY_VERSION="${OAUTH2_PROXY_VERSION:-v7.15.3}"
  TERMINAL_BACKEND="${TERMINAL_BACKEND:-wetty}"
  GHOSTTY_WEB_DEMO_VERSION="${GHOSTTY_WEB_DEMO_VERSION:-0.4.0-next.20.g1858a59}"
  CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.212}"
  CODEX_VERSION="${CODEX_VERSION:-0.144.3}"
  WETTY_VERSION="${WETTY_VERSION:-3.2.0}"
  TAILSCALE_VERSION="${TAILSCALE_VERSION:-1.98.8}"
  SETUP_PORT="${SETUP_PORT:-3080}"
  SETUP_ENABLED="${SETUP_ENABLED:-1}"
  SETUP_ALLOWED_EMAILS="${SETUP_ALLOWED_EMAILS:-$OIDC_ALLOWED_EMAILS}"
  SETUP_ALLOW_KEY_PERSISTENCE="${SETUP_ALLOW_KEY_PERSISTENCE:-0}"
  SETUP_COMMAND_TIMEOUT_MS="${SETUP_COMMAND_TIMEOUT_MS:-1200000}"
  IDENTITY_PROXY_PORT="${IDENTITY_PROXY_PORT:-3090}"
  INCUS_WEB_BOOTSTRAP_SERVER="${INCUS_WEB_BOOTSTRAP_SERVER:-$SCRIPT_DIR/scripts/bootstrap-server.mjs}"
  INCUS_WEB_BOOTSTRAP_SERVER_URL="${INCUS_WEB_BOOTSTRAP_SERVER_URL:-$INCUS_WEB_RAW_BASE/scripts/bootstrap-server.mjs}"
  INCUS_WEB_IDENTITY_PROXY="${INCUS_WEB_IDENTITY_PROXY:-$SCRIPT_DIR/scripts/identity-proxy.mjs}"
  INCUS_WEB_IDENTITY_PROXY_URL="${INCUS_WEB_IDENTITY_PROXY_URL:-$INCUS_WEB_RAW_BASE/scripts/identity-proxy.mjs}"
  INCUS_WEB_GHOSTTY_AURORA_PATCH="${INCUS_WEB_GHOSTTY_AURORA_PATCH:-$SCRIPT_DIR/scripts/ghostty-aurora-patch.mjs}"
  INCUS_WEB_GHOSTTY_AURORA_PATCH_URL="${INCUS_WEB_GHOSTTY_AURORA_PATCH_URL:-$INCUS_WEB_RAW_BASE/scripts/ghostty-aurora-patch.mjs}"
  INCUS_WEB_CONTAINER_PROVISION_PROGRAM="${INCUS_WEB_CONTAINER_PROVISION_PROGRAM:-$SCRIPT_DIR/scripts/container-provision.sh}"
  INCUS_WEB_CONTAINER_PROVISION_PROGRAM_URL="${INCUS_WEB_CONTAINER_PROVISION_PROGRAM_URL:-$INCUS_WEB_RAW_BASE/scripts/container-provision.sh}"
  ENABLE_HOST_PROVISIONER="${ENABLE_HOST_PROVISIONER:-1}"
  INCUS_WEB_PROVISIONER_SERVER="${INCUS_WEB_PROVISIONER_SERVER:-$SCRIPT_DIR/scripts/provisioner-server.mjs}"
  INCUS_WEB_PROVISIONER_SERVER_URL="${INCUS_WEB_PROVISIONER_SERVER_URL:-$INCUS_WEB_RAW_BASE/scripts/provisioner-server.mjs}"
  INCUS_WEB_PROVISIONER_INSTALL_PATH="${INCUS_WEB_PROVISIONER_INSTALL_PATH:-/usr/local/lib/incus-web/provisioner-server.mjs}"
  INCUS_WEB_PROVISIONER_AGENT_RUNS="${INCUS_WEB_PROVISIONER_AGENT_RUNS:-$SCRIPT_DIR/scripts/agent-runs.mjs}"
  INCUS_WEB_PROVISIONER_AGENT_RUNS_URL="${INCUS_WEB_PROVISIONER_AGENT_RUNS_URL:-$INCUS_WEB_RAW_BASE/scripts/agent-runs.mjs}"
  INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH="${INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH:-/usr/local/lib/incus-web/agent-runs.mjs}"
  INCUS_WEB_PROVISIONER_SERVICE_AUTH="${INCUS_WEB_PROVISIONER_SERVICE_AUTH:-$SCRIPT_DIR/scripts/service-auth.mjs}"
  INCUS_WEB_PROVISIONER_SERVICE_AUTH_URL="${INCUS_WEB_PROVISIONER_SERVICE_AUTH_URL:-$INCUS_WEB_RAW_BASE/scripts/service-auth.mjs}"
  INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH="${INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH:-/usr/local/lib/incus-web/service-auth.mjs}"
  ENABLE_BUILD_WORKER="${ENABLE_BUILD_WORKER:-0}"
  INCUS_WEB_BUILD_WORKER_SERVER="${INCUS_WEB_BUILD_WORKER_SERVER:-$SCRIPT_DIR/scripts/build-worker.mjs}"
  INCUS_WEB_BUILD_WORKER_SERVER_URL="${INCUS_WEB_BUILD_WORKER_SERVER_URL:-$INCUS_WEB_RAW_BASE/scripts/build-worker.mjs}"
  INCUS_WEB_BUILD_WORKER_INSTALL_PATH="${INCUS_WEB_BUILD_WORKER_INSTALL_PATH:-/usr/local/lib/incus-web/build-worker.mjs}"
  INCUS_WEB_BUILD_WORKER_ENV_FILE="${INCUS_WEB_BUILD_WORKER_ENV_FILE:-/etc/incus-web/build-worker.env}"
  INCUS_WEB_BUILD_WORKER_TOKEN_FILE="${INCUS_WEB_BUILD_WORKER_TOKEN_FILE:-/etc/incus-web/build-worker.token}"
  INCUS_WEB_BUILD_WORKER_SOCKET="${INCUS_WEB_BUILD_WORKER_SOCKET:-/run/incus-web/build-worker.sock}"
  INCUS_WEB_BUILD_WORKER_SOCKET_MODE="${INCUS_WEB_BUILD_WORKER_SOCKET_MODE:-0660}"
  INCUS_WEB_BUILD_WORKER_USER="${INCUS_WEB_BUILD_WORKER_USER:-incus-web-builder}"
  INCUS_WEB_BUILD_WORKER_STATE_DIR="${INCUS_WEB_BUILD_WORKER_STATE_DIR:-/var/lib/incus-web/build-worker}"
  INCUS_WEB_PROVISIONER_ENV_FILE="${INCUS_WEB_PROVISIONER_ENV_FILE:-/etc/incus-web/provisioner.env}"
  INCUS_WEB_PROVISIONER_TOKEN_FILE="${INCUS_WEB_PROVISIONER_TOKEN_FILE:-/etc/incus-web/provisioner.token}"
  INCUS_WEB_PROVISIONER_SOCKET="${INCUS_WEB_PROVISIONER_SOCKET:-/run/incus-web/provisioner.sock}"
  INCUS_WEB_PROVISIONER_SOCKET_MODE="${INCUS_WEB_PROVISIONER_SOCKET_MODE:-0660}"
  ENABLE_CODEX_APP_SERVER="${ENABLE_CODEX_APP_SERVER:-$ENABLE_HOST_PROVISIONER}"
  INCUS_WEB_CODEX_APP_SERVER_USER="${INCUS_WEB_CODEX_APP_SERVER_USER:-${SUDO_USER:-$(id -un)}}"
  INCUS_WEB_CODEX_APP_SERVER_HOST="${INCUS_WEB_CODEX_APP_SERVER_HOST:-127.0.0.1}"
  INCUS_WEB_CODEX_APP_SERVER_PORT="${INCUS_WEB_CODEX_APP_SERVER_PORT:-4500}"
  INCUS_WEB_CODEX_APP_SERVER_URL="${INCUS_WEB_CODEX_APP_SERVER_URL:-ws://$INCUS_WEB_CODEX_APP_SERVER_HOST:$INCUS_WEB_CODEX_APP_SERVER_PORT}"
  INCUS_WEB_CODEX_APP_SERVER_COMMAND="${INCUS_WEB_CODEX_APP_SERVER_COMMAND:-}"
  INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS="${INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS:-43200000}"
  INCUS_WEB_CODEX_MODEL="${INCUS_WEB_CODEX_MODEL:-}"
  # Per-command timeout for each individual `incus` CLI invocation the
  # provisioner shells out to, and the overall HTTP request timeout for
  # fully-synchronous commands. Golden-container cloning is expected to
  # run on a COW-capable storage pool (see scripts/build-agent-golden.sh),
  # where clones are fast but the `incus copy` CLI can still take up to a
  # couple of minutes to report completion after the data is ready --
  # these defaults were sized from that observed behavior, not the
  # multi-minute-plus copies a plain `dir` storage pool would require.
  INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS="${INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS:-180000}"
  INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS="${INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS:-200000}"
  INCUS_WEB_PROVISIONER_TIMEOUT_MS="${INCUS_WEB_PROVISIONER_TIMEOUT_MS:-$((INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS + 5000))}"
  INCUS_WEB_PROVISIONER_USER="${INCUS_WEB_PROVISIONER_USER:-incus-web-provisioner}"
  INCUS_WEB_PROVISIONER_GROUP="${INCUS_WEB_PROVISIONER_GROUP:-incus-web}"
  INCUS_WEB_PROVISIONER_INCUS_GROUP="${INCUS_WEB_PROVISIONER_INCUS_GROUP:-incus-admin}"
  INCUS_WEB_GOLDEN_CONFIG_DIR="${INCUS_WEB_GOLDEN_CONFIG_DIR:-/var/lib/incus-web/golden-config}"
  INCUS_WEB_PROVISIONER_NODE="${INCUS_WEB_PROVISIONER_NODE:-/usr/bin/node}"
  INCUS_WEB_APP_NPM="${INCUS_WEB_APP_NPM:-/usr/bin/npm}"
  ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD="${ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD:-0}"
  INCUS_WEB_APP_DIR="${INCUS_WEB_APP_DIR:-$SCRIPT_DIR/apps/web}"
  if [[ -z "${ENABLE_HOST_WEB_APP:-}" ]]; then
    if [[ -f "$INCUS_WEB_APP_DIR/package.json" ]]; then
      ENABLE_HOST_WEB_APP=1
    else
      ENABLE_HOST_WEB_APP=0
    fi
  fi
  INCUS_WEB_APP_ENV_FILE="${INCUS_WEB_APP_ENV_FILE:-/etc/incus-web/web.env}"
  INCUS_WEB_APP_USER="${INCUS_WEB_APP_USER:-incus-web-app}"
  INCUS_WEB_WORKSPACE_STATE_DB="${INCUS_WEB_WORKSPACE_STATE_DB:-/var/lib/incus-web-app/workspace-state.sqlite3}"
  INCUS_WEB_APP_HOST="${INCUS_WEB_APP_HOST:-$OIDC_HOST_BIND}"
  INCUS_WEB_APP_PORT="${INCUS_WEB_APP_PORT:-3090}"
  INCUS_WEB_WORKSPACE_OWNER_MODE="${INCUS_WEB_WORKSPACE_OWNER_MODE:-none}"
  INCUS_WEB_ALLOW_SHARED_PROTOTYPE="${INCUS_WEB_ALLOW_SHARED_PROTOTYPE:-0}"
  INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION="${INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION:-0}"
  INCUS_WEB_TERMINAL_URL="${INCUS_WEB_TERMINAL_URL:-}"
  INCUS_WEB_TRUSTED_PROXY_SECRET="${INCUS_WEB_TRUSTED_PROXY_SECRET:-}"
  INCUS_WEB_WORKSPACE_ID="${INCUS_WEB_WORKSPACE_ID:-workspace-incus-web}"
  INCUS_WEB_INCUS_PROJECT="${INCUS_WEB_INCUS_PROJECT:-${INCUS_PROJECT:-}}"
  INCUS_WEB_INCUS_CONTAINER="${INCUS_WEB_INCUS_CONTAINER:-$CONTAINER_NAME}"
  INCUS_WEB_INFO_SCRIPT="${INCUS_WEB_INFO_SCRIPT:-$SCRIPT_DIR/scripts/incus-web-info.sh}"
  INCUS_WEB_INFO_SCRIPT_URL="${INCUS_WEB_INFO_SCRIPT_URL:-$INCUS_WEB_RAW_BASE/scripts/incus-web-info.sh}"
  INCUS_WEB_OPEN_SCRIPT="${INCUS_WEB_OPEN_SCRIPT:-$SCRIPT_DIR/scripts/incus-web-open.sh}"
  INCUS_WEB_OPEN_SCRIPT_URL="${INCUS_WEB_OPEN_SCRIPT_URL:-$INCUS_WEB_RAW_BASE/scripts/incus-web-open.sh}"
  WETTY_PORT="${WETTY_PORT:-3000}"
  WEB_USER="${WEB_USER:-agent}"
  INCUS_WEB_WORKSPACE_LABEL="${INCUS_WEB_WORKSPACE_LABEL:-}"
  if [[ -z "$INCUS_WEB_WORKSPACE_LABEL" && -n "$OIDC_ALLOWED_EMAILS" && "$OIDC_ALLOWED_EMAILS" != *","* && "$OIDC_ALLOWED_EMAILS" != *" "* ]]; then
    INCUS_WEB_WORKSPACE_LABEL="$OIDC_ALLOWED_EMAILS"
  fi
  DOTFILES_REPO="${DOTFILES_REPO:-}"
  DOTFILES_SOURCE_DIR="${DOTFILES_SOURCE_DIR:-}"
  DOTFILES_AGE_KEY_FILE="${DOTFILES_AGE_KEY_FILE:-}"
  DOTFILES_RUN_MISE="${DOTFILES_RUN_MISE:-0}"
  DOTFILES_SKIP_APT="${DOTFILES_SKIP_APT:-1}"
  HOST_WORKSPACE="${HOST_WORKSPACE:-$HOME/incus-web-data/$CONTAINER_NAME}"
  CONTAINER_WORKSPACE="${CONTAINER_WORKSPACE:-/workspace}"
  DISK_SHIFT="${DISK_SHIFT:-true}"

  case "$ACCESS_MODE" in
    tailscale)
      require_var TS_AUTHKEY
      ;;
    oidc)
      require_var PUBLIC_URL
      require_var OIDC_ISSUER_URL
      require_var OIDC_CLIENT_ID
      require_var OIDC_CLIENT_SECRET
      ;;
    none)
      [[ "$INCUS_WEB_ALLOW_NO_ACCESS" == "1" ]] || die "ACCESS_MODE=none is reserved for isolated CI smoke tests; set INCUS_WEB_ALLOW_NO_ACCESS=1 explicitly"
      ;;
    *)
      die "ACCESS_MODE must be tailscale, oidc, or explicitly authorized none"
      ;;
  esac

  case "$TERMINAL_BACKEND" in
    wetty|ghostty-web)
      ;;
    *)
      die "TERMINAL_BACKEND must be wetty or ghostty-web"
      ;;
  esac

  if [[ "$ENABLE_HOST_WEB_APP" == "1" && "$ENABLE_HOST_PROVISIONER" != "1" ]]; then
    die "ENABLE_HOST_WEB_APP=1 requires ENABLE_HOST_PROVISIONER=1 because the app reads the host provisioner env"
  fi
  if [[ "$ENABLE_HOST_WEB_APP" == "1" && "$INCUS_WEB_APP_USER" == "root" ]]; then
    die "INCUS_WEB_APP_USER must be an existing unprivileged user, not root"
  fi

  install_incus_if_needed
  ensure_incus_ready
  if [[ -z "$INCUS_WEB_INCUS_PROJECT" ]]; then
    INCUS_WEB_INCUS_PROJECT="$(active_incus_project)"
  fi
  ensure_agent_network
  ensure_profile_paths
  ensure_incus_profile

  local rollback_container=""
  if incus_cmd list "$CONTAINER_NAME" --format csv -c n | grep -qx "$CONTAINER_NAME"; then
    if [[ "$RECREATE" == "1" ]]; then
      rollback_container="${CONTAINER_NAME}-rollback-$(date +%Y%m%d%H%M%S)"
      log "preserving existing container as $rollback_container until replacement validation"
      incus_cmd stop "$CONTAINER_NAME" --force >/dev/null 2>&1 || true
      incus_cmd move "$CONTAINER_NAME" "$rollback_container"
      rollback_redeploy() {
        local exit_status=$?
        trap - EXIT INT TERM
        if [[ $exit_status -ne 0 && -n "${rollback_container:-}" ]]; then
          incus_cmd delete "$CONTAINER_NAME" --force >/dev/null 2>&1 || true
          incus_cmd move "$rollback_container" "$CONTAINER_NAME" >/dev/null 2>&1 || true
          incus_cmd start "$CONTAINER_NAME" >/dev/null 2>&1 || true
        fi
        exit "$exit_status"
      }
      trap rollback_redeploy EXIT INT TERM
    else
      log "reusing existing container $CONTAINER_NAME"
      wait_for_running "$CONTAINER_NAME"
      wait_for_network "$CONTAINER_NAME"
      provision_container "$CONTAINER_NAME"
      configure_access "$CONTAINER_NAME"
      validate_container "$CONTAINER_NAME"
      configure_host_provisioner "$CONTAINER_NAME"
      configure_build_worker
      configure_host_web_app
      log_deploy_summary
      return
    fi
  fi

  log "creating host workspace $HOST_WORKSPACE"
  mkdir -p "$HOST_WORKSPACE"

  log "creating $CONTAINER_NAME from $IMAGE"
  incus_cmd init "$IMAGE" "$CONTAINER_NAME" \
    --profile default \
    --profile "$INCUS_PROFILE_NAME"

  log "applying runtime device overrides"
  incus_cmd config device override "$CONTAINER_NAME" eth0 network="$INCUS_NETWORK"
  incus_cmd config device override "$CONTAINER_NAME" workspace source="$HOST_WORKSPACE" path="$CONTAINER_WORKSPACE" shift="$DISK_SHIFT"

  log "starting $CONTAINER_NAME"
  incus_cmd start "$CONTAINER_NAME"
  wait_for_running "$CONTAINER_NAME"

  wait_for_network "$CONTAINER_NAME"
  provision_container "$CONTAINER_NAME"
  configure_access "$CONTAINER_NAME"
  validate_container "$CONTAINER_NAME"
  configure_host_provisioner "$CONTAINER_NAME"
  configure_build_worker
  configure_host_web_app

  if [[ -n "$rollback_container" ]]; then
    log "replacement validated; rollback container retained as $rollback_container"
    trap - EXIT INT TERM
  fi

  log_deploy_summary
}

log_deploy_summary() {
  log "ready"
  log "container: $CONTAINER_NAME"
  log "workspace: $HOST_WORKSPACE -> $CONTAINER_WORKSPACE"
  log "access mode: $ACCESS_MODE"
  [[ "$ACCESS_MODE" == "tailscale" ]] && log "tailnet host: $TS_HOSTNAME"
  [[ "$ACCESS_MODE" == "oidc" ]] && log "public URL: $PUBLIC_URL"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

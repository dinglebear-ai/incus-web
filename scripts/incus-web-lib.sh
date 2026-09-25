#!/usr/bin/env bash
# shellcheck disable=SC2086 # controlled outer-shell interpolation into the container provisioning program
set -euo pipefail

INCUS_WEB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck disable=SC2034
SCRIPT_DIR="${INCUS_WEB_ROOT:-$(cd "$INCUS_WEB_LIB_DIR/.." && pwd)}"

log() {
  printf '[incus-web] %s\n' "$*"
}

die() {
  printf '[incus-web] error: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

load_env() {
  local env_file="${ENV_FILE:-.env}"
  if [[ -f "$env_file" ]]; then
    log "loading $env_file"
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]] || die "$name is required. Create .env from .env.example or export $name."
}

sudo_cmd() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_incus_if_needed() {
  if have incus; then
    return
  fi

  have apt-get || die "incus is not installed and this script only knows how to install it with apt-get"
  have sudo || [[ "$(id -u)" -eq 0 ]] || die "sudo is required to install incus"

  log "installing incus"
  sudo_cmd apt-get update
  sudo_cmd apt-get install -y incus uidmap squashfs-tools
}

INCUS_USE_SUDO=0

# `incus` subcommands that can accept a full YAML/text object (create,
# edit, launch, and similar) will block reading from stdin until EOF
# whenever stdin isn't explicitly closed -- even when the command line
# already fully specifies everything and nothing was meant to be piped in.
# This is confirmed, maintainer-explained upstream behavior, not
# incus-web-specific: https://github.com/lxc/incus/issues/1467. Redirecting
# from /dev/null here closes that door for every call site that goes
# through this wrapper, which is all of them except the two below that
# deliberately feed real content via incus_cmd_stdin.
incus_cmd() {
  if [[ "$INCUS_USE_SUDO" == "1" ]]; then
    sudo incus "$@" </dev/null
  else
    incus "$@" </dev/null
  fi
}

# For the rare commands that legitimately consume YAML/text via stdin
# (`profile edit <file`, `network acl edit <<EOF`). Routing these through
# the default incus_cmd would break them -- its </dev/null always wins
# over whatever the caller redirected in, since it's attached directly to
# the incus invocation inside the function body, not to the wrapper call.
incus_cmd_stdin() {
  if [[ "$INCUS_USE_SUDO" == "1" ]]; then
    sudo incus "$@"
  else
    incus "$@"
  fi
}

active_incus_project() {
  local current=""

  if [[ -n "${INCUS_PROJECT:-}" ]]; then
    printf '%s\n' "$INCUS_PROJECT"
    return
  fi

  current="$(incus_cmd project get-current 2>/dev/null || true)"
  if [[ -n "$current" ]]; then
    printf '%s\n' "$current"
    return
  fi

  printf 'default\n'
}

ensure_incus_ready() {
  if incus version >/dev/null 2>&1; then
    return
  fi

  if have sudo && sudo incus version >/dev/null 2>&1; then
    INCUS_USE_SUDO=1
    return
  fi

  have sudo || [[ "$(id -u)" -eq 0 ]] || die "incus is installed but not usable by this user; add the user to incus-admin or run with sudo"

  log "initializing incus with minimal defaults"
  sudo_cmd incus admin init --minimal

  if sudo_cmd incus version >/dev/null 2>&1; then
    INCUS_USE_SUDO=1
    return
  fi

  die "incus did not become usable after initialization"
}

ensure_agent_network() {
  if [[ "$ENABLE_NETWORK_ACL" != "1" ]]; then
    return
  fi

  if ! incus_cmd network acl show "$INCUS_ACL" >/dev/null 2>&1; then
    log "creating Incus network ACL $INCUS_ACL"
    incus_cmd network acl create "$INCUS_ACL"
  fi

  incus_cmd_stdin network acl edit "$INCUS_ACL" <<EOF
name: $INCUS_ACL
description: "Deny egress from incus-web agent containers to local/LAN ranges while allowing Internet."
egress:
  - action: reject
    state: enabled
    description: "Block RFC1918 private LAN ranges"
    destination: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  - action: reject
    state: enabled
    description: "Block IPv4 link-local"
    destination: 169.254.0.0/16
ingress: []
config: {}
EOF

  if ! incus_cmd network show "$INCUS_NETWORK" >/dev/null 2>&1; then
    log "creating Incus bridge $INCUS_NETWORK"
    incus_cmd network create "$INCUS_NETWORK" \
      --type=bridge \
      "ipv4.address=$INCUS_NETWORK_IPV4" \
      ipv4.nat=true \
      ipv6.address=none \
      ipv6.nat=false
  fi

  log "applying $INCUS_ACL to $INCUS_NETWORK"
  incus_cmd network set "$INCUS_NETWORK" security.acls="$INCUS_ACL"
  incus_cmd network set "$INCUS_NETWORK" security.acls.default.egress.action=allow
  incus_cmd network set "$INCUS_NETWORK" security.acls.default.ingress.action=drop
}

resolve_profile_yaml() {
  if [[ -f "$INCUS_PROFILE_YAML" ]]; then
    return
  fi

  log "downloading Incus profile YAML from $INCUS_PROFILE_URL"
  INCUS_PROFILE_YAML="$(mktemp)"
  curl -fsSL "$INCUS_PROFILE_URL" -o "$INCUS_PROFILE_YAML"
}

ensure_incus_profile() {
  resolve_profile_yaml

  # shellcheck disable=SC2153
  if ! incus_cmd profile show "$INCUS_PROFILE_NAME" >/dev/null 2>&1; then
    log "creating Incus profile $INCUS_PROFILE_NAME"
    incus_cmd profile create "$INCUS_PROFILE_NAME"
  fi

  log "applying Incus profile source of truth $INCUS_PROFILE_YAML"
  incus_cmd_stdin profile edit "$INCUS_PROFILE_NAME" <"$INCUS_PROFILE_YAML"
}

ensure_profile_paths() {
  sudo_cmd install -d -m 755 /srv/incus-web/default-workspace
}

wait_for_running() {
  local name="$1"
  local state=""

  for _ in $(seq 1 90); do
    state="$(incus_cmd info "$name" 2>/dev/null | awk -F': ' '$1 == "Status" {print $2; exit}' || true)"
    if [[ "$state" == "RUNNING" ]]; then
      return
    fi
    sleep 1
  done

  die "$name did not reach RUNNING state"
}

wait_for_network() {
  local name="$1"

  for _ in $(seq 1 45); do
    if incus_cmd exec "$name" -- getent hosts deb.debian.org >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  log "$name does not have DHCP/DNS yet; trying static IPv4 fallback"
  configure_static_ipv4 "$name"

  for _ in $(seq 1 30); do
    if incus_cmd exec "$name" -- getent hosts deb.debian.org >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  die "$name does not have working DNS/network access"
}

prefix_len_to_netmask() {
  local bits="$1"
  local mask=""
  local value

  for value in 1 2 3 4; do
    if (( bits >= 8 )); then
      mask="${mask}255"
      bits=$((bits - 8))
    elif (( bits > 0 )); then
      mask="${mask}$((256 - (1 << (8 - bits))))"
      bits=0
    else
      mask="${mask}0"
    fi
    [[ "$value" == "4" ]] || mask="${mask}."
  done

  printf '%s\n' "$mask"
}

pick_static_ipv4() {
  local bridge_cidr="$1"
  local gateway="${bridge_cidr%/*}"
  local prefix="${gateway%.*}"
  local seed
  local candidate

  if [[ -n "${CONTAINER_IPV4:-}" ]]; then
    printf '%s\n' "$CONTAINER_IPV4"
    return
  fi

  seed="$(printf '%s' "$CONTAINER_NAME" | cksum | awk '{print $1}')"
  for offset in $(seq 0 149); do
    candidate="${prefix}.$((50 + ((seed + offset) % 150)))"
    if ! ping -c 1 -W 1 "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  die "could not find an unused IPv4 address on $INCUS_NETWORK; set CONTAINER_IPV4 in .env"
}

configure_static_ipv4() {
  local name="$1"
  local bridge_cidr
  local gateway
  local prefix_len
  local ipv4

  bridge_cidr="$(incus_cmd network get "$INCUS_NETWORK" ipv4.address 2>/dev/null || true)"
  [[ -n "$bridge_cidr" && "$bridge_cidr" != "none" && "$bridge_cidr" == */* ]] || die "could not read ipv4.address from Incus network $INCUS_NETWORK"

  gateway="${bridge_cidr%/*}"
  prefix_len="${bridge_cidr#*/}"
  ipv4="$(pick_static_ipv4 "$bridge_cidr")"

  log "configuring $name with static IPv4 $ipv4/$prefix_len via $gateway"
  incus_cmd config device set "$name" eth0 ipv4.address "$ipv4" >/dev/null 2>&1 || true
  container_bash "$name" "set -euo pipefail
cat >/etc/systemd/network/10-incus-web-eth0.network <<EOF
[Match]
Name=eth0

[Network]
Address=$ipv4/$prefix_len
Gateway=$gateway
DNS=$gateway
IPv6AcceptRA=yes
EOF
ip addr flush dev eth0 || true
ip addr add '$ipv4/$prefix_len' dev eth0
ip link set eth0 up
ip route replace default via '$gateway' dev eth0
printf 'nameserver $gateway\n' >/etc/resolv.conf"
}

container_bash() {
  local name="$1"
  shift
  incus_cmd exec "$name" -- bash -lc "$*"
}

validate_container_signals() {
  local name="$1"

  log "validating container signal delivery"
  # This script is evaluated inside the container; keep expansions there.
  # shellcheck disable=SC2016,SC2086
  container_bash "$name" 'set -euo pipefail
kill -0 $$
sleep 300 &
child="$!"
kill -0 "$child"
kill "$child"
wait "$child" 2>/dev/null || status="$?"
case "${status:-0}" in
  0|143)
    ;;
  *)
    printf "child exited with unexpected status %s\n" "$status" >&2
    exit 1
    ;;
esac
if command -v systemctl >/dev/null 2>&1 &&
  [[ -d /run/systemd/system ]] &&
  systemctl list-units >/dev/null 2>&1; then
  cat >/etc/systemd/system/incus-web-signal-smoke.service <<EOF
[Unit]
Description=incus-web signal smoke test

[Service]
Type=simple
ExecStart=/bin/sleep 300
EOF
  systemctl daemon-reload
  systemctl start incus-web-signal-smoke.service
  systemctl stop incus-web-signal-smoke.service
  if pgrep -f "^/bin/sleep 300$" >/dev/null; then
    systemctl reset-failed incus-web-signal-smoke.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/incus-web-signal-smoke.service
    systemctl daemon-reload
    exit 1
  fi
  systemctl reset-failed incus-web-signal-smoke.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/incus-web-signal-smoke.service
  systemctl daemon-reload
fi'
}

push_tailscale_env() {
  local name="$1"
  local tmp_file

  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  {
    printf 'TS_AUTHKEY=%q\n' "$TS_AUTHKEY"
    printf 'TS_HOSTNAME=%q\n' "$TS_HOSTNAME"
    printf 'TS_EXTRA_ARGS=%q\n' "$TS_EXTRA_ARGS"
    printf 'TAILSCALE_SERVE_PORT=%q\n' "$TAILSCALE_SERVE_PORT"
    printf 'WETTY_PORT=%q\n' "$WETTY_PORT"
  } >"$tmp_file"

  incus_cmd exec "$name" -- install -d -m 700 /etc/incus-web
  incus_cmd file push "$tmp_file" "$name/etc/incus-web/tailscale.env"
  incus_cmd exec "$name" -- chmod 600 /etc/incus-web/tailscale.env
  rm -f "$tmp_file"
}

push_oidc_env() {
  local name="$1"
  local tmp_file
  local tmp_emails_file=""
  local cookie_secret="$OIDC_COOKIE_SECRET"

  if [[ -z "$cookie_secret" ]]; then
    cookie_secret="$(head -c 32 /dev/urandom | base64 | tr -d '\n' | cut -c1-32)"
  fi

  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  {
    printf 'PUBLIC_URL=%q\n' "$PUBLIC_URL"
    printf 'OIDC_ISSUER_URL=%q\n' "$OIDC_ISSUER_URL"
    printf 'OIDC_CLIENT_ID=%q\n' "$OIDC_CLIENT_ID"
    printf 'OIDC_CLIENT_SECRET=%q\n' "$OIDC_CLIENT_SECRET"
    printf 'OIDC_COOKIE_SECRET=%q\n' "$cookie_secret"
    printf 'OIDC_EMAIL_DOMAINS=%q\n' "$OIDC_EMAIL_DOMAINS"
    printf 'OIDC_PROVIDER_DISPLAY_NAME=%q\n' "$OIDC_PROVIDER_DISPLAY_NAME"
    printf 'OIDC_PROXY_PORT=%q\n' "$OIDC_PROXY_PORT"
    printf 'OIDC_COOKIE_SECURE=%q\n' "$OIDC_COOKIE_SECURE"
    printf 'OIDC_REVERSE_PROXY=%q\n' "$OIDC_REVERSE_PROXY"
    printf 'OIDC_SKIP_PROVIDER_BUTTON=%q\n' "$OIDC_SKIP_PROVIDER_BUTTON"
    printf 'OIDC_COOKIE_REFRESH=%q\n' "$OIDC_COOKIE_REFRESH"
    printf 'OIDC_COOKIE_EXPIRE=%q\n' "$OIDC_COOKIE_EXPIRE"
    printf 'WETTY_PORT=%q\n' "$WETTY_PORT"
    printf 'SETUP_PORT=%q\n' "$SETUP_PORT"
    printf 'SETUP_ENABLED=%q\n' "$SETUP_ENABLED"
    printf 'SETUP_ALLOWED_EMAILS=%q\n' "$SETUP_ALLOWED_EMAILS"
    printf 'SETUP_ALLOW_KEY_PERSISTENCE=%q\n' "$SETUP_ALLOW_KEY_PERSISTENCE"
    printf 'SETUP_COMMAND_TIMEOUT_MS=%q\n' "$SETUP_COMMAND_TIMEOUT_MS"
    printf 'IDENTITY_PROXY_PORT=%q\n' "$IDENTITY_PROXY_PORT"
  } >"$tmp_file"

  incus_cmd exec "$name" -- install -d -m 700 /etc/incus-web
  incus_cmd file push "$tmp_file" "$name/etc/incus-web/oauth2-proxy.env"
  incus_cmd exec "$name" -- chmod 600 /etc/incus-web/oauth2-proxy.env
  rm -f "$tmp_file"

  if [[ -n "$OIDC_ALLOWED_EMAILS" ]]; then
    tmp_emails_file="$(mktemp)"
    printf '%s\n' "$OIDC_ALLOWED_EMAILS" | sed 's/[ ,][ ,]*/\
/g; /^$/d' >"$tmp_emails_file"
    incus_cmd file push "$tmp_emails_file" "$name/etc/incus-web/authenticated-emails"
    incus_cmd exec "$name" -- chmod 600 /etc/incus-web/authenticated-emails
    rm -f "$tmp_emails_file"
  else
    incus_cmd exec "$name" -- rm -f /etc/incus-web/authenticated-emails
  fi
}

push_bootstrap_server() {
  local name="$1"
  local source_file="$INCUS_WEB_BOOTSTRAP_SERVER"
  local tmp_file=""

  if [[ "$SETUP_ENABLED" != "1" ]]; then
    return
  fi

  if [[ ! -f "$source_file" ]]; then
    tmp_file="$(mktemp)"
    curl -fsSL "$INCUS_WEB_BOOTSTRAP_SERVER_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  incus_cmd file push "$source_file" "$name/usr/local/bin/incus-web-bootstrap-server"
  incus_cmd exec "$name" -- chmod 755 /usr/local/bin/incus-web-bootstrap-server
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

push_identity_proxy() {
  local name="$1"
  local source_file="$INCUS_WEB_IDENTITY_PROXY"
  local tmp_file=""

  if [[ "$ACCESS_MODE" != "oidc" ]]; then
    return
  fi

  if [[ ! -f "$source_file" ]]; then
    tmp_file="$(mktemp)"
    curl -fsSL "$INCUS_WEB_IDENTITY_PROXY_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  incus_cmd file push "$source_file" "$name/usr/local/bin/incus-web-identity-proxy"
  incus_cmd exec "$name" -- chmod 755 /usr/local/bin/incus-web-identity-proxy
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

push_info_script() {
  local name="$1"
  local source_file="$INCUS_WEB_INFO_SCRIPT"
  local tmp_file=""

  if [[ ! -f "$source_file" ]]; then
    tmp_file="$(mktemp)"
    curl -fsSL "$INCUS_WEB_INFO_SCRIPT_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  incus_cmd file push "$source_file" "$name/usr/local/bin/incus-web-info"
  incus_cmd exec "$name" -- chmod 755 /usr/local/bin/incus-web-info
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

push_open_script() {
  local name="$1"
  local source_file="$INCUS_WEB_OPEN_SCRIPT"
  local tmp_file=""

  if [[ ! -f "$source_file" ]]; then
    tmp_file="$(mktemp)"
    curl -fsSL "$INCUS_WEB_OPEN_SCRIPT_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  incus_cmd file push "$source_file" "$name/usr/local/bin/incus-web-open"
  incus_cmd exec "$name" -- chmod 755 /usr/local/bin/incus-web-open
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

push_ghostty_aurora_patch() {
  local name="$1"
  local source_file="$INCUS_WEB_GHOSTTY_AURORA_PATCH"
  local tmp_file=""

  if [[ "$TERMINAL_BACKEND" != "ghostty-web" ]]; then
    return
  fi

  if [[ ! -f "$source_file" ]]; then
    tmp_file="$(mktemp)"
    curl -fsSL "$INCUS_WEB_GHOSTTY_AURORA_PATCH_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  incus_cmd file push "$source_file" "$name/usr/local/bin/incus-web-ghostty-aurora-patch"
  incus_cmd exec "$name" -- chmod 755 /usr/local/bin/incus-web-ghostty-aurora-patch
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

push_container_provision_program() {
  local name="$1"
  local source_file="$INCUS_WEB_CONTAINER_PROVISION_PROGRAM"
  local tmp_file=""

  if [[ ! -f "$source_file" ]]; then
    tmp_file="$(mktemp)"
    [[ "$INCUS_WEB_CONTAINER_PROVISION_PROGRAM_URL" == https://* ]] || die "INCUS_WEB_CONTAINER_PROVISION_PROGRAM_URL must use https://"
    curl --proto '=https' --tlsv1.2 -fsSL "$INCUS_WEB_CONTAINER_PROVISION_PROGRAM_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  incus_cmd exec "$name" -- install -d -m 755 /usr/local/lib/incus-web
  incus_cmd file push "$source_file" "$name/usr/local/lib/incus-web/container-provision.sh"
  incus_cmd exec "$name" -- chmod 755 /usr/local/lib/incus-web/container-provision.sh
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

ensure_host_node() {
  if [[ -x "$INCUS_WEB_PROVISIONER_NODE" ]]; then
    if [[ -x "${INCUS_WEB_APP_NPM:-/usr/bin/npm}" || "$ENABLE_HOST_WEB_APP" != "1" ]]; then
      if [[ "$ENABLE_HOST_WEB_APP" == "1" ]]; then
        validate_host_node_version
      fi
      return
    fi
  fi

  have apt-get || die "$INCUS_WEB_PROVISIONER_NODE and ${INCUS_WEB_APP_NPM:-/usr/bin/npm} are required for the host services and this script only knows how to install them with apt-get"
  have sudo || [[ "$(id -u)" -eq 0 ]] || die "sudo is required to install node for the host services"

  log "installing host node runtime for provisioner and web app"
  sudo_cmd apt-get update
  if [[ "$ENABLE_HOST_WEB_APP" == "1" ]]; then
    sudo_cmd apt-get install -y nodejs npm
  else
    sudo_cmd apt-get install -y nodejs
  fi
  [[ -x "$INCUS_WEB_PROVISIONER_NODE" ]] || die "nodejs installed but $INCUS_WEB_PROVISIONER_NODE is not executable"
  if [[ "$ENABLE_HOST_WEB_APP" == "1" ]]; then
    [[ -x "$INCUS_WEB_APP_NPM" ]] || die "npm installed but $INCUS_WEB_APP_NPM is not executable"
    validate_host_node_version
  fi
}

validate_host_node_version() {
  if [[ -n "${INCUS_WEB_WORKSPACE_STATE_DB:-}" || -n "${INCUS_WEB_WORKSPACE_STATE_DB_PATH:-}" ]]; then
    validate_node_min_version 22 5 "host web app requires Node.js >=22.5.0 for persistent workspace state via node:sqlite"
    return
  fi
  validate_node_min_version 20 9 "host web app requires Node.js >=20.9.0 for Next.js 16"
}

validate_build_worker_node_version() {
  validate_node_min_version 22 5 "build worker requires Node.js >=22.5.0 for node:sqlite"
}

validate_node_min_version() {
  local min_major="$1"
  local min_minor="$2"
  local requirement="$3"
  local version
  local major
  local minor

  version="$("$INCUS_WEB_PROVISIONER_NODE" --version 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || die "failed to parse host Node.js version from $INCUS_WEB_PROVISIONER_NODE --version"
  if (( major < min_major || (major == min_major && minor < min_minor) )); then
    die "$requirement; $INCUS_WEB_PROVISIONER_NODE is v$version"
  fi
}

install_host_provisioner_server() {
  local source_file="$INCUS_WEB_PROVISIONER_SERVER"
  local tmp_file=""
  local install_dir
  local release_dir
  local current_link

  if [[ ! -f "$source_file" ]]; then
    [[ "$ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD" == "1" ]] || die "host provisioner server is missing locally; set ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=1 to fetch it from INCUS_WEB_PROVISIONER_SERVER_URL"
    [[ "$INCUS_WEB_PROVISIONER_SERVER_URL" == https://* ]] || die "INCUS_WEB_PROVISIONER_SERVER_URL must use https://"
    tmp_file="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL "$INCUS_WEB_PROVISIONER_SERVER_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  install_dir="$(dirname "$INCUS_WEB_PROVISIONER_INSTALL_PATH")"
  release_dir="$install_dir/releases/$(date +%Y%m%d%H%M%S)-$$"
  current_link="$install_dir/current"
  INCUS_WEB_PROVISIONER_PREVIOUS_RELEASE="$(readlink -f "$current_link" 2>/dev/null || true)"
  sudo_cmd install -d -m 755 "$release_dir"
  sudo_cmd install -m 755 "$source_file" "$release_dir/provisioner-server.mjs"
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"

  INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH="$release_dir/agent-runs.mjs"
  INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH="$release_dir/service-auth.mjs"
  install_host_provisioner_agent_runs_module
  install_host_provisioner_service_auth_module
  sudo_cmd "$INCUS_WEB_PROVISIONER_NODE" --check "$release_dir/provisioner-server.mjs"
  sudo_cmd "$INCUS_WEB_PROVISIONER_NODE" --check "$release_dir/agent-runs.mjs"
  sudo_cmd "$INCUS_WEB_PROVISIONER_NODE" --check "$release_dir/service-auth.mjs"
  sudo_cmd ln -sfn "$release_dir" "$current_link.new"
  sudo_cmd mv -Tf "$current_link.new" "$current_link"
  INCUS_WEB_PROVISIONER_INSTALL_PATH="$current_link/provisioner-server.mjs"
  INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH="$current_link/agent-runs.mjs"
  INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH="$current_link/service-auth.mjs"
}

# provisioner-server.mjs imports this module by relative path
# (./service-auth.mjs) -- it must live alongside the installed
# provisioner-server.mjs or the service crash-loops with
# ERR_MODULE_NOT_FOUND. Installed as its own step (not folded into the
# provisioner-server.mjs install above) so a future new provisioner-side
# module gets the same explicit, easy-to-audit treatment as this one and
# agent-runs.mjs, rather than accreting more implicit-dependency copies
# into a single sudo_cmd install call.
install_host_provisioner_service_auth_module() {
  local source_file="$INCUS_WEB_PROVISIONER_SERVICE_AUTH"
  local tmp_file=""
  local install_dir

  if [[ ! -f "$source_file" ]]; then
    [[ "$ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD" == "1" ]] || die "host provisioner service-auth module is missing locally; set ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=1 to fetch it from INCUS_WEB_PROVISIONER_SERVICE_AUTH_URL"
    [[ "$INCUS_WEB_PROVISIONER_SERVICE_AUTH_URL" == https://* ]] || die "INCUS_WEB_PROVISIONER_SERVICE_AUTH_URL must use https://"
    tmp_file="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL "$INCUS_WEB_PROVISIONER_SERVICE_AUTH_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  install_dir="$(dirname "$INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH")"
  sudo_cmd install -d -m 755 "$install_dir"
  sudo_cmd install -m 644 "$source_file" "$INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH"
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

install_build_worker_server() {
  local source_file="$INCUS_WEB_BUILD_WORKER_SERVER"
  local tmp_file=""
  local install_dir
  local release_dir
  local current_link

  if [[ ! -f "$source_file" ]]; then
    [[ "$ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD" == "1" ]] || die "build worker server is missing locally; set ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=1 to fetch it from INCUS_WEB_BUILD_WORKER_SERVER_URL"
    [[ "$INCUS_WEB_BUILD_WORKER_SERVER_URL" == https://* ]] || die "INCUS_WEB_BUILD_WORKER_SERVER_URL must use https://"
    tmp_file="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL "$INCUS_WEB_BUILD_WORKER_SERVER_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  install_dir="$(dirname "$INCUS_WEB_BUILD_WORKER_INSTALL_PATH")"
  release_dir="$install_dir/releases/$(date +%Y%m%d%H%M%S)-$$"
  current_link="$install_dir/current-build-worker"
  INCUS_WEB_BUILD_WORKER_PREVIOUS_RELEASE="$(readlink -f "$current_link" 2>/dev/null || true)"
  sudo_cmd install -d -m 755 "$release_dir"
  sudo_cmd install -m 755 "$source_file" "$release_dir/build-worker.mjs"
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
  INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH="$release_dir/service-auth.mjs"
  install_host_provisioner_service_auth_module
  sudo_cmd "$INCUS_WEB_PROVISIONER_NODE" --check "$release_dir/build-worker.mjs"
  sudo_cmd "$INCUS_WEB_PROVISIONER_NODE" --check "$release_dir/service-auth.mjs"
  sudo_cmd ln -sfn "$release_dir" "$current_link.new"
  sudo_cmd mv -Tf "$current_link.new" "$current_link"
  INCUS_WEB_BUILD_WORKER_INSTALL_PATH="$current_link/build-worker.mjs"
}

install_host_provisioner_agent_runs_module() {
  local source_file="$INCUS_WEB_PROVISIONER_AGENT_RUNS"
  local tmp_file=""
  local install_dir

  if [[ ! -f "$source_file" ]]; then
    [[ "$ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD" == "1" ]] || die "host provisioner agent-runs module is missing locally; set ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=1 to fetch it from INCUS_WEB_PROVISIONER_AGENT_RUNS_URL"
    [[ "$INCUS_WEB_PROVISIONER_AGENT_RUNS_URL" == https://* ]] || die "INCUS_WEB_PROVISIONER_AGENT_RUNS_URL must use https://"
    tmp_file="$(mktemp)"
    curl --proto '=https' --tlsv1.2 -fsSL "$INCUS_WEB_PROVISIONER_AGENT_RUNS_URL" -o "$tmp_file"
    source_file="$tmp_file"
  fi

  install_dir="$(dirname "$INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH")"
  sudo_cmd install -d -m 755 "$install_dir"
  sudo_cmd install -m 644 "$source_file" "$INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH"
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
}

ensure_host_provisioner_identity() {
  getent group "$INCUS_WEB_PROVISIONER_GROUP" >/dev/null 2>&1 || sudo_cmd groupadd --system "$INCUS_WEB_PROVISIONER_GROUP"
  getent group "$INCUS_WEB_PROVISIONER_INCUS_GROUP" >/dev/null 2>&1 || die "Incus access group does not exist: $INCUS_WEB_PROVISIONER_INCUS_GROUP"

  if ! id -u "$INCUS_WEB_PROVISIONER_USER" >/dev/null 2>&1; then
    sudo_cmd useradd --system \
      --home-dir /var/lib/incus-web-provisioner \
      --create-home \
      --shell /usr/sbin/nologin \
      --gid "$INCUS_WEB_PROVISIONER_GROUP" \
      --groups "$INCUS_WEB_PROVISIONER_INCUS_GROUP" \
      "$INCUS_WEB_PROVISIONER_USER"
  else
    sudo_cmd usermod -aG "$INCUS_WEB_PROVISIONER_GROUP,$INCUS_WEB_PROVISIONER_INCUS_GROUP" "$INCUS_WEB_PROVISIONER_USER"
  fi
}

# The Next.js web app (INCUS_WEB_APP_USER) writes uploaded golden-config
# zips here; the provisioner (INCUS_WEB_PROVISIONER_USER) reads them back
# when handling ImportGoldenConfig. Both are already members of
# INCUS_WEB_PROVISIONER_GROUP (see ensure_host_provisioner_identity /
# ensure_host_web_app_identity), so owning the directory by that group with
# the setgid bit (mode 2770) is enough for both to read/write without
# either needing the other's primary group.
ensure_golden_config_staging_dir() {
  sudo_cmd install -d -m 2770 \
    -o "$INCUS_WEB_PROVISIONER_USER" \
    -g "$INCUS_WEB_PROVISIONER_GROUP" \
    "$INCUS_WEB_GOLDEN_CONFIG_DIR"
}

ensure_build_worker_identity() {
  getent group "$INCUS_WEB_PROVISIONER_GROUP" >/dev/null 2>&1 || sudo_cmd groupadd --system "$INCUS_WEB_PROVISIONER_GROUP"
  getent group "$INCUS_WEB_PROVISIONER_INCUS_GROUP" >/dev/null 2>&1 || die "Incus access group does not exist: $INCUS_WEB_PROVISIONER_INCUS_GROUP"

  if ! id -u "$INCUS_WEB_BUILD_WORKER_USER" >/dev/null 2>&1; then
    sudo_cmd useradd --system \
      --home-dir "$INCUS_WEB_BUILD_WORKER_STATE_DIR" \
      --create-home \
      --shell /usr/sbin/nologin \
      --gid "$INCUS_WEB_PROVISIONER_GROUP" \
      --groups "$INCUS_WEB_PROVISIONER_INCUS_GROUP" \
      "$INCUS_WEB_BUILD_WORKER_USER"
  else
    sudo_cmd usermod -aG "$INCUS_WEB_PROVISIONER_GROUP,$INCUS_WEB_PROVISIONER_INCUS_GROUP" "$INCUS_WEB_BUILD_WORKER_USER"
  fi
  sudo_cmd install -d -m 2750 \
    -o "$INCUS_WEB_BUILD_WORKER_USER" \
    -g "$INCUS_WEB_PROVISIONER_GROUP" \
    "$INCUS_WEB_BUILD_WORKER_STATE_DIR"
}

ensure_host_provisioner_token() {
  local token_file="$INCUS_WEB_PROVISIONER_TOKEN_FILE"
  local token_dir
  local tmp_file

  if [[ -n "${INCUS_WEB_PROVISIONER_TOKEN:-}" ]]; then
    validate_systemd_env_value INCUS_WEB_PROVISIONER_TOKEN "$INCUS_WEB_PROVISIONER_TOKEN"
    return
  fi

  token_dir="$(dirname "$token_file")"
  sudo_cmd install -d -m 750 -g "$INCUS_WEB_PROVISIONER_GROUP" "$token_dir"
  if sudo_cmd test -s "$token_file"; then
    INCUS_WEB_PROVISIONER_TOKEN="$(sudo_cmd cat "$token_file")"
    export INCUS_WEB_PROVISIONER_TOKEN
    sudo_cmd chgrp "$INCUS_WEB_PROVISIONER_GROUP" "$token_file"
    sudo_cmd chmod 640 "$token_file"
    return
  fi

  INCUS_WEB_PROVISIONER_TOKEN="$(head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  validate_systemd_env_value INCUS_WEB_PROVISIONER_TOKEN "$INCUS_WEB_PROVISIONER_TOKEN"
  export INCUS_WEB_PROVISIONER_TOKEN
  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  printf '%s\n' "$INCUS_WEB_PROVISIONER_TOKEN" >"$tmp_file"
  sudo_cmd install -m 640 -g "$INCUS_WEB_PROVISIONER_GROUP" "$tmp_file" "$token_file"
  rm -f "$tmp_file"
}

ensure_build_worker_token() {
  local token_file="$INCUS_WEB_BUILD_WORKER_TOKEN_FILE"
  local token_dir
  local tmp_file

  if [[ -n "${INCUS_WEB_BUILD_WORKER_TOKEN:-}" ]]; then
    validate_systemd_env_value INCUS_WEB_BUILD_WORKER_TOKEN "$INCUS_WEB_BUILD_WORKER_TOKEN"
    return
  fi

  token_dir="$(dirname "$token_file")"
  sudo_cmd install -d -m 750 -g "$INCUS_WEB_PROVISIONER_GROUP" "$token_dir"
  if sudo_cmd test -s "$token_file"; then
    INCUS_WEB_BUILD_WORKER_TOKEN="$(sudo_cmd cat "$token_file")"
    export INCUS_WEB_BUILD_WORKER_TOKEN
    sudo_cmd chgrp "$INCUS_WEB_PROVISIONER_GROUP" "$token_file"
    sudo_cmd chmod 640 "$token_file"
    return
  fi

  INCUS_WEB_BUILD_WORKER_TOKEN="$(head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  validate_systemd_env_value INCUS_WEB_BUILD_WORKER_TOKEN "$INCUS_WEB_BUILD_WORKER_TOKEN"
  export INCUS_WEB_BUILD_WORKER_TOKEN
  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  printf '%s\n' "$INCUS_WEB_BUILD_WORKER_TOKEN" >"$tmp_file"
  sudo_cmd install -m 640 -g "$INCUS_WEB_PROVISIONER_GROUP" "$tmp_file" "$token_file"
  rm -f "$tmp_file"
}

validate_systemd_env_value() {
  local name="$1"
  local value="$2"

  [[ -n "$value" ]] || die "$name must not be empty"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name must not contain newlines"
  [[ "$value" =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]] || die "$name contains unsupported characters for systemd EnvironmentFile"
}

validate_port_value() {
  local name="$1"
  local value="$2"

  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be a numeric TCP port"
  (( value >= 1 && value <= 65535 )) || die "$name must be between 1 and 65535"
}

validate_loopback_host_value() {
  local name="$1"
  local value="$2"

  case "$value" in
    127.0.0.1|::1|localhost)
      ;;
    *)
      die "$name must be loopback-only"
      ;;
  esac
}

validate_env_file_value() {
  local name="$1"
  local value="$2"

  [[ -n "$value" ]] || die "$name must not be empty"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name must not contain newlines"
}

validate_host_web_app_exposure() {
  case "$INCUS_WEB_APP_HOST" in
    127.0.0.1|::1|localhost)
      ;;
    *)
      [[ -n "${INCUS_WEB_TRUSTED_PROXY_SECRET:-}" ]] || die "INCUS_WEB_TRUSTED_PROXY_SECRET is required when INCUS_WEB_APP_HOST is not loopback-only"
      ;;
  esac

  if [[ "$INCUS_WEB_WORKSPACE_OWNER_MODE" == "authenticated" ]]; then
    [[ "${INCUS_WEB_ALLOW_SHARED_PROTOTYPE:-0}" == "1" ]] || die "INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated requires INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1"
  fi
}

ensure_host_provisioner_systemd() {
  have systemctl || die "systemctl is required for ENABLE_HOST_PROVISIONER=1; set ENABLE_HOST_PROVISIONER=0 to skip the host provisioner service"
  [[ -d /run/systemd/system ]] || die "systemd is not running; set ENABLE_HOST_PROVISIONER=0 to skip the host provisioner service"
}

codex_app_server_home() {
  local user="$1"
  getent passwd "$user" | cut -d: -f6
}

run_as_user() {
  local user="$1"
  shift
  if [[ "$(id -u)" -eq 0 ]]; then
    runuser -u "$user" -- "$@"
  else
    sudo -u "$user" "$@"
  fi
}

resolve_codex_app_server_command() {
  local user="$1"
  local home
  local command_path

  if [[ -n "${INCUS_WEB_CODEX_APP_SERVER_COMMAND:-}" ]]; then
    printf '%s\n' "$INCUS_WEB_CODEX_APP_SERVER_COMMAND"
    return
  fi

  home="$(codex_app_server_home "$user")"
  [[ -n "$home" ]] || die "could not resolve home directory for INCUS_WEB_CODEX_APP_SERVER_USER=$user"
  if [[ -x "$home/.codex/packages/standalone/current/codex" ]]; then
    printf '%s\n' "$home/.codex/packages/standalone/current/codex"
    return
  fi

  command_path="$(run_as_user "$user" sh -lc 'command -v codex' 2>/dev/null || true)"
  [[ -n "$command_path" ]] || die "could not find codex for INCUS_WEB_CODEX_APP_SERVER_USER=$user; set INCUS_WEB_CODEX_APP_SERVER_COMMAND"
  printf '%s\n' "$command_path"
}

configure_codex_app_server() {
  local tmp_unit
  local codex_home
  local codex_command

  if [[ "${ENABLE_CODEX_APP_SERVER:-0}" != "1" ]]; then
    if have systemctl; then
      sudo_cmd systemctl disable --now incus-web-codex-app-server >/dev/null 2>&1 || true
    fi
    return
  fi

  ensure_host_provisioner_systemd
  id -u "$INCUS_WEB_CODEX_APP_SERVER_USER" >/dev/null 2>&1 || die "Codex app-server user does not exist: $INCUS_WEB_CODEX_APP_SERVER_USER"
  validate_loopback_host_value INCUS_WEB_CODEX_APP_SERVER_HOST "$INCUS_WEB_CODEX_APP_SERVER_HOST"
  validate_port_value INCUS_WEB_CODEX_APP_SERVER_PORT "$INCUS_WEB_CODEX_APP_SERVER_PORT"
  validate_env_file_value INCUS_WEB_CODEX_APP_SERVER_URL "$INCUS_WEB_CODEX_APP_SERVER_URL"
  validate_systemd_env_value INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS "$INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS"
  if [[ -n "${INCUS_WEB_CODEX_MODEL:-}" ]]; then
    validate_systemd_env_value INCUS_WEB_CODEX_MODEL "$INCUS_WEB_CODEX_MODEL"
  fi

  codex_home="$(codex_app_server_home "$INCUS_WEB_CODEX_APP_SERVER_USER")"
  [[ -n "$codex_home" ]] || die "could not resolve home directory for INCUS_WEB_CODEX_APP_SERVER_USER=$INCUS_WEB_CODEX_APP_SERVER_USER"
  codex_command="$(resolve_codex_app_server_command "$INCUS_WEB_CODEX_APP_SERVER_USER")"

  tmp_unit="$(mktemp)"
  cat >"$tmp_unit" <<EOF
[Unit]
Description=incus-web Codex app-server loopback controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$INCUS_WEB_CODEX_APP_SERVER_USER
WorkingDirectory=$codex_home
Environment=HOME=$codex_home
ExecStart=$codex_command app-server --listen $INCUS_WEB_CODEX_APP_SERVER_URL
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$codex_home/.codex

[Install]
WantedBy=multi-user.target
EOF

  sudo_cmd install -m 644 "$tmp_unit" /etc/systemd/system/incus-web-codex-app-server.service
  rm -f "$tmp_unit"
  sudo_cmd systemctl daemon-reload
  sudo_cmd systemctl enable incus-web-codex-app-server
  sudo_cmd systemctl restart incus-web-codex-app-server
  wait_for_codex_app_server
  log "Codex app-server: incus-web-codex-app-server via $INCUS_WEB_CODEX_APP_SERVER_URL"
}

wait_for_codex_app_server() {
  local ready_url

  ready_url="http://$INCUS_WEB_CODEX_APP_SERVER_HOST:$INCUS_WEB_CODEX_APP_SERVER_PORT/readyz"
  for _ in $(seq 1 30); do
    if curl -fsS "$ready_url" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  sudo_cmd systemctl --no-pager --full status incus-web-codex-app-server || true
  die "Codex app-server did not become healthy at $ready_url"
}

write_host_provisioner_env() {
  local name="$1"
  local tmp_file

  validate_systemd_env_value INCUS_WEB_PROVISIONER_TOKEN "$INCUS_WEB_PROVISIONER_TOKEN"
  validate_systemd_env_value INCUS_WEB_PROVISIONER_SOCKET "$INCUS_WEB_PROVISIONER_SOCKET"
  validate_systemd_env_value INCUS_WEB_PROVISIONER_SOCKET_MODE "$INCUS_WEB_PROVISIONER_SOCKET_MODE"
  validate_systemd_env_value INCUS_WEB_WORKSPACE_ID "$INCUS_WEB_WORKSPACE_ID"
  validate_systemd_env_value INCUS_WEB_INCUS_PROJECT "$INCUS_WEB_INCUS_PROJECT"
  validate_systemd_env_value INCUS_WEB_INCUS_CONTAINER "$INCUS_WEB_INCUS_CONTAINER"
  validate_systemd_env_value CONTAINER_NAME "$name"
  validate_systemd_env_value INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS "$INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS"
  validate_systemd_env_value INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS "$INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS"
  validate_systemd_env_value INCUS_WEB_GOLDEN_CONFIG_DIR "$INCUS_WEB_GOLDEN_CONFIG_DIR"
  validate_systemd_env_value INCUS_WEB_WORKSPACE_USER "$WEB_USER"
  if [[ "${ENABLE_CODEX_APP_SERVER:-0}" == "1" ]]; then
    validate_env_file_value INCUS_WEB_CODEX_APP_SERVER_URL "$INCUS_WEB_CODEX_APP_SERVER_URL"
    validate_systemd_env_value INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS "$INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS"
    if [[ -n "${INCUS_WEB_CODEX_MODEL:-}" ]]; then
      validate_systemd_env_value INCUS_WEB_CODEX_MODEL "$INCUS_WEB_CODEX_MODEL"
    fi
  fi

  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  {
    printf 'INCUS_WEB_PROVISIONER_TOKEN=%s\n' "$INCUS_WEB_PROVISIONER_TOKEN"
    printf 'INCUS_WEB_PROVISIONER_SOCKET=%s\n' "$INCUS_WEB_PROVISIONER_SOCKET"
    printf 'INCUS_WEB_PROVISIONER_SOCKET_MODE=%s\n' "$INCUS_WEB_PROVISIONER_SOCKET_MODE"
    printf 'INCUS_WEB_WORKSPACE_ID=%s\n' "$INCUS_WEB_WORKSPACE_ID"
    printf 'INCUS_WEB_INCUS_PROJECT=%s\n' "$INCUS_WEB_INCUS_PROJECT"
    printf 'INCUS_WEB_INCUS_CONTAINER=%s\n' "$INCUS_WEB_INCUS_CONTAINER"
    printf 'CONTAINER_NAME=%s\n' "$name"
    printf 'INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS=%s\n' "$INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS"
    printf 'INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS=%s\n' "$INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS"
    printf 'INCUS_WEB_GOLDEN_CONFIG_DIR=%s\n' "$INCUS_WEB_GOLDEN_CONFIG_DIR"
    printf 'INCUS_WEB_WORKSPACE_USER=%s\n' "$WEB_USER"
    if [[ "${ENABLE_CODEX_APP_SERVER:-0}" == "1" ]]; then
      printf 'INCUS_WEB_CODEX_APP_SERVER_URL=%s\n' "$INCUS_WEB_CODEX_APP_SERVER_URL"
      printf 'INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS=%s\n' "$INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS"
      if [[ -n "${INCUS_WEB_CODEX_MODEL:-}" ]]; then
        printf 'INCUS_WEB_CODEX_MODEL=%s\n' "$INCUS_WEB_CODEX_MODEL"
      fi
    fi
  } >"$tmp_file"

  sudo_cmd install -d -m 750 -g "$INCUS_WEB_PROVISIONER_GROUP" "$(dirname "$INCUS_WEB_PROVISIONER_ENV_FILE")"
  sudo_cmd install -m 640 -g "$INCUS_WEB_PROVISIONER_GROUP" "$tmp_file" "$INCUS_WEB_PROVISIONER_ENV_FILE"
  rm -f "$tmp_file"
}

configure_host_provisioner() {
  local name="$1"
  local tmp_unit

  if [[ "$ENABLE_HOST_PROVISIONER" != "1" ]]; then
    if have systemctl; then
      sudo_cmd systemctl disable --now incus-web-provisioner >/dev/null 2>&1 || true
    fi
    return
  fi

  ensure_host_provisioner_systemd
  INCUS_WEB_INCUS_CONTAINER="${INCUS_WEB_INCUS_CONTAINER:-$name}"

  ensure_host_node
  ensure_host_provisioner_identity
  ensure_golden_config_staging_dir
  install_host_provisioner_server
  ensure_host_provisioner_token
  configure_codex_app_server
  write_host_provisioner_env "$name"

  tmp_unit="$(mktemp)"
  cat >"$tmp_unit" <<EOF
[Unit]
Description=incus-web host provisioner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$INCUS_WEB_PROVISIONER_USER
Group=$INCUS_WEB_PROVISIONER_GROUP
SupplementaryGroups=$INCUS_WEB_PROVISIONER_INCUS_GROUP
Environment=HOME=/var/lib/incus-web-provisioner
EnvironmentFile=$INCUS_WEB_PROVISIONER_ENV_FILE
RuntimeDirectory=incus-web
RuntimeDirectoryMode=0750
StateDirectory=incus-web
StateDirectoryMode=0750
UMask=0077
ExecStart=$INCUS_WEB_PROVISIONER_NODE $INCUS_WEB_PROVISIONER_INSTALL_PATH
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/run/incus-web
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

  sudo_cmd install -m 644 "$tmp_unit" /etc/systemd/system/incus-web-provisioner.service
  rm -f "$tmp_unit"
  sudo_cmd systemctl daemon-reload
  sudo_cmd systemctl enable incus-web-provisioner
  sudo_cmd systemctl restart incus-web-provisioner
  if ! wait_for_host_provisioner; then
    if [[ -n "${INCUS_WEB_PROVISIONER_PREVIOUS_RELEASE:-}" ]]; then
      log "provisioner readiness failed; restoring ${INCUS_WEB_PROVISIONER_PREVIOUS_RELEASE}"
      sudo_cmd ln -sfn "$INCUS_WEB_PROVISIONER_PREVIOUS_RELEASE" "$(dirname "$INCUS_WEB_PROVISIONER_INSTALL_PATH")/../current.rollback"
      sudo_cmd mv -Tf "$(dirname "$INCUS_WEB_PROVISIONER_INSTALL_PATH")/../current.rollback" "$(dirname "$INCUS_WEB_PROVISIONER_INSTALL_PATH")/../current"
      sudo_cmd systemctl restart incus-web-provisioner
    fi
    die "host provisioner did not become healthy"
  fi
  log "host provisioner: incus-web-provisioner via $INCUS_WEB_PROVISIONER_SOCKET"
}

ensure_host_web_app_systemd() {
  have systemctl || die "systemctl is required for ENABLE_HOST_WEB_APP=1; set ENABLE_HOST_WEB_APP=0 to skip the host web app service"
  [[ -d /run/systemd/system ]] || die "systemd is not running; set ENABLE_HOST_WEB_APP=0 to skip the host web app service"
}

ensure_host_web_app_identity() {
  getent group "$INCUS_WEB_PROVISIONER_GROUP" >/dev/null 2>&1 || sudo_cmd groupadd --system "$INCUS_WEB_PROVISIONER_GROUP"
  if ! id -u "$INCUS_WEB_APP_USER" >/dev/null 2>&1; then
    if [[ "$INCUS_WEB_APP_USER" != "incus-web-app" ]]; then
      die "host web app user does not exist: $INCUS_WEB_APP_USER"
    fi
    sudo_cmd useradd --system \
      --home-dir /var/lib/incus-web-app \
      --create-home \
      --shell /usr/sbin/nologin \
      --gid "$INCUS_WEB_PROVISIONER_GROUP" \
      "$INCUS_WEB_APP_USER"
  else
    sudo_cmd usermod -aG "$INCUS_WEB_PROVISIONER_GROUP" "$INCUS_WEB_APP_USER"
  fi
}

host_web_app_source_stamp() {
  (
    cd "$INCUS_WEB_APP_DIR"
    {
      for path in package.json package-lock.json next.config.ts next.config.mjs tsconfig.json postcss.config.mjs components.json app components lib public types; do
        [[ -e "$path" ]] || continue
        if [[ -d "$path" ]]; then
          find "$path" -type f -print0 | sort -z | xargs -0 -r sha256sum
        else
          sha256sum "$path"
        fi
      done
    } | sha256sum | awk '{print $1}'
  )
}

install_host_web_app_runtime() {
  local install_path=/opt/incus-web-app
  local previous_path=/opt/incus-web-app.previous
  local runtime_paths=(package.json package-lock.json .next node_modules)
  local staging_path=/opt/incus-web-app.new

  if [[ -d "$INCUS_WEB_APP_DIR/public" ]]; then
    runtime_paths+=(public)
  fi

  sudo_cmd rm -rf "$staging_path"
  sudo_cmd install -d -m 755 "$staging_path"
  (
    cd "$INCUS_WEB_APP_DIR"
    tar -cf - "${runtime_paths[@]}"
  ) | sudo_cmd tar -xf - -C "$staging_path"
  sudo_cmd rm -rf "$staging_path/.next/cache"
  sudo_cmd chown -R root:root "$staging_path"
  sudo_cmd install -d -m 750 -o "$INCUS_WEB_APP_USER" -g "$INCUS_WEB_PROVISIONER_GROUP" "$staging_path/.next/cache"
  sudo_cmd rm -rf "$previous_path"
  if sudo_cmd test -e "$install_path"; then
    sudo_cmd mv "$install_path" "$previous_path"
  fi
  sudo_cmd mv "$staging_path" "$install_path"
}

restore_host_web_app_runtime() {
  local install_path=/opt/incus-web-app
  local previous_path=/opt/incus-web-app.previous

  sudo_cmd test -e "$previous_path" || return 1
  sudo_cmd rm -rf "$install_path"
  sudo_cmd mv "$previous_path" "$install_path"
}

write_host_web_app_env() {
  local tmp_file

  validate_host_web_app_exposure
  validate_systemd_env_value INCUS_WEB_APP_HOST "$INCUS_WEB_APP_HOST"
  validate_port_value INCUS_WEB_APP_PORT "$INCUS_WEB_APP_PORT"
  validate_systemd_env_value INCUS_WEB_WORKSPACE_OWNER_MODE "$INCUS_WEB_WORKSPACE_OWNER_MODE"
  validate_systemd_env_value INCUS_WEB_ALLOW_SHARED_PROTOTYPE "$INCUS_WEB_ALLOW_SHARED_PROTOTYPE"
  validate_systemd_env_value INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION "$INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION"
  validate_systemd_env_value INCUS_WEB_PROVISIONER_TIMEOUT_MS "$INCUS_WEB_PROVISIONER_TIMEOUT_MS"
  validate_systemd_env_value INCUS_WEB_GOLDEN_CONFIG_DIR "$INCUS_WEB_GOLDEN_CONFIG_DIR"
  validate_env_file_value INCUS_WEB_WORKSPACE_STATE_DB "$INCUS_WEB_WORKSPACE_STATE_DB"
  if [[ "${ENABLE_BUILD_WORKER:-0}" == "1" ]]; then
    validate_systemd_env_value INCUS_WEB_BUILD_WORKER_TOKEN "$INCUS_WEB_BUILD_WORKER_TOKEN"
    validate_systemd_env_value INCUS_WEB_BUILD_WORKER_SOCKET "$INCUS_WEB_BUILD_WORKER_SOCKET"
    validate_systemd_env_value INCUS_WEB_ALLOW_BUILD_WORKER_ACTIONS "${INCUS_WEB_ALLOW_BUILD_WORKER_ACTIONS:-0}"
    if [[ -n "${INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS:-}" ]]; then
      validate_env_file_value INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS "$INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS"
    fi
  fi
  if [[ -n "$INCUS_WEB_TERMINAL_URL" ]]; then
    validate_env_file_value INCUS_WEB_TERMINAL_URL "$INCUS_WEB_TERMINAL_URL"
  fi
  if [[ -n "${INCUS_WEB_TRUSTED_PROXY_SECRET:-}" ]]; then
    validate_env_file_value INCUS_WEB_TRUSTED_PROXY_SECRET "$INCUS_WEB_TRUSTED_PROXY_SECRET"
  fi

  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  {
    printf 'NODE_ENV=production\n'
    printf 'HOSTNAME=%s\n' "$INCUS_WEB_APP_HOST"
    printf 'PORT=%s\n' "$INCUS_WEB_APP_PORT"
    printf 'INCUS_WEB_APP_HOST=%s\n' "$INCUS_WEB_APP_HOST"
    printf 'INCUS_WEB_APP_PORT=%s\n' "$INCUS_WEB_APP_PORT"
    printf 'INCUS_WEB_WORKSPACE_OWNER_MODE=%s\n' "$INCUS_WEB_WORKSPACE_OWNER_MODE"
    printf 'INCUS_WEB_ALLOW_SHARED_PROTOTYPE=%s\n' "$INCUS_WEB_ALLOW_SHARED_PROTOTYPE"
    printf 'INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION=%s\n' "$INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION"
    printf 'INCUS_WEB_PROVISIONER_TIMEOUT_MS=%s\n' "$INCUS_WEB_PROVISIONER_TIMEOUT_MS"
    printf 'INCUS_WEB_GOLDEN_CONFIG_DIR=%s\n' "$INCUS_WEB_GOLDEN_CONFIG_DIR"
    printf 'INCUS_WEB_WORKSPACE_STATE_DB=%s\n' "$INCUS_WEB_WORKSPACE_STATE_DB"
    if [[ "${ENABLE_BUILD_WORKER:-0}" == "1" ]]; then
      printf 'INCUS_WEB_BUILD_WORKER_TOKEN=%s\n' "$INCUS_WEB_BUILD_WORKER_TOKEN"
      printf 'INCUS_WEB_BUILD_WORKER_SOCKET=%s\n' "$INCUS_WEB_BUILD_WORKER_SOCKET"
      printf 'INCUS_WEB_ALLOW_BUILD_WORKER_ACTIONS=%s\n' "${INCUS_WEB_ALLOW_BUILD_WORKER_ACTIONS:-0}"
      if [[ -n "${INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS:-}" ]]; then
        printf 'INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS=%s\n' "$INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS"
      fi
    fi
    if [[ -n "$INCUS_WEB_TERMINAL_URL" ]]; then
      printf 'INCUS_WEB_TERMINAL_URL=%s\n' "$INCUS_WEB_TERMINAL_URL"
    fi
    if [[ -n "${INCUS_WEB_TRUSTED_PROXY_SECRET:-}" ]]; then
      printf 'INCUS_WEB_TRUSTED_PROXY_SECRET=%s\n' "$INCUS_WEB_TRUSTED_PROXY_SECRET"
    fi
  } >"$tmp_file"

  sudo_cmd install -d -m 750 -g "$INCUS_WEB_PROVISIONER_GROUP" "$(dirname "$INCUS_WEB_APP_ENV_FILE")"
  sudo_cmd install -m 640 -g "$INCUS_WEB_PROVISIONER_GROUP" "$tmp_file" "$INCUS_WEB_APP_ENV_FILE"
  rm -f "$tmp_file"
}

write_build_worker_env() {
  local tmp_file

  validate_systemd_env_value INCUS_WEB_BUILD_WORKER_TOKEN "$INCUS_WEB_BUILD_WORKER_TOKEN"
  validate_systemd_env_value INCUS_WEB_BUILD_WORKER_SOCKET "$INCUS_WEB_BUILD_WORKER_SOCKET"
  validate_systemd_env_value INCUS_WEB_BUILD_WORKER_SOCKET_MODE "$INCUS_WEB_BUILD_WORKER_SOCKET_MODE"
  validate_env_file_value INCUS_WEB_BUILD_WORKER_STATE_DIR "$INCUS_WEB_BUILD_WORKER_STATE_DIR"
  for name in \
    INCUS_WEB_BUILD_WORKER_MAX_LOG_CHUNK_BYTES \
    INCUS_WEB_BUILD_WORKER_MAX_LOG_BYTES_PER_BUILD \
    INCUS_WEB_BUILD_WORKER_MAX_COMPLETED_BUILDS \
    INCUS_WEB_BUILD_WORKER_MAX_STDERR_TAIL_BYTES; do
    if [[ -n "${!name:-}" ]]; then
      validate_systemd_env_value "$name" "${!name}"
    fi
  done

  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  {
    printf 'INCUS_WEB_BUILD_WORKER_TOKEN=%s\n' "$INCUS_WEB_BUILD_WORKER_TOKEN"
    printf 'INCUS_WEB_BUILD_WORKER_SOCKET=%s\n' "$INCUS_WEB_BUILD_WORKER_SOCKET"
    printf 'INCUS_WEB_BUILD_WORKER_SOCKET_MODE=%s\n' "$INCUS_WEB_BUILD_WORKER_SOCKET_MODE"
    printf 'INCUS_WEB_BUILD_WORKER_STATE_DIR=%s\n' "$INCUS_WEB_BUILD_WORKER_STATE_DIR"
    printf 'INCUS_WEB_BUILD_WORKER_DB=%s\n' "$INCUS_WEB_BUILD_WORKER_STATE_DIR/builds.sqlite3"
    printf 'INCUS_WEB_BUILD_WORKER_WORK_DIR=%s\n' "$INCUS_WEB_BUILD_WORKER_STATE_DIR/work"
    for name in \
      INCUS_WEB_BUILD_WORKER_MAX_LOG_CHUNK_BYTES \
      INCUS_WEB_BUILD_WORKER_MAX_LOG_BYTES_PER_BUILD \
      INCUS_WEB_BUILD_WORKER_MAX_COMPLETED_BUILDS \
      INCUS_WEB_BUILD_WORKER_MAX_STDERR_TAIL_BYTES; do
      if [[ -n "${!name:-}" ]]; then
        printf '%s=%s\n' "$name" "${!name}"
      fi
    done
  } >"$tmp_file"

  sudo_cmd install -d -m 750 -g "$INCUS_WEB_PROVISIONER_GROUP" "$(dirname "$INCUS_WEB_BUILD_WORKER_ENV_FILE")"
  sudo_cmd install -m 640 -g "$INCUS_WEB_PROVISIONER_GROUP" "$tmp_file" "$INCUS_WEB_BUILD_WORKER_ENV_FILE"
  rm -f "$tmp_file"
}

wait_for_build_worker() {
  for _ in {1..30}; do
    if sudo_cmd systemctl is-active --quiet incus-web-build-worker &&
      sudo_cmd curl -fsS --max-time 10 --unix-socket "$INCUS_WEB_BUILD_WORKER_SOCKET" http://localhost/readyz >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  sudo_cmd journalctl -u incus-web-build-worker -n 80 --no-pager >&2 || true
  return 1
}

configure_build_worker() {
  local tmp_unit

  if [[ "$ENABLE_BUILD_WORKER" != "1" ]]; then
    if have systemctl; then
      sudo_cmd systemctl disable --now incus-web-build-worker >/dev/null 2>&1 || true
    fi
    return
  fi

  ensure_host_provisioner_systemd
  ensure_host_node
  validate_build_worker_node_version
  ensure_build_worker_identity
  install_build_worker_server
  ensure_build_worker_token
  write_build_worker_env

  tmp_unit="$(mktemp)"
  cat >"$tmp_unit" <<EOF
[Unit]
Description=incus-web image build worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$INCUS_WEB_BUILD_WORKER_USER
Group=$INCUS_WEB_PROVISIONER_GROUP
SupplementaryGroups=$INCUS_WEB_PROVISIONER_INCUS_GROUP
Environment=HOME=$INCUS_WEB_BUILD_WORKER_STATE_DIR
EnvironmentFile=$INCUS_WEB_BUILD_WORKER_ENV_FILE
RuntimeDirectory=incus-web
RuntimeDirectoryMode=0750
StateDirectory=incus-web/build-worker
StateDirectoryMode=0750
UMask=0077
ExecStart=$INCUS_WEB_PROVISIONER_NODE $INCUS_WEB_BUILD_WORKER_INSTALL_PATH
Restart=always
RestartSec=2
# distrobuilder uses newuidmap/newgidmap during image creation; do not set
# NoNewPrivileges or RestrictSUIDSGID on this service.
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/run/incus-web $INCUS_WEB_BUILD_WORKER_STATE_DIR
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

  sudo_cmd install -m 644 "$tmp_unit" /etc/systemd/system/incus-web-build-worker.service
  rm -f "$tmp_unit"
  sudo_cmd systemctl daemon-reload
  sudo_cmd systemctl enable incus-web-build-worker
  sudo_cmd systemctl restart incus-web-build-worker
  if ! wait_for_build_worker; then
    if [[ -n "${INCUS_WEB_BUILD_WORKER_PREVIOUS_RELEASE:-}" ]]; then
      log "build worker readiness failed; restoring ${INCUS_WEB_BUILD_WORKER_PREVIOUS_RELEASE}"
      sudo_cmd ln -sfn "$INCUS_WEB_BUILD_WORKER_PREVIOUS_RELEASE" "$(dirname "$INCUS_WEB_BUILD_WORKER_INSTALL_PATH")/../current-build-worker.rollback"
      sudo_cmd mv -Tf "$(dirname "$INCUS_WEB_BUILD_WORKER_INSTALL_PATH")/../current-build-worker.rollback" "$(dirname "$INCUS_WEB_BUILD_WORKER_INSTALL_PATH")/../current-build-worker"
      sudo_cmd systemctl restart incus-web-build-worker
    fi
    die "build worker did not become healthy"
  fi
  log "build worker: incus-web-build-worker via $INCUS_WEB_BUILD_WORKER_SOCKET"
}

wait_for_host_provisioner() {
  local body
  local response

  body="$(printf '{"version":"provisioner.v1","requestId":"deploy-health","type":"GetWorkspaceStatus","actor":{"userId":"system:deploy","oidcSubject":"deploy","email":"deploy@incus-web.local","displayName":"deploy"},"workspace":{"id":"%s","ownerUserId":"system:deploy","incusProject":"%s","incusContainer":"%s"},"payload":{}}' "$INCUS_WEB_WORKSPACE_ID" "$INCUS_WEB_INCUS_PROJECT" "$INCUS_WEB_INCUS_CONTAINER")"
  for _ in {1..30}; do
    if sudo_cmd systemctl is-active --quiet incus-web-provisioner; then
      response="$(sudo_cmd curl -fsS --max-time 3 --unix-socket "$INCUS_WEB_PROVISIONER_SOCKET" \
        -H "Authorization: Bearer $INCUS_WEB_PROVISIONER_TOKEN" \
        -H "Content-Type: application/json" \
        --data "$body" \
        http://localhost/v1/operations 2>/dev/null || true)"
      if [[ "$response" == *'"status":"succeeded"'* ]]; then
        return
      fi
    fi
    sleep 1
  done

  sudo_cmd journalctl -u incus-web-provisioner -n 80 --no-pager >&2 || true
  return 1
}

wait_for_host_web_app() {
  local url="http://$INCUS_WEB_APP_HOST:$INCUS_WEB_APP_PORT/readyz"
  local curl_args=(-fsS --max-time 2)

  wait_for_host_provisioner || die "host provisioner did not become healthy"
  if [[ -n "${INCUS_WEB_TRUSTED_PROXY_SECRET:-}" ]]; then
    curl_args+=(-H "X-Incus-Web-Proxy-Secret: $INCUS_WEB_TRUSTED_PROXY_SECRET")
  fi
  for _ in {1..30}; do
    if sudo_cmd systemctl is-active --quiet incus-web-app && curl "${curl_args[@]}" "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  sudo_cmd journalctl -u incus-web-app -n 80 --no-pager >&2 || true
  return 1
}

configure_host_web_app() {
  local source_stamp
  local stamp_file
  local tmp_unit

  if [[ "$ENABLE_HOST_WEB_APP" != "1" ]]; then
    if have systemctl; then
      sudo_cmd systemctl disable --now incus-web-app >/dev/null 2>&1 || true
    fi
    return
  fi

  ensure_host_web_app_systemd
  ensure_host_node
  ensure_host_web_app_identity
  [[ -d "$INCUS_WEB_APP_DIR" ]] || die "host web app directory does not exist: $INCUS_WEB_APP_DIR"
  [[ -f "$INCUS_WEB_APP_DIR/package.json" ]] || die "host web app package.json is missing: $INCUS_WEB_APP_DIR/package.json"
  [[ -x "$INCUS_WEB_APP_NPM" ]] || die "npm is required for the host web app: $INCUS_WEB_APP_NPM"
  sudo_cmd test -f "$INCUS_WEB_PROVISIONER_ENV_FILE" || die "host provisioner env file is required before starting the web app: $INCUS_WEB_PROVISIONER_ENV_FILE"

  source_stamp="$(host_web_app_source_stamp)"
  stamp_file="$INCUS_WEB_APP_DIR/.next/incus-web-build.stamp"
  if [[ -f "$stamp_file" && "$(cat "$stamp_file")" == "$source_stamp" ]]; then
    log "host Next.js web app build is current"
  else
    log "building host Next.js web app"
    "$INCUS_WEB_APP_NPM" ci --prefix "$INCUS_WEB_APP_DIR"
    "$INCUS_WEB_APP_NPM" --prefix "$INCUS_WEB_APP_DIR" run build
    printf '%s\n' "$source_stamp" >"$stamp_file"
  fi
  write_host_web_app_env
  install_host_web_app_runtime

  tmp_unit="$(mktemp)"
  cat >"$tmp_unit" <<EOF
[Unit]
Description=incus-web Next.js control plane
After=network-online.target incus-web-provisioner.service
Wants=network-online.target incus-web-provisioner.service

[Service]
Type=simple
User=$INCUS_WEB_APP_USER
SupplementaryGroups=$INCUS_WEB_PROVISIONER_GROUP
WorkingDirectory=/opt/incus-web-app
Environment=HOME=/var/lib/incus-web-app
EnvironmentFile=$INCUS_WEB_PROVISIONER_ENV_FILE
EnvironmentFile=$INCUS_WEB_APP_ENV_FILE
ExecStart=$INCUS_WEB_APP_NPM run start -- --hostname \$INCUS_WEB_APP_HOST --port \$INCUS_WEB_APP_PORT
Restart=always
RestartSec=2
StateDirectory=incus-web-app
CacheDirectory=incus-web-app
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=full
ReadWritePaths=/opt/incus-web-app/.next/cache $INCUS_WEB_GOLDEN_CONFIG_DIR
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

  sudo_cmd install -m 644 "$tmp_unit" /etc/systemd/system/incus-web-app.service
  rm -f "$tmp_unit"
  sudo_cmd systemctl daemon-reload
  sudo_cmd systemctl enable incus-web-app
  sudo_cmd systemctl restart incus-web-app
  if ! wait_for_host_web_app; then
    if restore_host_web_app_runtime; then
      sudo_cmd systemctl restart incus-web-app || true
    fi
    die "host web app did not become healthy at http://$INCUS_WEB_APP_HOST:$INCUS_WEB_APP_PORT/healthz"
  fi
  log "host web app: incus-web-app on $INCUS_WEB_APP_HOST:$INCUS_WEB_APP_PORT"
}

provision_container() {
  local name="$1"
  local ghostty_allowed_hosts="localhost,127.0.0.1,::1"
  local public_host=""

  if [[ -n "${PUBLIC_URL:-}" ]]; then
    public_host="${PUBLIC_URL#*://}"
    public_host="${public_host%%/*}"
    public_host="${public_host%%:*}"
    if [[ -n "$public_host" ]]; then
      ghostty_allowed_hosts="$ghostty_allowed_hosts,$public_host"
    fi
  fi

  log "installing container packages"
  if [[ "$CONTAINER_PACKAGES_PREINSTALLED" == "1" ]]; then
    log "verifying preinstalled container packages"
    # This script is evaluated inside the container; keep expansions there.
    # shellcheck disable=SC2016
    container_bash "$name" 'set -euo pipefail
for command in cc cargo curl git go gpg jq nc node npm pipx pkg-config python3 rustc sudo unzip zip zsh gh claude wetty; do
  command -v "$command" >/dev/null || {
    printf "required preinstalled command is missing: %s\n" "$command" >&2
    exit 1
  }
done'
  else
    # This script is evaluated inside the container; keep expansions there.
    # shellcheck disable=SC2016,SC2086
    container_bash "$name" 'set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  build-essential \
  ca-certificates \
  cargo \
  curl \
  git \
  golang-go \
  gnupg \
  jq \
  libssl-dev \
  netcat-openbsd \
  nodejs \
  npm \
  pipx \
  pkg-config \
  python3 \
  python3-pip \
  python3-venv \
  rustc \
  sudo \
  unzip \
  zip \
  zsh
if ! command -v gh >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    >/etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y gh
fi
if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code@'"$CLAUDE_CODE_VERSION"'
fi
if ! command -v wetty >/dev/null 2>&1; then
  npm install -g wetty@'"$WETTY_VERSION"'
fi
if [[ "'"$TERMINAL_BACKEND"'" == "ghostty-web" ]] && ! npm list -g "@ghostty-web/demo@'"$GHOSTTY_WEB_DEMO_VERSION"'" >/dev/null 2>&1; then
  npm install -g @ghostty-web/demo@'"$GHOSTTY_WEB_DEMO_VERSION"'
fi'
  fi

  log "configuring user, workspace, developer tools, tailscaled, and wetty"
  push_bootstrap_server "$name"
  push_identity_proxy "$name"
  push_info_script "$name"
  push_open_script "$name"
  push_ghostty_aurora_patch "$name"
  if [[ "$TERMINAL_BACKEND" == "ghostty-web" ]]; then
    log "applying Aurora chrome to ghostty-web demo"
    container_bash "$name" "/usr/local/bin/incus-web-ghostty-aurora-patch"
  fi
  push_container_provision_program "$name"
  container_bash "$name" "env \
    WEB_USER=$(printf %q "$WEB_USER") \
    CONTAINER_WORKSPACE=$(printf %q "$CONTAINER_WORKSPACE") \
    INCUS_WEB_WORKSPACE_LABEL=$(printf %q "$INCUS_WEB_WORKSPACE_LABEL") \
    CODEX_VERSION=$(printf %q "$CODEX_VERSION") \
    WETTY_PORT=$(printf %q "$WETTY_PORT") \
    SETUP_ENABLED=$(printf %q "$SETUP_ENABLED") \
    SETUP_PORT=$(printf %q "$SETUP_PORT") \
    DOTFILES_SKIP_APT=$(printf %q "$DOTFILES_SKIP_APT") \
    SETUP_ALLOWED_EMAILS=$(printf %q "$SETUP_ALLOWED_EMAILS") \
    SETUP_ALLOW_KEY_PERSISTENCE=$(printf %q "$SETUP_ALLOW_KEY_PERSISTENCE") \
    SETUP_COMMAND_TIMEOUT_MS=$(printf %q "$SETUP_COMMAND_TIMEOUT_MS") \
    TERMINAL_BACKEND=$(printf %q "$TERMINAL_BACKEND") \
    GHOSTTY_ALLOWED_HOSTS=$(printf %q "$ghostty_allowed_hosts") \
    /usr/local/lib/incus-web/container-provision.sh"

  configure_user_bootstrap "$name"
}

configure_user_bootstrap() {
  local name="$1"
  local dotfiles_archive=""

  if [[ -z "$DOTFILES_REPO" && -z "$DOTFILES_SOURCE_DIR" && "$DOTFILES_RUN_MISE" != "1" ]]; then
    return
  fi

  log "configuring optional dotfiles and mise bootstrap"
  if [[ -n "$DOTFILES_SOURCE_DIR" ]]; then
    [[ -d "$DOTFILES_SOURCE_DIR" ]] || die "DOTFILES_SOURCE_DIR does not exist: $DOTFILES_SOURCE_DIR"
    dotfiles_archive="$(mktemp)"
    tar -C "$DOTFILES_SOURCE_DIR" -czf "$dotfiles_archive" .
    incus_cmd exec "$name" -- install -d -o "$WEB_USER" -g "$WEB_USER" -m 700 "/home/$WEB_USER/.local/share/chezmoi"
    incus_cmd file push "$dotfiles_archive" "$name/tmp/incus-web-dotfiles-source.tgz"
    rm -f "$dotfiles_archive"
    incus_cmd exec "$name" -- tar -xzf /tmp/incus-web-dotfiles-source.tgz -C "/home/$WEB_USER/.local/share/chezmoi"
    incus_cmd exec "$name" -- rm -f /tmp/incus-web-dotfiles-source.tgz
    incus_cmd exec "$name" -- chown -R "$WEB_USER:$WEB_USER" "/home/$WEB_USER/.local/share/chezmoi"
    if [[ "$DOTFILES_SKIP_APT" == "1" ]]; then
      incus_cmd exec "$name" -- bash -lc "scripts_dir='/home/$WEB_USER/.local/share/chezmoi/.chezmoiscripts'; disabled_dir='/home/$WEB_USER/.local/share/chezmoi/.disabled-chezmoiscripts'; if [[ -d \"\$scripts_dir\" ]]; then shopt -s nullglob; matches=(\"\$scripts_dir\"/*apt-packages*); if (( \${#matches[@]} > 0 )); then install -d -o '$WEB_USER' -g '$WEB_USER' \"\$disabled_dir\"; mv \"\${matches[@]}\" \"\$disabled_dir\"/; fi; fi"
    fi
  fi

  if [[ -n "$DOTFILES_AGE_KEY_FILE" ]]; then
    [[ -f "$DOTFILES_AGE_KEY_FILE" ]] || die "DOTFILES_AGE_KEY_FILE does not exist: $DOTFILES_AGE_KEY_FILE"
    incus_cmd exec "$name" -- install -d -o "$WEB_USER" -g "$WEB_USER" -m 700 "/home/$WEB_USER/.config/chezmoi"
    incus_cmd file push "$DOTFILES_AGE_KEY_FILE" "$name/home/$WEB_USER/.config/chezmoi/key.txt"
    incus_cmd exec "$name" -- chown "$WEB_USER:$WEB_USER" "/home/$WEB_USER/.config/chezmoi/key.txt"
    incus_cmd exec "$name" -- chmod 600 "/home/$WEB_USER/.config/chezmoi/key.txt"
  fi

  incus_cmd exec "$name" -- chown -R "$WEB_USER:$WEB_USER" "/home/$WEB_USER/.config" "/home/$WEB_USER/.local" "$CONTAINER_WORKSPACE"

  container_bash "$name" "set -euo pipefail
agent_env=(env HOME='/home/$WEB_USER' USER='$WEB_USER' LOGNAME='$WEB_USER' PATH='/home/$WEB_USER/.local/bin:/home/$WEB_USER/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin' MISE_HTTP_TIMEOUT=180 MISE_FETCH_REMOTE_VERSIONS_TIMEOUT=60)
if [[ '$DOTFILES_RUN_MISE' == '1' ]] && ! runuser -u '$WEB_USER' -- \"\${agent_env[@]}\" bash -lc 'command -v mise >/dev/null 2>&1'; then
  runuser -u '$WEB_USER' -- \"\${agent_env[@]}\" bash -lc 'cd \"\$HOME\" && curl -fsSL https://mise.run | sh'
fi
if [[ -n '$DOTFILES_REPO' || -n '$DOTFILES_SOURCE_DIR' ]] && ! runuser -u '$WEB_USER' -- \"\${agent_env[@]}\" bash -lc 'command -v chezmoi >/dev/null 2>&1'; then
  runuser -u '$WEB_USER' -- \"\${agent_env[@]}\" bash -lc 'cd \"\$HOME\" && sh -c \"\$(curl -fsLS get.chezmoi.io)\" -- -b \"\$HOME/.local/bin\"'
fi
if [[ -n '$DOTFILES_SOURCE_DIR' ]]; then
  runuser -u '$WEB_USER' -- \"\${agent_env[@]}\" bash -lc 'cd \"\$HOME\" && chezmoi --source \"\$HOME/.local/share/chezmoi\" init --apply --promptDefaults --force --no-tty'
elif [[ -n '$DOTFILES_REPO' ]]; then
  runuser -u '$WEB_USER' -- \"\${agent_env[@]}\" DOTFILES_SKIP_APT='$DOTFILES_SKIP_APT' bash -lc 'cd \"\$HOME\" && chezmoi init --promptDefaults --force --no-tty \"$DOTFILES_REPO\" && if [[ \"\$DOTFILES_SKIP_APT\" == \"1\" ]]; then scripts_dir=\"\$HOME/.local/share/chezmoi/.chezmoiscripts\"; disabled_dir=\"\$HOME/.local/share/chezmoi/.disabled-chezmoiscripts\"; if [[ -d \"\$scripts_dir\" ]]; then shopt -s nullglob; matches=(\"\$scripts_dir\"/*apt-packages*); if (( \${#matches[@]} > 0 )); then mkdir -p \"\$disabled_dir\"; mv \"\${matches[@]}\" \"\$disabled_dir\"/; fi; fi; fi && chezmoi apply --force --no-tty'
fi
if [[ '$DOTFILES_RUN_MISE' == '1' ]]; then
  runuser -u '$WEB_USER' -- \"\${agent_env[@]}\" bash -lc 'cd \"\$HOME\" && mise install'
fi
if [[ -n '$DOTFILES_AGE_KEY_FILE' ]]; then
  rm -f '/home/$WEB_USER/.config/chezmoi/key.txt'
fi"
}

ensure_tailscale_installed() {
  local name="$1"

  log "installing Tailscale"
  # shellcheck disable=SC2016
  container_bash "$name" 'set -euo pipefail
version="1.98.8"
arch="$(dpkg --print-architecture)"
case "$arch" in
  amd64) sha256=3a55b5900dd7e11e09b6c74d1e46d223d549dfbefbdc1f044a8ab7bdbafb933c ;;
  *) echo "unsupported Tailscale architecture: $arch" >&2; exit 1 ;;
esac
if ! command -v tailscale >/dev/null 2>&1 || ! tailscale version | head -1 | grep -Fxq "$version"; then
  tmp_dir="$(mktemp -d)"
  archive="tailscale_${version}_${arch}.tgz"
  curl --proto "=https" --tlsv1.2 -fsSL "https://pkgs.tailscale.com/stable/$archive" -o "$tmp_dir/$archive"
  printf "%s  %s\n" "$sha256" "$tmp_dir/$archive" | sha256sum -c -
  tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
  release_dir="$tmp_dir/tailscale_${version}_${arch}"
  install -m 755 "$release_dir/tailscale" "$release_dir/tailscaled" /usr/local/bin/
  install -m 644 "$release_dir/systemd/tailscaled.service" /etc/systemd/system/tailscaled.service
  install -m 644 "$release_dir/systemd/tailscale-online.target" /etc/systemd/system/tailscale-online.target
  install -m 644 "$release_dir/systemd/tailscale-wait-online.service" /etc/systemd/system/tailscale-wait-online.service
  rm -rf "$tmp_dir"
fi
install -d -m 755 /etc/default
cat >/etc/default/tailscaled <<EOF
PORT="41641"
FLAGS="--tun=userspace-networking"
EOF
systemctl daemon-reload
systemctl enable --now tailscaled'
}

ensure_oauth2_proxy_installed() {
  local name="$1"

  log "installing oauth2-proxy"
  container_bash "$name" "set -euo pipefail
version='$OAUTH2_PROXY_VERSION'
arch=\"\$(uname -m)\"
case \"\$arch\" in
  x86_64|amd64) arch=amd64 ;;
  *) echo \"unsupported oauth2-proxy architecture: \$arch\" >&2; exit 1 ;;
esac
if command -v oauth2-proxy >/dev/null 2>&1 && oauth2-proxy --version 2>&1 | grep -Fq \"\$version\"; then
  exit 0
fi
tmp_dir=\"\$(mktemp -d)\"
trap 'rm -rf \"\$tmp_dir\"' EXIT
archive=\"oauth2-proxy-\$version.linux-\$arch.tar.gz\"
url=\"https://github.com/oauth2-proxy/oauth2-proxy/releases/download/\$version/\$archive\"
curl -fsSL \"\$url\" -o \"\$tmp_dir/\$archive\"
tar -xzf \"\$tmp_dir/\$archive\" -C \"\$tmp_dir\"
install -m 755 \"\$tmp_dir/oauth2-proxy-\$version.linux-\$arch/oauth2-proxy\" /usr/local/bin/oauth2-proxy"
}

configure_oidc_proxy() {
  local name="$1"
  local terminal_service="wetty.service"

  if [[ "$TERMINAL_BACKEND" == "ghostty-web" ]]; then
    terminal_service="ghostty-web.service"
  fi

  ensure_oauth2_proxy_installed "$name"
  push_oidc_env "$name"

  log "configuring oauth2-proxy in front of wetty"
  # This block writes scripts that intentionally expand their variables later inside the container.
  # shellcheck disable=SC2016
  container_bash "$name" 'set -euo pipefail
if systemctl list-unit-files tailscaled.service >/dev/null 2>&1; then
  tailscale serve --https="${TAILSCALE_SERVE_PORT:-443}" off >/dev/null 2>&1 || true
  systemctl disable --now tailscaled >/dev/null 2>&1 || true
fi
cat >/usr/local/bin/incus-web-oauth2-proxy-start <<'"'"'EOF'"'"'
#!/usr/bin/env bash
set -euo pipefail

. /etc/incus-web/oauth2-proxy.env

redirect_url="${PUBLIC_URL%/}/oauth2/callback"
args=(
  --provider=oidc
  --provider-display-name="$OIDC_PROVIDER_DISPLAY_NAME"
  --http-address="0.0.0.0:$OIDC_PROXY_PORT"
  --redirect-url="$redirect_url"
  --oidc-issuer-url="$OIDC_ISSUER_URL"
  --client-id="$OIDC_CLIENT_ID"
  --client-secret="$OIDC_CLIENT_SECRET"
  --cookie-secret="$OIDC_COOKIE_SECRET"
  --cookie-secure="$OIDC_COOKIE_SECURE"
  --reverse-proxy="$OIDC_REVERSE_PROXY"
  --email-domain="$OIDC_EMAIL_DOMAINS"
  --skip-provider-button="$OIDC_SKIP_PROVIDER_BUTTON"
  --pass-access-token=true
  --pass-authorization-header=true
  --pass-user-headers=true
  --set-xauthrequest=true
  --cookie-refresh="$OIDC_COOKIE_REFRESH"
  --cookie-expire="$OIDC_COOKIE_EXPIRE"
)

if [[ "${SETUP_ENABLED:-1}" == "1" ]]; then
  args+=(--upstream="http://127.0.0.1:$SETUP_PORT/setup/")
fi
args+=(--upstream="http://127.0.0.1:$IDENTITY_PROXY_PORT/")

if [[ -s /etc/incus-web/authenticated-emails ]]; then
  args+=(--authenticated-emails-file=/etc/incus-web/authenticated-emails)
fi

exec /usr/local/bin/oauth2-proxy "${args[@]}"
EOF
chmod 755 /usr/local/bin/incus-web-oauth2-proxy-start
. /etc/incus-web/oauth2-proxy.env
cat >/etc/systemd/system/incus-web-identity-proxy.service <<EOF
[Unit]
Description=incus-web identity proxy
After=network-online.target '"$terminal_service"'
Wants=network-online.target '"$terminal_service"'

[Service]
Environment=HOST=127.0.0.1
Environment=PORT=$IDENTITY_PROXY_PORT
Environment=TARGET_HOST=127.0.0.1
Environment=TARGET_PORT=$WETTY_PORT
Environment=OAUTH2_PROXY_URL=http://127.0.0.1:$OIDC_PROXY_PORT
ExecStart=/usr/local/bin/incus-web-identity-proxy
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
cat >/etc/systemd/system/oauth2-proxy.service <<'"'"'EOF'"'"'
[Unit]
Description=OAuth2 Proxy for incus-web
After=network-online.target incus-web-identity-proxy.service
Wants=network-online.target incus-web-identity-proxy.service

[Service]
ExecStart=/usr/local/bin/incus-web-oauth2-proxy-start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now incus-web-identity-proxy
systemctl enable --now oauth2-proxy'
}

configure_oidc_host_proxy() {
  local name="$1"

  if [[ -n "$OIDC_HOST_PORT" ]]; then
    log "exposing oauth2-proxy on host $OIDC_HOST_BIND:$OIDC_HOST_PORT"
    incus_cmd config device remove "$name" oidc-proxy >/dev/null 2>&1 || true
    incus_cmd config device add "$name" oidc-proxy proxy \
      "listen=tcp:$OIDC_HOST_BIND:$OIDC_HOST_PORT" \
      "connect=tcp:127.0.0.1:$OIDC_PROXY_PORT"
  else
    incus_cmd config device remove "$name" oidc-proxy >/dev/null 2>&1 || true
  fi
}

join_tailnet_and_serve() {
  local name="$1"

  ensure_tailscale_installed "$name"
  push_tailscale_env "$name"

  log "joining tailnet and configuring tailscale serve"
  # Expand the Tailscale values inside the container after sourcing the pushed env file.
  # shellcheck disable=SC2016
  container_bash "$name" 'set -euo pipefail
. /etc/incus-web/tailscale.env
tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" $TS_EXTRA_ARGS
tailscale serve --bg --https="$TAILSCALE_SERVE_PORT" "http://127.0.0.1:$WETTY_PORT"
rm -f /etc/incus-web/tailscale.env
tailscale serve status'
}

configure_access() {
  local name="$1"

  case "$ACCESS_MODE" in
    tailscale)
      join_tailnet_and_serve "$name"
      ;;
    oidc)
      configure_oidc_proxy "$name"
      configure_oidc_host_proxy "$name"
      ;;
    none)
      [[ "${INCUS_WEB_ALLOW_NO_ACCESS:-0}" == "1" ]] || die "ACCESS_MODE=none requires INCUS_WEB_ALLOW_NO_ACCESS=1"
      log "skipping external access configuration for isolated validation"
      ;;
    *)
      die "unsupported ACCESS_MODE: $ACCESS_MODE"
      ;;
  esac
}

validate_container() {
  local name="$1"
  local public_host=""

  if [[ -n "${PUBLIC_URL:-}" ]]; then
    public_host="${PUBLIC_URL#*://}"
    public_host="${public_host%%/*}"
    public_host="${public_host%%:*}"
  fi

  log "validating toolchain and network boundaries"
  validate_container_signals "$name"

  agent_check() {
    local command="$1"
    container_bash "$name" "runuser -u '$WEB_USER' -- env HOME='/home/$WEB_USER' USER='$WEB_USER' LOGNAME='$WEB_USER' /usr/local/bin/agent-env $command"
  }

  expect_blocked_lan() {
    local host="$1"
    local port="$2"
    if agent_check "nc -vz -w 2 $host $port" >/tmp/incus-web-lan-check.log 2>&1; then
      cat /tmp/incus-web-lan-check.log >&2
      die "LAN egress unexpectedly succeeded: $host:$port"
    fi
  }

  agent_check "node --version"
  agent_check "npm --version"
  agent_check "python3 --version"
  agent_check "go version"
  agent_check "rustc -V"
  agent_check "cargo -V"
  agent_check "git --version"
  agent_check "gh --version"
  agent_check "zsh --version"
  agent_check "claude --version"
  agent_check "codex --version"
  case "$ACCESS_MODE" in
    tailscale)
      container_bash "$name" "tailscale version >/dev/null"
      container_bash "$name" "tailscale status >/dev/null"
      ;;
    oidc)
      container_bash "$name" "oauth2-proxy --version >/dev/null"
      container_bash "$name" "systemctl is-active --quiet incus-web-identity-proxy"
      container_bash "$name" "systemctl is-active --quiet oauth2-proxy"
      container_bash "$name" "curl -fsSI 'http://127.0.0.1:$IDENTITY_PROXY_PORT/' >/dev/null"
      container_bash "$name" "curl -fsSI 'http://127.0.0.1:$OIDC_PROXY_PORT/oauth2/sign_in' >/dev/null"
      if [[ "$SETUP_ENABLED" == "1" ]]; then
        container_bash "$name" "systemctl is-active --quiet incus-web-setup"
        container_bash "$name" "curl -fsSI 'http://127.0.0.1:$OIDC_PROXY_PORT/setup/' >/dev/null"
      fi
      ;;
  esac
  case "$TERMINAL_BACKEND" in
    wetty)
      container_bash "$name" "systemctl is-active --quiet wetty"
      container_bash "$name" "curl -fsSI 'http://127.0.0.1:$WETTY_PORT/' >/dev/null"
      ;;
    ghostty-web)
      container_bash "$name" "! systemctl is-active --quiet wetty"
      container_bash "$name" "systemctl is-active --quiet ghostty-web"
      container_bash "$name" "curl -fsS 'http://127.0.0.1:$WETTY_PORT/api/token' | jq -e '.token | type == \"string\" and length > 0' >/dev/null"
      if [[ -n "$public_host" ]]; then
        container_bash "$name" "curl -fsS -H 'Host: $public_host' -H 'Origin: ${PUBLIC_URL%/}' 'http://127.0.0.1:$WETTY_PORT/api/token' | jq -e '.token | type == \"string\" and length > 0' >/dev/null"
      fi
      ;;
  esac
  if [[ "$VALIDATE_INTERNET_EGRESS" == "1" ]]; then
    agent_check "nc -vz -w 5 1.1.1.1 443"
  else
    log "skipping Internet egress probe; LAN isolation checks remain enabled"
  fi
  expect_blocked_lan 10.0.0.1 80
  expect_blocked_lan 172.16.0.1 80
  expect_blocked_lan 192.168.0.1 80
  expect_blocked_lan 169.254.0.1 80
}

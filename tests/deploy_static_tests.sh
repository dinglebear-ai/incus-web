#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy="$root/deploy.sh"
profile="$root/incus-web-profile.yaml"
definition="$root/distrobuilder.yaml"
build_image="$root/scripts/build-image.sh"
lib="$root/scripts/incus-web-lib.sh"
container_provision="$root/scripts/container-provision.sh"
info_script="$root/scripts/incus-web-info.sh"
smoke_image="$root/scripts/smoke-image.sh"
workflow="$root/.github/workflows/build-image.yml"
release_workflow="$root/.github/workflows/release.yml"
backup_state="$root/scripts/backup-state.sh"
contract_doc="$root/docs/contracts/provisioner-boundary-v1.md"
provisioner_plan="$root/docs/superpowers/plans/2026-07-01-provisioner-boundary-v1.md"
env_example="$root/.env.example"

require_literal() {
  local needle="$1"
  if ! grep -Fq -- "$needle" "$deploy" "$lib" "$container_provision"; then
    printf 'missing expected deploy surface content: %s\n' "$needle" >&2
    exit 1
  fi
}

require_info_literal() {
  local needle="$1"
  if ! grep -Fq -- "$needle" "$info_script"; then
    printf 'missing expected info script content: %s\n' "$needle" >&2
    exit 1
  fi
}

require_literal "validate_container()"
require_literal "validating toolchain and network boundaries"
require_literal "ACCESS_MODE="
require_literal "node --version"
require_literal "npm --version"
require_literal "python3 --version"
require_literal "go version"
require_literal "rustc -V"
require_literal "cargo -V"
require_literal "git --version"
require_literal "gh --version"
require_literal "zsh --version"
require_literal "claude --version"
require_literal "codex --version"
require_literal "tailscale version"
require_literal "tailscale status"
require_literal "configure_oidc_proxy()"
require_literal "ensure_oauth2_proxy_installed()"
require_literal "push_oidc_env()"
require_literal "oauth2-proxy --version"
require_literal "systemctl is-active --quiet oauth2-proxy"
require_literal "http://127.0.0.1:\$OIDC_PROXY_PORT/oauth2/sign_in"
require_literal "OIDC_ISSUER_URL="
require_literal "OIDC_CLIENT_ID="
require_literal "OIDC_CLIENT_SECRET="
require_literal "OIDC_COOKIE_SECRET="
require_literal "cut -c1-32"
require_literal "OIDC_HOST_PORT="
require_literal "OAUTH2_PROXY_VERSION="
require_literal "TERMINAL_BACKEND="
require_literal "GHOSTTY_WEB_DEMO_VERSION="
require_literal "SETUP_ENABLED="
require_literal "SETUP_PORT="
require_literal "SETUP_ALLOWED_EMAILS="
require_literal "SETUP_ALLOW_KEY_PERSISTENCE="
require_literal "SETUP_COMMAND_TIMEOUT_MS="
require_literal "IDENTITY_PROXY_PORT="
require_literal "OAUTH2_PROXY_URL=http://127.0.0.1:\$OIDC_PROXY_PORT"
require_literal "incus-web-bootstrap-server"
require_literal "incus-web-identity-proxy"
require_literal "incus-web-info"
require_literal "incus-web-open"
require_literal "incus-web-ghostty-aurora-patch"
require_literal "INCUS_WEB_INFO_SCRIPT"
require_literal "INCUS_WEB_IDENTITY_PROXY"
require_literal "INCUS_WEB_OPEN_SCRIPT"
require_literal "INCUS_WEB_GHOSTTY_AURORA_PATCH"
require_literal "ENABLE_HOST_PROVISIONER="
require_literal "INCUS_WEB_PROVISIONER_SERVER="
require_literal "INCUS_WEB_PROVISIONER_SERVER_URL="
require_literal "INCUS_WEB_PROVISIONER_INSTALL_PATH="
require_literal "INCUS_WEB_PROVISIONER_ENV_FILE="
require_literal "INCUS_WEB_PROVISIONER_TOKEN_FILE="
require_literal "INCUS_WEB_PROVISIONER_SOCKET="
require_literal "INCUS_WEB_PROVISIONER_SOCKET_MODE="
require_literal "INCUS_WEB_PROVISIONER_USER="
require_literal "INCUS_WEB_PROVISIONER_GROUP="
require_literal "INCUS_WEB_PROVISIONER_INCUS_GROUP="
require_literal "INCUS_WEB_PROVISIONER_NODE="
require_literal "INCUS_WEB_APP_NPM="
require_literal "ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD="
require_literal "ENABLE_BUILD_WORKER="
require_literal "validate_build_worker_node_version"
require_literal "install_build_worker_server"
require_literal "write_build_worker_env"
require_literal "incus-web-build-worker.service"
require_literal "EnvironmentFile=\$INCUS_WEB_BUILD_WORKER_ENV_FILE"
require_literal "ExecStart=\$INCUS_WEB_PROVISIONER_NODE \$INCUS_WEB_BUILD_WORKER_INSTALL_PATH"
require_literal "http://localhost/readyz"
require_literal "build worker did not become healthy"
require_literal "ENABLE_CODEX_APP_SERVER="
require_literal "INCUS_WEB_CODEX_APP_SERVER_USER="
require_literal "INCUS_WEB_CODEX_APP_SERVER_HOST="
require_literal "INCUS_WEB_CODEX_APP_SERVER_PORT="
require_literal "INCUS_WEB_CODEX_APP_SERVER_URL="
require_literal "INCUS_WEB_CODEX_APP_SERVER_COMMAND="
require_literal "INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS="
require_literal "INCUS_WEB_CODEX_MODEL="
require_literal "ENABLE_HOST_WEB_APP="
require_literal "ENABLE_HOST_WEB_APP=0"
require_literal "INCUS_WEB_APP_DIR="
require_literal "INCUS_WEB_APP_ENV_FILE="
require_literal "INCUS_WEB_APP_USER="
require_literal "INCUS_WEB_APP_HOST="
require_literal "INCUS_WEB_APP_PORT="
require_literal "INCUS_WEB_WORKSPACE_OWNER_MODE="
require_literal "INCUS_WEB_TRUSTED_PROXY_SECRET="
require_literal "ENABLE_HOST_WEB_APP=1 requires ENABLE_HOST_PROVISIONER=1"
require_literal "INCUS_WEB_APP_USER must be an existing unprivileged user, not root"
require_literal "INCUS_WEB_TERMINAL_URL="
require_literal "INCUS_WEB_WORKSPACE_ID="
require_literal "INCUS_WEB_INCUS_PROJECT="
require_literal "INCUS_WEB_INCUS_PROJECT=\"\${INCUS_WEB_INCUS_PROJECT:-\${INCUS_PROJECT:-}}\""
require_literal "INCUS_WEB_INCUS_PROJECT=\"\$(active_incus_project)\""
require_literal "INCUS_WEB_INCUS_CONTAINER="
require_literal "BROWSER=/usr/local/bin/incus-web-open"
require_literal "INCUS_WEB_WORKSPACE_LABEL="
require_literal "--upstream=\"http://127.0.0.1:\$SETUP_PORT/setup/\""
require_literal "GHOSTTY_ALLOWED_HOSTS"
require_literal "push_ghostty_aurora_patch"
require_literal "applying Aurora chrome to ghostty-web demo"
require_literal "public_host=\"\${PUBLIC_URL#*://}\""
require_literal "DOTFILES_REPO="
require_literal "DOTFILES_SOURCE_DIR="
require_literal "DOTFILES_RUN_MISE="
require_literal "DOTFILES_SKIP_APT="
require_literal "incus-web-dotfiles-source.tgz"
require_literal "chezmoi --source"
require_info_literal "check_commands()"
require_info_literal "check_packages()"
require_info_literal "check_mise()"
require_info_literal "check_dotfiles()"
require_info_literal "base packages installed"
require_info_literal "source clean"
if grep -Fq -- "labelFromBearer" "$root/scripts/identity-proxy.mjs"; then
  printf 'identity proxy must not trust unsigned bearer-token labels\n' >&2
  exit 1
fi
if ! grep -Fq -- "queryUserinfo" "$root/scripts/identity-proxy.mjs"; then
  printf 'missing expected identity proxy userinfo fallback\n' >&2
  exit 1
fi
for needle in \
  "apps/web/**" \
  "docs/contracts/**" \
  "docs/superpowers/**" \
  "dinglebear-ai/workflows/.github/workflows/fast-node.yml@66e64b9f31de7ac1f9aa8c9f87ede9bbec5eae1d" \
  "working-directory: apps/web" \
  "lint-command: npm run lint" \
  "test-command: npm run test:coverage" \
  "build-command: npm run build"; do
  if ! grep -Fq -- "$needle" "$workflow"; then
    printf 'missing expected web CI content: %s\n' "$needle" >&2
    exit 1
  fi
done

if [[ ! -f "$contract_doc" ]]; then
  printf 'missing provisioner contract doc: %s\n' "$contract_doc" >&2
  exit 1
fi

for needle in \
  "status: \"succeeded\" requires a result and no error" \
  "status: \"failed\" requires an error and no result" \
  "WorkspaceRuntimeStatus metrics must be finite, non-negative numbers" \
  "RunSetup ageKey accepts only value and persistEncrypted"; do
  if ! grep -Fq -- "$needle" "$contract_doc" "$provisioner_plan"; then
    printf 'missing expected provisioner contract invariant: %s\n' "$needle" >&2
    exit 1
  fi
done
require_literal "nc -vz -w 5 1.1.1.1 443"
require_literal "VALIDATE_INTERNET_EGRESS"
require_literal "LAN isolation checks remain enabled"
require_literal "expect_blocked_lan 10.0.0.1 80"
require_literal "expect_blocked_lan 172.16.0.1 80"
require_literal "expect_blocked_lan 192.168.0.1 80"
require_literal "expect_blocked_lan 169.254.0.1 80"
require_literal "validate_container_signals \"\$name\""
require_literal "validate_container \"\$CONTAINER_NAME\""
require_literal "log_deploy_summary()"
require_literal "configure_host_provisioner \"\$CONTAINER_NAME\""
require_literal "configure_host_web_app"
require_literal "INCUS_PROFILE_YAML="
require_literal "INCUS_PROFILE_NAME="
require_literal "INCUS_PROFILE_URL="
require_literal "ensure_incus_profile()"
require_literal "ensure_profile_paths()"
require_literal "sudo_cmd install -d -m 755 /srv/incus-web/default-workspace"
require_literal "resolve_profile_yaml()"
require_literal "incus_cmd_stdin profile edit \"\$INCUS_PROFILE_NAME\" <\"\$INCUS_PROFILE_YAML\""
require_literal "incus_cmd init \"\$IMAGE\" \"\$CONTAINER_NAME\" \\"
require_literal "--profile default \\"
require_literal "--profile \"\$INCUS_PROFILE_NAME\""
require_literal "incus_cmd config device override \"\$CONTAINER_NAME\" eth0 network=\"\$INCUS_NETWORK\""
require_literal "incus_cmd config device override \"\$CONTAINER_NAME\" workspace source=\"\$HOST_WORKSPACE\" path=\"\$CONTAINER_WORKSPACE\" shift=\"\$DISK_SHIFT\""
require_literal "incus_cmd start \"\$CONTAINER_NAME\""
require_literal "CONTAINER_PACKAGES_PREINSTALLED=\"\${CONTAINER_PACKAGES_PREINSTALLED:-0}\""
require_literal "required preinstalled command is missing"
require_literal "pipx"
require_literal "if [[ \"\${BASH_SOURCE[0]}\" == \"\$0\" ]]; then"
require_literal "INCUS_WEB_LIB_URL="
require_literal "INCUS_WEB_SOURCE_REF="
# shellcheck disable=SC2016
require_literal 'INCUS_WEB_RAW_BASE="https://raw.githubusercontent.com/jmagar/incus-web/$INCUS_WEB_SOURCE_REF"'
require_literal "curl -fsSL \"\$INCUS_WEB_LIB_URL\" -o \"\$INCUS_WEB_LIB_TMP\""

bootstrap_env="$(mktemp)"
trap 'rm -f "$bootstrap_env"' EXIT
printf 'INCUS_WEB_SOURCE_REF=%s\n' '0123456789abcdef0123456789abcdef01234567' >"$bootstrap_env"
loaded_ref="$(ENV_FILE="$bootstrap_env" bash -c 'source "$1/deploy.sh" >/dev/null; printf "%s" "$INCUS_WEB_SOURCE_REF"' _ "$root")"
if [[ "$loaded_ref" != "0123456789abcdef0123456789abcdef01234567" ]]; then
  printf 'deploy.sh did not load INCUS_WEB_SOURCE_REF from ENV_FILE before validation\n' >&2
  exit 1
fi
if ! bash -c 'source "$1" >/dev/null; CONTAINER_NAME=test; HOST_WORKSPACE=/tmp/test; CONTAINER_WORKSPACE=/workspace; ACCESS_MODE=none; log_deploy_summary >/dev/null' _ "$deploy"; then
  printf 'successful deployment summary returned a failure status\n' >&2
  exit 1
fi

if ! grep -Fq -- "INCUS_WEB_PROVISIONER_TOKEN" "$root/apps/web/lib/provisioner/host-transport.ts"; then
  printf 'missing expected host transport token config\n' >&2
  exit 1
fi
if ! grep -Fq -- "INCUS_WEB_PROVISIONER_SOCKET" "$root/apps/web/lib/provisioner/host-transport.ts"; then
  printf 'missing expected host transport socket config\n' >&2
  exit 1
fi
if ! grep -Fq -- "createHostProvisionerClient" "$root/apps/web/lib/provisioner/host-transport.ts"; then
  printf 'missing expected host transport client factory\n' >&2
  exit 1
fi
if ! grep -Fq -- "host provisioner transport is not configured" "$root/apps/web/lib/workspaces/provisioner.ts"; then
  printf 'missing expected inventory fail-closed provisioner message\n' >&2
  exit 1
fi
if ! grep -Fq -- "INCUS_WEB_WORKSPACE_ID" "$root/apps/web/lib/provisioner/status-adapter.ts"; then
  printf 'missing expected configured workspace id metadata\n' >&2
  exit 1
fi
if ! grep -Fq -- "INCUS_WEB_INCUS_PROJECT" "$root/apps/web/lib/provisioner/status-adapter.ts"; then
  printf 'missing expected configured Incus project metadata\n' >&2
  exit 1
fi
if ! grep -Fq -- "INCUS_WEB_INCUS_CONTAINER" "$root/apps/web/lib/provisioner/status-adapter.ts"; then
  printf 'missing expected configured Incus container metadata\n' >&2
  exit 1
fi
if ! grep -Fq -- "validateIncusContainerName" "$root/apps/web/lib/provisioner/contracts.ts"; then
  printf 'missing expected imported prototype container allowance\n' >&2
  exit 1
fi
# shellcheck disable=SC2016
for needle in \
  "INCUS_WEB_WORKSPACE_ID=workspace-incus-web" \
  "INCUS_WEB_INCUS_PROJECT=default" \
  "INCUS_WEB_INCUS_CONTAINER=" \
  "ENABLE_HOST_PROVISIONER=1" \
	  "INCUS_WEB_PROVISIONER_TOKEN=" \
	  "INCUS_WEB_PROVISIONER_SOCKET=/run/incus-web/provisioner.sock" \
	  "INCUS_WEB_PROVISIONER_SOCKET_MODE=0660" \
	  "INCUS_WEB_PROVISIONER_GROUP=incus-web" \
	  "ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=0" \
	  "ENABLE_BUILD_WORKER=0" \
	  "INCUS_WEB_BUILD_WORKER_SOCKET=/run/incus-web/build-worker.sock" \
	  "INCUS_WEB_BUILD_WORKER_MAX_LOG_CHUNK_BYTES=262144" \
	  "INCUS_WEB_BUILD_WORKER_MAX_LOG_BYTES_PER_BUILD=20971520" \
	  "INCUS_WEB_BUILD_WORKER_MAX_COMPLETED_BUILDS=100" \
	  "INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS=" \
	  "ENABLE_CODEX_APP_SERVER=1" \
	  "INCUS_WEB_CODEX_APP_SERVER_HOST=127.0.0.1" \
	  "INCUS_WEB_CODEX_APP_SERVER_PORT=4500" \
	  "INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS=43200000" \
	  "ENABLE_HOST_WEB_APP=" \
	  "INCUS_WEB_APP_PORT=3090" \
	  "INCUS_WEB_WORKSPACE_OWNER_MODE=none"; do
  if ! grep -Fq -- "$needle" "$env_example"; then
    printf 'missing expected provisioner env example: %s\n' "$needle" >&2
    exit 1
  fi
done

for needle in \
  "ensure_host_node()" \
  "validate_host_node_version()" \
  "validate_host_web_app_exposure()" \
  "active_incus_project()" \
  "incus_cmd project get-current" \
  "ensure_host_provisioner_identity()" \
  "ensure_host_provisioner_systemd()" \
  "validate_systemd_env_value()" \
  "validate_port_value()" \
  "validate_loopback_host_value()" \
  "validate_env_file_value()" \
  "configure_codex_app_server()" \
  "resolve_codex_app_server_command()" \
  "wait_for_codex_app_server()" \
  "incus-web-codex-app-server.service" \
  "ExecStart=\$codex_command app-server --listen \$INCUS_WEB_CODEX_APP_SERVER_URL" \
  "INCUS_WEB_CODEX_APP_SERVER_URL=%s" \
  "INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS=%s" \
  "install_host_provisioner_server()" \
  "ensure_host_provisioner_token()" \
  "write_host_provisioner_env()" \
  "write_host_provisioner_env \"\$name\"" \
  "configure_host_provisioner()" \
  "configure_host_web_app()" \
  "ensure_host_web_app_identity()" \
  "install_host_web_app_runtime()" \
  "restore_host_web_app_runtime()" \
  "write_host_web_app_env()" \
  "wait_for_host_provisioner()" \
  "wait_for_host_web_app()" \
  "host provisioner server is missing locally; set ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=1" \
  "INCUS_WEB_PROVISIONER_SERVER_URL must use https://" \
  "curl --proto '=https' --tlsv1.2 -fsSL \"\$INCUS_WEB_PROVISIONER_SERVER_URL\"" \
  "systemctl is required for ENABLE_HOST_PROVISIONER=1" \
  "systemd is not running; set ENABLE_HOST_PROVISIONER=0" \
  "incus-web-provisioner.service" \
  "User=\$INCUS_WEB_PROVISIONER_USER" \
  "Group=\$INCUS_WEB_PROVISIONER_GROUP" \
  "SupplementaryGroups=\$INCUS_WEB_PROVISIONER_INCUS_GROUP" \
  "RuntimeDirectory=incus-web" \
  "RuntimeDirectoryMode=0750" \
  "UMask=0077" \
  "NoNewPrivileges=true" \
  "ProtectSystem=full" \
  "EnvironmentFile=\$INCUS_WEB_PROVISIONER_ENV_FILE" \
  "ExecStart=\$INCUS_WEB_PROVISIONER_NODE \$INCUS_WEB_PROVISIONER_INSTALL_PATH" \
  "incus-web-app.service" \
  "User=\$INCUS_WEB_APP_USER" \
  "SupplementaryGroups=\$INCUS_WEB_PROVISIONER_GROUP" \
  "EnvironmentFile=\$INCUS_WEB_PROVISIONER_ENV_FILE" \
  "EnvironmentFile=\$INCUS_WEB_APP_ENV_FILE" \
  "sudo_cmd systemctl is-active --quiet incus-web-app" \
  "sudo_cmd systemctl is-active --quiet incus-web-provisioner" \
  "INCUS_WEB_TRUSTED_PROXY_SECRET is required when INCUS_WEB_APP_HOST is not loopback-only" \
  "INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated requires INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1" \
  "host provisioner did not become healthy" \
  "/healthz" \
  "host web app did not become healthy" \
  "INCUS_WEB_APP_HOST=%s" \
  "INCUS_WEB_APP_PORT=%s" \
  "INCUS_WEB_ALLOW_SHARED_PROTOTYPE=%s" \
  "INCUS_WEB_TRUSTED_PROXY_SECRET=%s" \
  "--unix-socket \"\$INCUS_WEB_PROVISIONER_SOCKET\"" \
  "/opt/incus-web-app.new" \
  "/opt/incus-web-app.previous" \
  "\"\$INCUS_WEB_APP_NPM\" ci --prefix \"\$INCUS_WEB_APP_DIR\"" \
  "host Next.js web app build is current" \
  "sudo_cmd test -f \"\$INCUS_WEB_PROVISIONER_ENV_FILE\"" \
  "sudo_cmd install -m 640 -g \"\$INCUS_WEB_PROVISIONER_GROUP\" \"\$tmp_file\" \"\$INCUS_WEB_PROVISIONER_ENV_FILE\"" \
  "sudo_cmd install -m 640 -g \"\$INCUS_WEB_PROVISIONER_GROUP\" \"\$tmp_file\" \"\$token_file\""; do
  if ! grep -Fq -- "$needle" "$lib"; then
    printf 'missing expected host provisioner deploy content: %s\n' "$needle" >&2
    exit 1
  fi
done

if grep -Fq -- "Group=\$INCUS_WEB_APP_USER" "$lib"; then
  printf 'host web app systemd unit must not assume user and group names match\n' >&2
  exit 1
fi

if ! grep -Fq -- "scripts/provisioner-server.mjs" "$contract_doc" "$root/docs/contracts/multi-tenant-control-plane-v1.md"; then
  printf 'missing expected provisioner server docs\n' >&2
  exit 1
fi
if ! grep -Fq -- "host-local is the default provisioner mode" "$contract_doc"; then
  printf 'missing expected host-local default docs\n' >&2
  exit 1
fi
for needle in \
  'INCUS_WEB_WORKSPACE_STATE_DB' \
  'INCUS_WEB_BUILD_WORKER_DB' \
  'INCUS_WEB_AGENT_RUN_STORE_PATH' \
  'INCUS_WEB_PROVISIONER_STATE_DB' \
  "\"agent-runs:\$agent_runs_db\"" \
  "\"provisioner:\$provisioner_db\""; do
  if ! grep -Fq -- "$needle" "$backup_state"; then
    printf 'missing expected durable backup surface: %s\n' "$needle" >&2
    exit 1
  fi
done
if ! grep -Fq -- "Next.js request handlers must continue to call the provisioner contract" "$contract_doc"; then
  printf 'missing expected Next.js boundary docs\n' >&2
  exit 1
fi
if ! grep -Fq -- "Unix socket preferred, loopback HTTP allowed only as a configured fallback" "$root/docs/contracts/multi-tenant-control-plane-v1.md"; then
  printf 'missing expected host-local security requirement docs\n' >&2
  exit 1
fi
if ! grep -Fq -- "Incus project \`default\` and container \`incus-web\`" "$contract_doc"; then
  printf 'missing expected imported prototype tuple docs\n' >&2
  exit 1
fi
if ! grep -Fq -- "ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD" "$root/README.md"; then
  printf 'missing expected remote provisioner download docs\n' >&2
  exit 1
fi

for needle in \
  "requireConfiguredToken(" \
  "verifyBearerToken(req.headers.authorization, expectedToken)" \
  "INCUS_WEB_PROVISIONER_HOST must be loopback-only" \
  "unlinkExistingSocket(socketPath)" \
  "socketAcceptsConnections(path)" \
  "INCUS_WEB_PROVISIONER_STATUS_CACHE_TTL_MS" \
  "INCUS_WEB_PROVISIONER_MAX_INCUS_COMMANDS" \
  "INCUS_WEB_PROVISIONER_MAX_OUTPUT_BYTES" \
  "workspace tuple did not match host provisioner metadata" \
  "withIncusProject(path)" \
  "project=\${encodeURIComponent(incusProject)}" \
  "mapIncusState(state.status, state.status_code)" \
  "case 103:" \
  "INCUS_WEB_PROVISIONER_SOCKET_MODE" \
  "chmod(socketPath, socketMode)" \
  "GetWorkspaceStatus" \
  "StartWorkspace" \
  "StopWorkspace" \
  "RestartWorkspace" \
  "SetWorkspaceLimits" \
  "failed to complete workspace operation through Incus"; do
  if ! grep -Fq -- "$needle" "$root/scripts/provisioner-server.mjs"; then
    printf 'missing expected host provisioner server content: %s\n' "$needle" >&2
    exit 1
  fi
done

if ! grep -Fq -- "scripts/**" "$workflow"; then
  printf 'missing expected complete production-script workflow trigger\n' >&2
  exit 1
fi

for needle in \
  "\${envVarName} is required" \
  "timingSafeEqual"; do
  if ! grep -Fq -- "$needle" "$root/scripts/service-auth.mjs"; then
    printf 'missing expected shared service-auth content: %s\n' "$needle" >&2
    exit 1
  fi
done
if ! grep -Fq -- "find scripts -type f -name '*.mjs'" "$workflow"; then
  printf 'missing expected production server workflow validation\n' >&2
  exit 1
fi

if [[ ! -f "$lib" ]]; then
  printf 'missing shared provisioning library: %s\n' "$lib" >&2
  exit 1
fi

if [[ ! -f "$container_provision" ]]; then
  printf 'missing tracked container provisioning program: %s\n' "$container_provision" >&2
  exit 1
fi

for needle in \
  'WEB_USER is required' \
  'incus-web-setup.service' \
  'ghostty-web.service' \
  'wetty.service'; do
  if ! grep -Fq -- "$needle" "$container_provision"; then
    printf 'missing expected container provisioning content: %s\n' "$needle" >&2
    exit 1
  fi
done

for needle in \
  "provision_container()" \
  "push_container_provision_program()" \
  '/usr/local/lib/incus-web/container-provision.sh' \
  "ensure_tailscale_installed()" \
  "validate_container()" \
  "SCRIPT_DIR="; do
  if ! grep -Fq -- "$needle" "$lib"; then
    printf 'missing expected shared library content: %s\n' "$needle" >&2
    exit 1
  fi
done

if [[ ! -f "$profile" ]]; then
  printf 'missing Incus profile source of truth: %s\n' "$profile" >&2
  exit 1
fi

for needle in \
  "name: incus-web-agent" \
  "security.privileged: \"false\"" \
  "security.nesting: \"true\"" \
  "raw.apparmor: |-" \
  "signal peer=@{profile_name}//&unconfined," \
  "limits.cpu: \"2\"" \
  "limits.memory: 4GiB" \
  "limits.memory.enforce: \"hard\"" \
  "limits.processes: \"2048\"" \
  "network: agentbr0" \
  "source: /srv/incus-web/default-workspace" \
  "path: /workspace" \
  "shift: \"true\""; do
  if ! grep -Fq -- "$needle" "$profile"; then
    printf 'missing expected profile content: %s\n' "$needle" >&2
    exit 1
  fi
done

if [[ ! -f "$build_image" ]]; then
  printf 'missing CI image build script: %s\n' "$build_image" >&2
  exit 1
fi

if [[ ! -f "$definition" ]]; then
  printf 'missing distrobuilder image definition: %s\n' "$definition" >&2
  exit 1
fi

for needle in \
  "downloader: debootstrap" \
  "release: trixie" \
  "name: incus-web-agent" \
  "build-essential" \
  "zsh" \
  "golang-go" \
  "pipx" \
  "rustc" \
  'node_version="22.17.0"' \
  "npm install -g @anthropic-ai/claude-code@2.1.212" \
  "npm install -g wetty@3.2.0" \
  "@ghostty-web/demo@0.4.0-next.20.g1858a59" \
  "ghostty-web-demo" \
  "https://pkgs.tailscale.com/stable/\$tailscale_archive" \
  "npm install -g @openai/codex@0.144.3" \
  "systemctl enable wetty.service" \
  "systemctl enable tailscaled.service"; do
  if ! grep -Fq -- "$needle" "$definition"; then
    printf 'missing expected distrobuilder content: %s\n' "$needle" >&2
    exit 1
  fi
done
if ! grep -A8 -F -- "trigger: post-files" "$definition" | grep -Fq -- "systemctl enable wetty.service"; then
  printf 'wetty must be enabled after its unit file is injected\n' >&2
  exit 1
fi

# shellcheck disable=SC2016
for needle in \
  "DISTROBUILDER_YAML" \
  "distrobuilder build-incus" \
  "IMAGE_ALIAS" \
  "BUILD_TYPE" \
  "mv \"\$EXPORT_DIR/incus.tar.xz\" \"\$EXPORT_DIR/\$IMAGE_ALIAS.tar.xz\""; do
  if ! grep -Fq -- "$needle" "$build_image"; then
    printf 'missing expected build-image.sh content: %s\n' "$needle" >&2
    exit 1
  fi
done

if [[ ! -f "$smoke_image" ]]; then
  printf 'missing exported image smoke script: %s\n' "$smoke_image" >&2
  exit 1
fi

# shellcheck disable=SC2016
for needle in \
  '. "$ROOT/scripts/incus-web-lib.sh"' \
  "incus_cmd image import \"\$image_tar\" --alias \"\$SMOKE_IMAGE_ALIAS\"" \
  "incus_cmd init \"\$SMOKE_IMAGE_ALIAS\" \"\$SMOKE_CONTAINER_NAME\"" \
  "validate_container_signals \"\$SMOKE_CONTAINER_NAME\"" \
  "node --version" \
  "python3 --version" \
  "go version" \
  "rustc -V" \
  "claude --version" \
  "tailscale version" \
  "codex --version"; do
  if ! grep -Fq -- "$needle" "$smoke_image"; then
    printf 'missing expected smoke-image.sh content: %s\n' "$needle" >&2
    exit 1
  fi
done

if [[ ! -f "$workflow" ]]; then
  printf 'missing CI image workflow: %s\n' "$workflow" >&2
  exit 1
fi
if [[ ! -f "$release_workflow" ]]; then
  printf 'missing release image workflow: %s\n' "$release_workflow" >&2
  exit 1
fi

# shellcheck disable=SC2016
for needle in \
  "name: CI" \
  "pull_request:" \
  "distrobuilder.yaml" \
  "scripts/**" \
  "tests/**" \
  "bash tests/deploy_static_tests.sh" \
  "dinglebear-ai/workflows/.github/workflows/fast-node.yml@66e64b9f31de7ac1f9aa8c9f87ede9bbec5eae1d" \
  "dinglebear-ai/workflows/.github/workflows/fast-ops.yml@66e64b9f31de7ac1f9aa8c9f87ede9bbec5eae1d" \
  "dinglebear-ai/workflows/.github/workflows/fleet-contract.yml@66e64b9f31de7ac1f9aa8c9f87ede9bbec5eae1d" \
  "profile: node" \
  "contents: read"; do
  if ! grep -Fq -- "$needle" "$workflow"; then
    printf 'missing expected workflow content: %s\n' "$needle" >&2
    exit 1
  fi
done

# shellcheck disable=SC2016
for needle in \
  "name: Release Incus image" \
  "types: [published]" \
  "dinglebear-ai/workflows/.github/workflows/hosted-incus-image.yml@66e64b9f31de7ac1f9aa8c9f87ede9bbec5eae1d" \
  "dinglebear-ai/workflows/.github/workflows/github-release.yml@66e64b9f31de7ac1f9aa8c9f87ede9bbec5eae1d" \
  "checkout-ref: \${{ github.event.release.tag_name }}" \
  "shellcheck debootstrap squashfs-tools" \
  "snap install distrobuilder --classic" \
  "sudo incus admin init --minimal" \
  "sudo -E ./scripts/build-image.sh" \
  "sudo -E ./scripts/smoke-image.sh" \
  "permissions:" \
  "contents: read" \
  "contents: write" \
  "retention-days: 14" \
  'sudo chown -R "$(id -u):$(id -g)" "$EXPORT_DIR"' \
  "incus-web-agent-image"; do
  if ! grep -Fq -- "$needle" "$release_workflow"; then
    printf 'missing expected release workflow content: %s\n' "$needle" >&2
    exit 1
  fi
done

if ! grep -Fq -- "ReadWritePaths=/opt/incus-web-app/.next/cache \$INCUS_WEB_GOLDEN_CONFIG_DIR" "$root/scripts/incus-web-lib.sh"; then
  printf 'host web unit must allow writes to the golden-config staging directory\n' >&2
  exit 1
fi

for needle in \
  '/usr/local/lib/incus-web/current/provisioner-server.mjs' \
  '/usr/local/lib/incus-web/current/agent-runs.mjs' \
  '/usr/local/lib/incus-web/current/service-auth.mjs'; do
  if ! grep -Fq -- "$needle" "$root/scripts/auto-redeploy-provisioner.sh"; then
    printf 'auto-redeploy must target the active release path: %s\n' "$needle" >&2
    exit 1
  fi
done

printf 'deploy validation checks are wired\n'

#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${INCUS_WEB_REPO_DIR:-/home/jmagar/workspace/incus-web}"
BRANCH="main"
PROVISIONER_INSTALL_PATH="${INCUS_WEB_PROVISIONER_INSTALL_PATH:-/usr/local/lib/incus-web/provisioner-server.mjs}"
AGENT_RUNS_INSTALL_PATH="${INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH:-/usr/local/lib/incus-web/agent-runs.mjs}"
SERVICE_NAME="incus-web-provisioner.service"

log() {
  printf '[auto-redeploy] %s\n' "$*"
}

cd "$REPO_DIR"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  log "skipping: checked out on $current_branch, not $BRANCH"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "skipping: working tree has uncommitted changes"
  exit 0
fi

git fetch origin "$BRANCH" --quiet

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"

if [[ "$local_sha" != "$remote_sha" ]]; then
  log "fast-forwarding $BRANCH: $local_sha -> $remote_sha"
  git merge --ff-only "origin/$BRANCH"
fi

changed=0

if ! cmp -s scripts/provisioner-server.mjs "$PROVISIONER_INSTALL_PATH" 2>/dev/null; then
  log "syncing scripts/provisioner-server.mjs -> $PROVISIONER_INSTALL_PATH"
  sudo install -m 755 scripts/provisioner-server.mjs "$PROVISIONER_INSTALL_PATH"
  changed=1
fi

if ! cmp -s scripts/agent-runs.mjs "$AGENT_RUNS_INSTALL_PATH" 2>/dev/null; then
  log "syncing scripts/agent-runs.mjs -> $AGENT_RUNS_INSTALL_PATH"
  sudo install -m 644 scripts/agent-runs.mjs "$AGENT_RUNS_INSTALL_PATH"
  changed=1
fi

if [[ "$changed" == "1" ]]; then
  log "restarting $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  log "redeploy complete"
else
  log "no provisioner changes to deploy"
fi

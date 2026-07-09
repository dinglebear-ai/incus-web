#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${INCUS_WEB_REPO_DIR:-/home/jmagar/workspace/incus-web}"
BRANCH="main"
PROVISIONER_INSTALL_PATH="${INCUS_WEB_PROVISIONER_INSTALL_PATH:-/usr/local/lib/incus-web/provisioner-server.mjs}"
AGENT_RUNS_INSTALL_PATH="${INCUS_WEB_PROVISIONER_AGENT_RUNS_INSTALL_PATH:-/usr/local/lib/incus-web/agent-runs.mjs}"
SERVICE_AUTH_INSTALL_PATH="${INCUS_WEB_PROVISIONER_SERVICE_AUTH_INSTALL_PATH:-/usr/local/lib/incus-web/service-auth.mjs}"
AGENT_RUN_STORE_PATH="${INCUS_WEB_AGENT_RUN_STORE_PATH:-/var/lib/incus-web/agent-runs.json}"
SERVICE_NAME="incus-web-provisioner.service"
# Marks that files were synced but the restart was deferred because a run
# was in progress. Persists across ticks so a deferred restart isn't
# silently forgotten once cmp stops seeing a diff (files are already synced).
PENDING_RESTART_MARKER="${INCUS_WEB_PROVISIONER_PENDING_RESTART_MARKER:-/var/lib/incus-web/.auto-redeploy-pending-restart}"

log() {
  printf '[auto-redeploy] %s\n' "$*"
}

# Restarting the provisioner mid-dispatch kills the in-flight
# executeAgentRun continuation, silently orphaning the run in the store
# at whatever phase it was in. Check for any non-terminal run before
# restarting; if one is active, sync files but defer the restart to the
# next tick rather than dropping it.
has_active_agent_run() {
  [[ -f "$AGENT_RUN_STORE_PATH" ]] || return 1
  AGENT_RUN_STORE_PATH="$AGENT_RUN_STORE_PATH" python3 -c '
import json, os, sys

path = os.environ["AGENT_RUN_STORE_PATH"]
try:
    with open(path) as f:
        runs = json.load(f)
except Exception:
    sys.exit(1)

terminal = {"succeeded", "failed"}
for run in runs:
    if run.get("status") not in terminal:
        sys.exit(0)
sys.exit(1)
'
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

# provisioner-server.mjs imports this by relative path -- if it's ever
# missing (fresh host, a directory that got wiped and only partially
# restored) the service crash-loops with ERR_MODULE_NOT_FOUND instead of
# just picking up a stale copy, so it's synced the same as the other two.
if ! cmp -s scripts/service-auth.mjs "$SERVICE_AUTH_INSTALL_PATH" 2>/dev/null; then
  log "syncing scripts/service-auth.mjs -> $SERVICE_AUTH_INSTALL_PATH"
  sudo install -m 644 scripts/service-auth.mjs "$SERVICE_AUTH_INSTALL_PATH"
  changed=1
fi

if [[ "$changed" == "1" ]]; then
  sudo touch "$PENDING_RESTART_MARKER"
fi

if [[ -f "$PENDING_RESTART_MARKER" ]]; then
  if has_active_agent_run; then
    log "deferring restart: an agent run is currently in progress -- files synced, will retry restart next tick"
  else
    log "restarting $SERVICE_NAME"
    sudo systemctl restart "$SERVICE_NAME"
    sudo rm -f "$PENDING_RESTART_MARKER"
    log "redeploy complete"
  fi
elif [[ "$changed" == "0" ]]; then
  log "no provisioner changes to deploy"
fi

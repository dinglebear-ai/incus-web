#!/usr/bin/env bash
set -euo pipefail

# Builds/refreshes incus-web-agent-golden, the Incus container that
# DispatchAgentRun clones per agent run (see scripts/agent-runs.mjs
# copyArgsForRun). Built by cloning the live incus-web container (so it
# starts from the same base image/tooling), then stripping all user
# credentials/history and installing the codex CLI, which incus-web does
# not have. No agent CLI credentials are baked in -- those are injected
# per-dispatch from the incus-web container at run time (see
# scripts/agent-runs.mjs executeAgentRun's injecting_credentials phase).

SOURCE_CONTAINER="${INCUS_WEB_AGENT_GOLDEN_SOURCE:-incus-web}"
GOLDEN_CONTAINER="${INCUS_WEB_AGENT_GOLDEN_CONTAINER:-incus-web-agent-golden}"
GOLDEN_PROJECT="${INCUS_WEB_AGENT_GOLDEN_PROJECT:-default}"
# Per-dispatch clones use `incus copy` on whatever pool the golden container
# lives on. A plain `dir` pool does a full file-by-file copy on every clone
# (multi-GB, multi-minute per dispatch); a COW-capable pool (zfs/btrfs) makes
# clones near-instant. This host already has labby-zfs for exactly this
# "golden template, fast clones" pattern (see labby-golden) -- use it here
# too rather than the default dir pool.
GOLDEN_STORAGE_POOL="${INCUS_WEB_AGENT_GOLDEN_STORAGE_POOL:-labby-zfs}"
RECREATE="${FORCE_RECREATE:-${RECREATE:-0}}"

log() {
  printf '[build-agent-golden] %s\n' "$*"
}

die() {
  printf '[build-agent-golden] error: %s\n' "$*" >&2
  exit 1
}

if incus list "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" --format csv -c n 2>/dev/null | grep -qx "$GOLDEN_CONTAINER"; then
  if [[ "$RECREATE" != "1" ]]; then
    die "$GOLDEN_CONTAINER already exists in project $GOLDEN_PROJECT; set FORCE_RECREATE=1 to rebuild it"
  fi
  log "FORCE_RECREATE=1: deleting existing $GOLDEN_CONTAINER"
  incus delete "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" --force
fi

incus list "$SOURCE_CONTAINER" --format csv -c n 2>/dev/null | grep -qx "$SOURCE_CONTAINER" \
  || die "source container $SOURCE_CONTAINER not found -- this script clones it as the golden base"

source_was_running=0
if incus list "$SOURCE_CONTAINER" --format csv -c s 2>/dev/null | grep -qix "RUNNING"; then
  source_was_running=1
fi

# incus copy requires the source to be either fully stopped or supports a
# running-source copy in newer Incus, but stopping first avoids any risk of
# copying an inconsistent filesystem snapshot of the user's live workspace.
if [[ "$source_was_running" == "1" ]]; then
  log "stopping $SOURCE_CONTAINER for a clean copy"
  incus stop "$SOURCE_CONTAINER"
fi

log "copying $SOURCE_CONTAINER -> $GOLDEN_CONTAINER (storage pool: $GOLDEN_STORAGE_POOL)"
incus copy "$SOURCE_CONTAINER" "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" --storage "$GOLDEN_STORAGE_POOL"

if [[ "$source_was_running" == "1" ]]; then
  log "restarting $SOURCE_CONTAINER (it's the user's live daily workspace)"
  incus start "$SOURCE_CONTAINER"
fi

log "stripping host-specific devices copied from $SOURCE_CONTAINER (port proxies, live workspace mount)"
for device in ghostty-direct oidc-proxy workspace; do
  incus config device remove "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" "$device" 2>/dev/null || true
done

log "starting $GOLDEN_CONTAINER to provision it"
incus start "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT"
sleep 3

log "stripping credentials, secrets, and shell history from the golden image"
incus exec "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" -- bash -c '
set -e
rm -rf /home/agent/.ssh
rm -rf /home/agent/.gnupg
rm -f /home/agent/.claude/.credentials.json
rm -f /home/agent/.claude.json
rm -f /home/agent/.codex/.credentials.json
rm -f /home/agent/.gemini/gemini-credentials.json
rm -f /home/agent/.local/share/gogcli/credentials.json
rm -f /home/agent/.npmrc
rm -f /home/agent/.zshrc.secrets
rm -f /home/agent/.bash_history /home/agent/.zsh_history
rm -rf /home/agent/.atuin
rm -rf /home/agent/.config
rm -rf /home/agent/.cache
'

log "seeding /root/.claude.json (non-secret account identity metadata)"
# execInContainer/execInAgentContainer run as root (no --user is passed
# anywhere in this codebase's exec plumbing) inside cloned run containers,
# so $HOME there is /root, not /home/agent. Claude CLI needs .claude.json's
# identity fields (oauthAccount, userID, feature-flag cache -- no bearer
# token lives here, that's .claude/.credentials.json, injected fresh
# per-dispatch by scripts/agent-runs.mjs) alongside an injected
# .credentials.json to recognize a valid login; without it `claude -p`
# reports "Not logged in" even with a valid credentials file.
incus exec "$SOURCE_CONTAINER" -- cat /home/agent/.claude.json \
  | incus exec "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" -- bash -c 'cat > /root/.claude.json'

log "installing codex CLI (not present on the source image)"
incus exec "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" -- npm install -g @openai/codex

log "verifying golden image"
incus exec "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT" -- bash -c '
  git --version >/dev/null
  claude --version >/dev/null 2>&1 || true
  codex --version >/dev/null
  test -d /home/agent
  test -f /root/.claude.json
  ! test -f /home/agent/.claude/.credentials.json
  ! test -f /home/agent/.claude.json
  ! test -f /home/agent/.codex/.credentials.json
  ! test -f /root/.claude/.credentials.json
  ! test -f /root/.codex/auth.json
  ! test -d /home/agent/.ssh
'

log "stopping $GOLDEN_CONTAINER (golden images stay stopped between dispatches)"
incus stop "$GOLDEN_CONTAINER" --project "$GOLDEN_PROJECT"

log "done: $GOLDEN_CONTAINER is ready in project $GOLDEN_PROJECT"

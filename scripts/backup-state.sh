#!/usr/bin/env bash
set -euo pipefail

command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 is required" >&2; exit 1; }
mode="${1:-backup}"
backup_dir="${2:-/var/backups/incus-web/$(date -u +%Y%m%dT%H%M%SZ)}"
workspace_db="${INCUS_WEB_WORKSPACE_STATE_DB:-/var/lib/incus-web-app/workspace-state.sqlite3}"
build_db="${INCUS_WEB_BUILD_WORKER_DB:-/var/lib/incus-web/build-worker/builds.sqlite3}"
agent_runs_db="${INCUS_WEB_AGENT_RUN_STORE_PATH:-/var/lib/incus-web/agent-runs.sqlite}"
provisioner_db="${INCUS_WEB_PROVISIONER_STATE_DB:-/var/lib/incus-web/provisioner.sqlite}"

case "$mode" in
  backup)
    install -d -m 700 "$backup_dir"
    for entry in \
      "workspace:$workspace_db" \
      "build-worker:$build_db" \
      "agent-runs:$agent_runs_db" \
      "provisioner:$provisioner_db"; do
      name="${entry%%:*}"
      source_db="${entry#*:}"
      [[ -f "$source_db" ]] || continue
      sqlite3 "$source_db" ".timeout 5000" ".backup '$backup_dir/$name.sqlite3'"
      sqlite3 "$backup_dir/$name.sqlite3" "PRAGMA integrity_check" | grep -qx ok
    done
    (cd "$backup_dir" && sha256sum ./*.sqlite3 > SHA256SUMS)
    printf 'backup written to %s\n' "$backup_dir"
    ;;
  verify)
    (cd "$backup_dir" && sha256sum -c SHA256SUMS)
    for database in "$backup_dir"/*.sqlite3; do
      sqlite3 "$database" "PRAGMA integrity_check" | grep -qx ok
    done
    printf 'backup verified: %s\n' "$backup_dir"
    ;;
  *)
    echo "usage: $0 backup|verify [directory]" >&2
    exit 2
    ;;
esac

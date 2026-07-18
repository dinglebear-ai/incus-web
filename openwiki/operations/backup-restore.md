# Backup and Restore

Workspace activity/telemetry, build-worker metadata, agent-run history, and provisioner idempotency records use SQLite/WAL. Back up all four stores together with SQLite's online backup API rather than copying the main database files alone:

```bash
sudo scripts/backup-state.sh backup /var/backups/incus-web/manual
sudo scripts/backup-state.sh verify /var/backups/incus-web/manual
```

Recommended local targets are daily backups with a 24-hour RPO and tested quarterly restores. Replicate the backup directory off-host according to the host storage policy.

To restore, stop `incus-web-app`, `incus-web-build-worker`, and `incus-web-provisioner`; verify the backup; preserve the current database files; and restore `workspace.sqlite3`, `build-worker.sqlite3`, `agent-runs.sqlite3`, and `provisioner.sqlite3` to their configured paths with the owning service's mode and ownership. Run `PRAGMA integrity_check` before service start, then start the provisioner and build worker before the app and verify `/readyz`. Restoring the provisioner and agent-run databases as one recovery set preserves mutation replay and run reconciliation semantics.

These databases do not contain workspace files, Incus container root filesystems, or published image assets. Back up the workspace host mount, Incus storage pool/snapshots, and immutable GitHub image releases separately. Idempotency and queued-build history are part of the databases and must be restored consistently before accepting mutations.

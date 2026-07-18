# Backup and Restore

Workspace activity/telemetry and build-worker metadata use SQLite/WAL. Back them up with SQLite's online backup API rather than copying the main database file alone:

```bash
sudo scripts/backup-state.sh backup /var/backups/incus-web/manual
sudo scripts/backup-state.sh verify /var/backups/incus-web/manual
```

Recommended local targets are daily backups with a 24-hour RPO and tested quarterly restores. Replicate the backup directory off-host according to the host storage policy.

To restore, stop `incus-web-app` and `incus-web-build-worker`, verify the backup, preserve the current database files, copy the selected `.sqlite3` files to the configured paths with their service ownership/mode, then start the services and verify `/readyz`. Run `PRAGMA integrity_check` before service start.

These databases do not contain workspace files, Incus container root filesystems, or published image assets. Back up the workspace host mount, Incus storage pool/snapshots, and immutable GitHub image releases separately. Idempotency and queued-build history are part of the databases and must be restored consistently before accepting mutations.

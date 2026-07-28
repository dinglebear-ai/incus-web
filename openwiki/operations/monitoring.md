---
type: Playbook
title: "Monitoring and alerts"
description: "Use GET /healthz only for process liveness. Route traffic and page operators from GET /readyz, which checks both durable SQLite state and an authenticated provisioner operation. Prometheus-compatible dependency gauges"
---

# Monitoring and alerts

Use `GET /healthz` only for process liveness. Route traffic and page operators from `GET /readyz`, which checks both durable SQLite state and an authenticated provisioner operation. Prometheus-compatible dependency gauges are available at `GET /metrics`.

Alert when `incus_web_ready == 0` for two minutes. Use `incus_web_state_store_ready` and `incus_web_provisioner_ready` to identify the failing layer. For state-store failures, run the integrity and restore procedure in [Backup and Restore](backup-restore.md). For provisioner failures, inspect `systemctl status incus-web-provisioner` and `journalctl -u incus-web-provisioner`, verify the Unix socket and token-file permissions, then test `/readyz` again before restoring traffic.

Also alert on repeated systemd restarts for `incus-web-app`, `incus-web-provisioner`, and `incus-web-build-worker`, and on sustained build-queue growth. Authentication failures are emitted to the provisioner journal without bearer-token contents; aggregate that structured event as a security alert.

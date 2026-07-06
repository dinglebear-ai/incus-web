# Configuration

## Environment Variables

incus-web uses environment variables for configuration. Secrets are stored in `.env` files (never committed to git) and system env files.

## Quick Reference

### Core Container Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTAINER_NAME` | `incus-web` | Incus container name |
| `IMAGE` | `images:debian/trixie` | Base image |
| `RECREATE` | `0` | Force recreation if set to 1 |
| `WORKSPACE_HOST_PATH` | `/srv/incus-web/default-workspace` | Host workspace directory |

### Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `INCUS_NETWORK` | `agentbr0` | Managed bridge name |
| `INCUS_NETWORK_IPV4` | `198.18.0.1/15` | Bridge subnet |
| `INCUS_ACL` | `agent-block-lan` | Network ACL name |
| `ENABLE_NETWORK_ACL` | `1` | Enable RFC1918 blocking |

### Access Mode

**Tailscale:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ACCESS_MODE` | `tailscale` | Access mode: `tailscale` or `oidc` |
| `TS_AUTHKEY` | (required) | Tailscale auth key |
| `TS_HOSTNAME` | `$CONTAINER_NAME` | Tailnet hostname |
| `TS_EXTRA_ARGS` | `--accept-routes=false` | Additional Tailscale args |
| `TAILSCALE_SERVE_PORT` | `443` | HTTPS serve port |

**OIDC:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ACCESS_MODE` | (see above) | Access mode |
| `PUBLIC_URL` | (required) | Public base URL |
| `OIDC_ISSUER_URL` | (required) | OIDC provider URL |
| `OIDC_CLIENT_ID` | (required) | OIDC client ID |
| `OIDC_CLIENT_SECRET` | (required) | OIDC client secret |
| `OIDC_COOKIE_SECRET` | (required) | Cookie encryption secret |
| `OIDC_EMAIL_DOMAINS` | `*` | Allowed email domains |
| `OIDC_ALLOWED_EMAILS` | (empty) | Allowed emails (comma-separated) |
| `OIDC_PROVIDER_DISPLAY_NAME` | `OIDC` | Provider display name |
| `OIDC_PROXY_PORT` | `4180` | oauth2-proxy listen port |
| `OIDC_HOST_BIND` | `127.0.0.1` | Host bind address |
| `OIDC_HOST_PORT` | (empty) | Host port (optional) |
| `OIDC_COOKIE_SECURE` | `true` | Cookie secure flag |
| `OIDC_REVERSE_PROXY` | `true` | TLS terminates upstream |
| `OIDC_SKIP_PROVIDER_BUTTON` | `true` | Skip provider button |
| `OIDC_COOKIE_REFRESH` | `1h` | Cookie refresh interval |
| `OIDC_COOKIE_EXPIRE` | `8h` | Cookie expire time |
| `OAUTH2_PROXY_VERSION` | `v7.15.3` | oauth2-proxy version |

### Terminal Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `TERMINAL_BACKEND` | `wetty` | Terminal: `wetty` or `ghostty-web` |
| `GHOSTTY_WEB_DEMO_VERSION` | `0.4.0-next.20.g1858a59` | ghostty-web version |

### Setup

| Variable | Default | Description |
|----------|---------|-------------|
| `SETUP_ENABLED` | `1` | Enable setup endpoint |
| `SETUP_PORT` | `3080` | Setup server port |
| `SETUP_ALLOWED_EMAILS` | `$OIDC_ALLOWED_EMAILS` | Allowed emails for setup |
| `SETUP_ALLOW_KEY_PERSISTENCE` | `0` | Allow SSH key persistence |
| `SETUP_COMMAND_TIMEOUT_MS` | `1200000` | Setup command timeout (20 minutes) |

### Provisioner

**Provisioner service:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_HOST_PROVISIONER` | `1` | Install provisioner service |
| `INCUS_WEB_PROVISIONER_TOKEN` | (auto-generated) | Service bearer token |
| `INCUS_WEB_PROVISIONER_SOCKET` | `/run/incus-web/provisioner.sock` | Unix socket path |
| `INCUS_WEB_PROVISIONER_SOCKET_MODE` | `0660` | Socket permissions |
| `INCUS_WEB_PROVISIONER_HOST` | (empty) | HTTP host (fallback) |
| `INCUS_WEB_PROVISIONER_PORT` | (empty) | HTTP port (fallback) |
| `INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS` | `180000` | Per-command timeout (3 minutes) |
| `INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS` | `200000` | Overall request timeout (3.3 minutes) |
| `INCUS_WEB_PROVISIONER_MAX_OUTPUT_BYTES` | `1048576` | Max process output (1 MiB) |
| `INCUS_WEB_PROVISIONER_STATUS_CACHE_TTL_MS` | `2000` | Status cache TTL (2 seconds) |
| `INCUS_WEB_PROVISIONER_MAX_INCUS_COMMANDS` | `4` | Max concurrent Incus commands |
| `INCUS_WEB_PROVISIONER_INSTALL_PATH` | `/usr/local/lib/incus-web/provisioner-server.mjs` | Install path |
| `INCUS_WEB_PROVISIONER_USER` | `incus-web-provisioner` | Service user |
| `INCUS_WEB_PROVISIONER_GROUP` | `incus-web` | Service group |
| `INCUS_WEB_PROVISIONER_INCUS_GROUP` | `incus-admin` | Incus admin group |
| `INCUS_WEB_PROVISIONER_NODE` | `/usr/bin/node` | Node binary |
| `INCUS_WEB_PROVISIONER_ENV_FILE` | `/etc/incus-web/provisioner.env` | Environment file |

**Provisioner workspace:**
| Variable | Default | Description |
|----------|---------|-------------|
| `INCUS_WEB_WORKSPACE_ID` | `workspace-incus-web` | Workspace ID |
| `INCUS_WEB_INCUS_PROJECT` | `default` | Incus project |
| `INCUS_WEB_INCUS_CONTAINER` | `$CONTAINER_NAME` | Incus container |
| `INCUS_WEB_PROTOTYPE_SETUP_PHASE` | `ready` | Prototype setup phase |

**Agent runs:**
| Variable | Default | Description |
|----------|---------|-------------|
| `INCUS_WEB_AGENT_RUN_STORE_PATH` | `/var/lib/incus-web/agent-runs.json` | Run store path |
| `INCUS_WEB_AGENT_RUNS_INSTALL_PATH` | `/usr/local/lib/incus-web/agent-runs.mjs` | Install path |
| `INCUS_WEB_AGENT_GOLDEN_CONTAINER` | `incus-web-agent-golden` | Golden container name |
| `INCUS_WEB_AGENT_GOLDEN_PROJECT` | `$INCUS_WEB_INCUS_PROJECT` | Golden project |
| `INCUS_WEB_AGENT_RUN_PROJECT` | `$INCUS_WEB_INCUS_PROJECT` | Run project |
| `INCUS_WEB_AGENT_CREDENTIAL_SOURCE_CONTAINER` | `$CONTAINER_NAME` | Credential source |
| `INCUS_WEB_AGENT_CREDENTIAL_SOURCE_PROJECT` | `$INCUS_WEB_INCUS_PROJECT` | Credential source project |
| `INCUS_WEB_CODEX_APP_SERVER_URL` | (empty) | Codex app-server URL |
| `INCUS_WEB_CODEX_APP_SERVER_TOKEN` | (empty) | Codex app-server token |
| `INCUS_WEB_CODEX_MODEL` | (empty) | Codex model |
| `INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS` | `43200000` | Codex timeout (12 hours) |
| `INCUS_WEB_CLAUDE_COMMAND_TEMPLATE` | `claude -p {{task}}` | Claude command template |

### Control Plane

**Host web app:**
| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_HOST_WEB_APP` | (auto-detected) | Install web app service |
| `INCUS_WEB_APP_DIR` | `$SCRIPT_DIR/apps/web` | Web app directory |
| `INCUS_WEB_APP_NPM` | `/usr/bin/npm` | NPM binary |
| `INCUS_WEB_APP_HOST` | `127.0.0.1` | Listen host |
| `INCUS_WEB_APP_PORT` | `3001` | Listen port |
| `INCUS_WEB_APP_USER` | `incus-web-app` | Service user |
| `INCUS_WEB_APP_ENV_FILE` | `/etc/incus-web/web.env` | Environment file |

**Workspace ownership (prototype):**
| Variable | Default | Description |
|----------|---------|-------------|
| `INCUS_WEB_WORKSPACE_OWNER_MODE` | `none` | `authenticated` or `none` |
| `INCUS_WEB_ALLOW_SHARED_PROTOTYPE` | (empty) | Required for `authenticated` mode |

**Development actor:**
| Variable | Default | Description |
|----------|---------|-------------|
| `INCUS_WEB_DEV_ACTOR_USER_ID` | (empty) | Dev user ID |
| `INCUS_WEB_DEV_ACTOR_EMAIL` | (empty) | Dev email |
| `INCUS_WEB_DEV_ACTOR_DISPLAY_NAME` | (empty) | Dev display name |

### Identity Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `IDENTITY_PROXY_PORT` | `3090` | Identity proxy port |

### Scripts

| Variable | Default | Description |
|----------|---------|-------------|
| `INCUS_WEB_BOOTSTRAP_SERVER` | `$SCRIPT_DIR/scripts/bootstrap-server.mjs` | Bootstrap script |
| `INCUS_WEB_BOOTSTRAP_SERVER_URL` | (GitHub raw URL) | Remote bootstrap URL |
| `INCUS_WEB_IDENTITY_PROXY` | `$SCRIPT_DIR/scripts/identity-proxy.mjs` | Identity proxy script |
| `INCUS_WEB_IDENTITY_PROXY_URL` | (GitHub raw URL) | Remote identity proxy URL |
| `ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD` | `0` | Allow remote script download |

## Configuration Files

### .env

Local development configuration:
```bash
cp .env.example .env
chmod 600 .env
```

Used by:
- `deploy.sh` when run locally
- Control plane in development mode

### /etc/incus-web/provisioner.env

Provisioner service environment:
```bash
INCUS_WEB_PROVISIONER_TOKEN=<token>
INCUS_WEB_WORKSPACE_ID=workspace-incus-web
INCUS_WEB_INCUS_PROJECT=default
INCUS_WEB_INCUS_CONTAINER=incus-web
# ... other provisioner settings
```

Permissions: `0640`, root:incus-web

### /etc/incus-web/web.env

Control plane service environment:
```bash
INCUS_WEB_PROVISIONER_TOKEN=<token>
INCUS_WEB_PROVISIONER_SOCKET=/run/incus-web/provisioner.sock
INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated
INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1
```

Permissions: `0640`, root:incus-web

## Incus Profile

Profile configuration lives in `incus-web-profile.yaml`:

```yaml
name: incus-web-agent
description: "Incus system-container profile for the incus-web coding-agent demo"
config:
  boot.autostart: "false"
  security.privileged: "false"
  security.nesting: "true"
  raw.apparmor: |-
    signal peer=@{profile_name}//&unconfined,
  limits.cpu: "2"
  limits.memory: 4GiB
  limits.memory.enforce: "hard"
  limits.processes: "2048"
devices:
  eth0:
    type: nic
    name: eth0
    network: agentbr0
  workspace:
    type: disk
    source: /srv/incus-web/default-workspace
    path: /workspace
    shift: "true"
```

Profile can be overridden at container launch:
```bash
incus launch images:debian/trixie $CONTAINER_NAME \
  --profile incus-web-agent \
  --config limits.cpu=4 \
  --config limits.memory=8GiB
```

## Network Configuration

### Bridge

```bash
incus network create agentbr0 ipv4.address=198.18.0.1/15
```

### ACL

```bash
incus network acl create agent-block-lan
```

ACL rules (simplified):
```
# Egress rules
- Block 10.0.0.0/8
- Block 172.16.0.0/12
- Block 192.168.0.0/16
- Block 169.254.0.0/16
- Allow everything else
```

## Systemd Services

### incus-web-provisioner.service

```ini
[Unit]
Description=incus-web provisioner
After=network.target incus.service
Requires=incus.service

[Service]
Type=simple
User=incus-web-provisioner
Group=incus-web
EnvironmentFile=/etc/incus-web/provisioner.env
ExecStart=/usr/bin/node /usr/local/lib/incus-web/provisioner-server.mjs
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### incus-web-app.service

```ini
[Unit]
Description=incus-web control plane
After=network.target incus-web-provisioner.service
Requires=incus-web-provisioner.service

[Service]
Type=simple
User=incus-web-app
Group=incus-web
EnvironmentFile=/etc/incus-web/web.env
WorkingDirectory=/usr/local/lib/incus-web/app
ExecStart=/usr/bin/node_modules/.bin/next start
Environment="NODE_ENV=production"
Environment="PORT=3001"
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Development Configuration

### Local Development

Run control plane locally:
```bash
cd apps/web
npm install
npm run dev
```

Configuration:
```bash
# .env.local
INCUS_WEB_PROVISIONER_MODE=prototype-static
INCUS_WEB_DEV_ACTOR_USER_ID=dev-user
INCUS_WEB_DEV_ACTOR_EMAIL=dev@example.com
INCUS_WEB_DEV_ACTOR_DISPLAY_NAME="Dev User"
```

### Provisioner Modes

**Host-local (default):**
```bash
INCUS_WEB_PROVISIONER_MODE=host-local
INCUS_WEB_PROVISIONER_SOCKET=/run/incus-web/provisioner.sock
INCUS_WEB_PROVISIONER_TOKEN=<token>
```

**Prototype-static (development only):**
```bash
INCUS_WEB_PROVISIONER_MODE=prototype-static
```

Uses mock data without real provisioner.

## Related Documentation

- [Deployment](workflows/deployment.md) - Deployment configuration
- [Security](operations/security.md) - Security configuration
- [Testing](operations/testing.md) - Test configuration

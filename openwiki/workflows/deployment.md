# Deployment

## Overview

incus-web deployment is handled by `deploy.sh`, which provisions Incus containers, configures networking, installs services, and sets up the control plane. The script is designed to be curlable but does not bake secrets into the repository.

## Prerequisites

### Host Requirements
- Linux host with `bash`, `curl`, and `sudo`
- For `ACCESS_MODE=tailscale`:
  - Tailscale tailnet with HTTPS certs and Serve enabled
  - Tailscale auth key (ephemeral keys recommended for disposable containers)
- For `ACCESS_MODE=oidc`:
  - OIDC provider (e.g., Auth0, Azure AD, Google Workspace)
  - Callback URL: `$PUBLIC_URL/oauth2/callback`
  - TLS termination before container if using `OIDC_REVERSE_PROXY=true`

### What Gets Installed

If Incus is missing, `deploy.sh` installs it via `apt-get` and initializes with minimal defaults.

## Deployment Steps

### 1. Prepare Environment

Create a working directory and configure secrets:

```bash
git clone https://github.com/jmagar/incus-web.git ~/incus-web-run
cd ~/incus-web-run
cp .env.example .env
chmod 600 .env
editor .env
```

### 2. Configure Access Mode

**Tailscale mode (default):**
```bash
ACCESS_MODE=tailscale
TS_AUTHKEY=tskey-auth-<your-key>
TS_HOSTNAME=incus-web  # Optional, defaults to container name
```

**OIDC mode:**
```bash
ACCESS_MODE=oidc
PUBLIC_URL=https://incus-web.example.com
OIDC_ISSUER_URL=https://auth.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_COOKIE_SECRET=$(openssl rand -base64 32)
OIDC_EMAIL_DOMAINS=example.com,another.com  # Optional
```

### 3. Run Deploy Script

From repository:
```bash
./deploy.sh
```

To deploy a reviewed immutable revision:
```bash
git clone https://github.com/jmagar/incus-web.git
cd incus-web
git checkout <reviewed-40-character-commit-sha>
./deploy.sh
```

### 4. Access the Terminal

**Tailscale:**
- Container joins your tailnet at `$TS_HOSTNAME`
- Access via: `https://$TS_HOSTNAME.<tailnet-name>.ts.net`

**OIDC:**
- Access via: `https://$PUBLIC_URL`
- Authenticate through OIDC provider
- WeTTY terminal loads after successful auth

## Configuration

### Core Environment Variables

See `.env.example` for complete reference. Key variables:

**Container:**
- `CONTAINER_NAME=incus-web` - Container name
- `IMAGE=images:debian/trixie` - Base image (or use custom built image)
- `RECREATE=0` - Force container recreation if set to 1

**Networking:**
- `INCUS_NETWORK=agentbr0` - Managed bridge name
- `INCUS_NETWORK_IPV4=198.18.0.1/15` - Bridge subnet
- `INCUS_ACL=agent-block-lan` - Network ACL name
- `ENABLE_NETWORK_ACL=1` - Enable RFC1918 blocking

**Tailscale:**
- `TS_AUTHKEY` - Tailscale auth key
- `TS_HOSTNAME=$CONTAINER_NAME` - Tailnet hostname
- `TS_EXTRA_ARGS=--accept-routes=false` - Additional Tailscale args
- `TAILSCALE_SERVE_PORT=443` - HTTPS serve port

**OIDC:**
- `OIDC_ISSUER_URL` - OIDC provider URL
- `OIDC_CLIENT_ID` - OIDC client ID
- `OIDC_CLIENT_SECRET` - OIDC client secret
- `OIDC_COOKIE_SECRET` - Cookie encryption secret (generate with `openssl rand -base64 32`)
- `OIDC_EMAIL_DOMAINS=*` - Allowed email domains
- `OIDC_PROXY_PORT=4180` - oauth2-proxy listen port
- `OIDC_REVERSE_PROXY=true` - TLS terminates upstream

**Terminal:**
- `TERMINAL_BACKEND=wetty` - Use wetty (default) or `ghostty-web`
- `GHOSTTY_WEB_DEMO_VERSION` - ghostty-web version if using experimental backend

**Setup:**
- `SETUP_ENABLED=1` - Enable setup endpoint
- `SETUP_PORT=3080` - Setup server port
- `SETUP_ALLOWED_EMAILS` - Emails allowed to run setup
- `SETUP_COMMAND_TIMEOUT_MS=1200000` - Setup command timeout

### Provisioner Configuration

**Host provisioner:**
- `ENABLE_HOST_PROVISIONER=1` - Install provisioner service
- `INCUS_WEB_PROVISIONER_TOKEN` - Service token (generate if blank)
- `INCUS_WEB_PROVISIONER_SOCKET=/run/incus-web/provisioner.sock`
- `INCUS_WEB_PROVISIONER_SOCKET_MODE=0660`
- `INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS=180000` - Per-command timeout
- `INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS=200000` - Overall request timeout

**Provisioner workspace:**
- `INCUS_WEB_WORKSPACE_ID=workspace-incus-web`
- `INCUS_WEB_INCUS_PROJECT=default`
- `INCUS_WEB_INCUS_CONTAINER=$CONTAINER_NAME`

**Agent runs:**
- `INCUS_WEB_AGENT_RUN_STORE_PATH=/var/lib/incus-web/agent-runs.sqlite`
- `INCUS_WEB_AGENT_GOLDEN_CONTAINER=incus-web-agent-golden`
- `INCUS_WEB_AGENT_CREDENTIAL_SOURCE_CONTAINER=$CONTAINER_NAME`
- `INCUS_WEB_CODEX_APP_SERVER_URL` - Codex app-server endpoint
- `INCUS_WEB_CODEX_APP_SERVER_TOKEN` - Codex app-server token
- `INCUS_WEB_CODEX_MODEL` - Codex model
- `INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS=43200000` - 12 hours
- `INCUS_WEB_CLAUDE_COMMAND_TEMPLATE="claude -p {{task}}"`

### Control Plane Configuration

**Host web app:**
- `ENABLE_HOST_WEB_APP=1` - Auto-detects if `apps/web/package.json` exists
- `INCUS_WEB_APP_HOST=127.0.0.1`
- `INCUS_WEB_APP_PORT=3090`
- `INCUS_WEB_APP_NPM=/usr/bin/npm`

**Workspace ownership (prototype):**
- `INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated` - Current OIDC user owns workspace
- `INCUS_WEB_WORKSPACE_OWNER_MODE=none` - No ownership checks (development)
- `INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1` - Required for authenticated mode

**Development actor:**
- `INCUS_WEB_DEV_ACTOR_USER_ID=dev-user`
- `INCUS_WEB_DEV_ACTOR_EMAIL=dev@example.com`
- `INCUS_WEB_DEV_ACTOR_DISPLAY_NAME="Dev User"`

## Deployment Components

### 1. Incus Setup

If Incus is not installed:
```bash
sudo apt-get update
sudo apt-get install -y snapd
sudo snap install incus --channel=stable
sudo incus admin init --minimal
```

### 2. Network Bridge and ACL

Creates managed bridge and ACL:
```bash
incus network create agentbr0 ipv4.address=198.18.0.1/15
incus network acl create agent-block-lan
```

ACL rules block RFC1918 and IPv4 link-local egress:
- Rejects 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16

### 3. Profile Installation

Installs profile from `incus-web-profile.yaml`:
```bash
incus profile create incus-web-agent < incus-web-profile.yaml
```

Profile defines:
- Security: `privileged=false`, `nesting=true`
- AppArmor signal peer rules for nested systemd
- Resource limits: CPU, memory, processes
- Network device on agentbr0
- Workspace disk device (source overridden at launch)

### 4. Container Launch

Launches container from image:
```bash
incus launch images:debian/trixie $CONTAINER_NAME \
  --profile incus-web-agent \
  --config raw.apparmor="signal peer=@{profile_name}//&unconfined,"
```

Overrides workspace mount source:
- Default: `/srv/incus-web/default-workspace`
- Configurable via env: `HOST_WORKSPACE`

### 5. Container Provisioning

**System packages:**
```bash
incus exec $CONTAINER_NAME -- apt-get update
incus exec $CONTAINER_NAME -- apt-get install -y \
  zsh git nodejs python3 golang rustc cargo
```

**Node 22 installation:**
```bash
incus exec $CONTAINER_NAME -- bash -c "
  curl -fsSL https://nodejs.org/dist/v22.0.0/node-v22.0.0-linux-x64.tar.xz | tar -xJ
  mv node-v22.0.0-linux-x64 /usr/local/node
"
```

**Tool installation:**
```bash
incus exec $CONTAINER_NAME -- npm install -g @anthropic-ai/claude-code
incus exec $CONTAINER_NAME -- bash <(curl -sL https://raw.githubusercontent.com/jmagar/codex/main/install.sh)
```

**User creation:**
```bash
incus exec $CONTAINER_NAME -- useradd -m -s /bin/zsh agent
incus exec $CONTAINER_NAME -- usermod -aG sudo agent
```

**Terminal setup:**

WeTTY (default):
```bash
incus exec $CONTAINER_NAME -- npm install -g wetty
incus exec $CONTAINER_NAME -- systemctl enable wetty@agent
```

ghostty-web (experimental):
```bash
incus exec $CONTAINER_NAME -- bash -c "
  curl -fsSL https://github.com/coder/ghostty/releases/download/$GHOSTTY_WEB_DEMO_VERSION/ghostty-web-linux-x64.tar.gz | tar -xz
  mv ghostty-web /usr/local/bin/
  systemctl enable ghostty-web@agent
"
```

### 6. Access Layer Setup

**Tailscale mode:**
```bash
# deploy.sh installs the pinned, checksum-verified Tailscale archive and
# configures tailscale up/serve from ACCESS_MODE=tailscale settings.
./deploy.sh
```

**OIDC mode:**
```bash
incus exec $CONTAINER_NAME -- bash -c "
  wget https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v7.15.3/oauth2-proxy-v7.15.3.linux-amd64.tar.gz
  tar -xz oauth2-proxy-v7.15.3.linux-amd64.tar.gz
  mv oauth2-proxy-v7.15.3.linux-amd64 /usr/local/bin/oauth2-proxy

  cat > /etc/default/oauth2-proxy <<EOF
OIDC_ISSUER=$OIDC_ISSUER_URL
OIDC_CLIENT_ID=$OIDC_CLIENT_ID
OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET
COOKIE_SECRET=$OIDC_COOKIE_SECRET
EMAIL_DOMAINS=$OIDC_EMAIL_DOMAINS
OIDC_ALLOWED_EMAILS=$OIDC_ALLOWED_EMAILS
PROVIDER_DISPLAY_NAME=$OIDC_PROVIDER_DISPLAY_NAME
HTTP_ADDRESS=127.0.0.1:$OIDC_PROXY_PORT
COOKIE_SECURE=$OIDC_COOKIE_SECURE
OIDC_REVERSE_PROXY=$OIDC_REVERSE_PROXY
SKIP_PROVIDER_BUTTON=$OIDC_SKIP_PROVIDER_BUTTON
COOKIE_REFRESH=$OIDC_COOKIE_REFRESH
COOKIE_EXPIRE=$OIDC_COOKIE_EXPIRE
EOF

  incus exec $CONTAINER_NAME -- systemctl enable oauth2-proxy
"
```

### 7. Host Provisioner Service

**Service user:**
```bash
sudo useradd --system --home-dir /var/lib/incus-web-provisioner incus-web-provisioner
sudo usermod -aG incus-admin incus-web-provisioner
```

**Environment file:**
```bash
sudo mkdir -p /etc/incus-web
sudo install -o root -g incus-web -m 640 /dev/null /etc/incus-web/provisioner.env

cat > /etc/incus-web/provisioner.env <<EOF
INCUS_WEB_PROVISIONER_TOKEN=$INCUS_WEB_PROVISIONER_TOKEN
INCUS_WEB_WORKSPACE_ID=$INCUS_WEB_WORKSPACE_ID
INCUS_WEB_INCUS_PROJECT=$INCUS_WEB_INCUS_PROJECT
INCUS_WEB_INCUS_CONTAINER=$INCUS_WEB_INCUS_CONTAINER
INCUS_WEB_PROVISIONER_SOCKET=$INCUS_WEB_PROVISIONER_SOCKET
INCUS_WEB_PROVISIONER_SOCKET_MODE=$INCUS_WEB_PROVISIONER_SOCKET_MODE
INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS=$INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS
INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS=$INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS
EOF
```

**Provisioner script:**
```bash
sudo install -o root -g root -m 755 scripts/provisioner-server.mjs /usr/local/lib/incus-web/provisioner-server.mjs
sudo install -o root -g root -m 755 scripts/agent-runs.mjs /usr/local/lib/incus-web/agent-runs.mjs
```

**Systemd service:**
```bash
cat > /etc/systemd/system/incus-web-provisioner.service <<EOF
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
EOF

sudo systemctl enable incus-web-provisioner
sudo systemctl start incus-web-provisioner
```

### 8. Control Plane Service

**Service user:**
```bash
sudo useradd --system --home-dir /var/lib/incus-web-app incus-web-app
sudo usermod -aG incus-web incus-web-app
```

**Build web app:**
```bash
cd apps/web
npm install
npm run build
```

**Environment file:**
```bash
sudo install -o root -g incus-web -m 640 /dev/null /etc/incus-web/web.env

cat > /etc/incus-web/web.env <<EOF
INCUS_WEB_PROVISIONER_TOKEN=$INCUS_WEB_PROVISIONER_TOKEN
INCUS_WEB_PROVISIONER_SOCKET=$INCUS_WEB_PROVISIONER_SOCKET
INCUS_WEB_WORKSPACE_OWNER_MODE=$INCUS_WEB_WORKSPACE_OWNER_MODE
INCUS_WEB_ALLOW_SHARED_PROTOTYPE=$INCUS_WEB_ALLOW_SHARED_PROTOTYPE
EOF
```

**Systemd service:**
```bash
cat > /etc/systemd/system/incus-web-app.service <<EOF
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
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3090
Environment="NODE_ENV=production"
Environment="PORT=$INCUS_WEB_APP_PORT"
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable incus-web-app
sudo systemctl start incus-web-app
```

## CI Image Build

GitHub Actions builds Incus images on PRs and pushes to `main`.

### Workflow

**Triggers**: Changes to:
- `deploy.sh`
- `incus-web-profile.yaml`
- `distrobuilder.yaml`
- Image scripts
- Static tests
- Workflow itself

**Process**:
1. Runs on `ubuntu-latest` (GitHub-hosted)
2. Validates shell code with ShellCheck
3. Builds Debian Trixie image from `distrobuilder.yaml`
4. Exports tarball to `dist/`
5. Imports and launches smoke-test container
6. Runs `tests/deploy_static_tests.sh` inside container

**Artifacts**:
- PR: Build and test only, no artifacts
- Push to `main`:
  - Uploads to `incus-web-agent-image` artifact (14-day retention)
  - Publishes to `incus-web-agent-latest` GitHub Release

### Local Image Build

```bash
./scripts/build-image.sh
```

**Overrides**:
```bash
DISTROBUILDER_YAML=$PWD/distrobuilder.yaml
IMAGE_ALIAS=incus-web-agent
EXPORT_DIR=$PWD/dist
BUILD_TYPE=unified
```

**Use custom image**:
```bash
incus image import dist/incus-web-agent.tar.xz --alias incus-web-agent
IMAGE=incus-web-agent ./deploy.sh
```

### Image Recipe

`distrobuilder.yaml` defines:
1. Debian Trixie base packages
2. System toolchains from Debian packages
3. Node 22 from upstream tarball
4. Claude Code, WeTTY, Tailscale, GitHub CLI, Codex CLI in `post-packages` hook

## Verification

### Check Container Status
```bash
incus list
incus info $CONTAINER_NAME
incus exec $CONTAINER_NAME -- systemctl status
```

### Check Provisioner
```bash
sudo systemctl status incus-web-provisioner
sudo journalctl -u incus-web-provisioner -f
curl --unix-socket /run/incus-web/provisioner.sock http://localhost/healthz
```

### Check Control Plane
```bash
sudo systemctl status incus-web-app
sudo journalctl -u incus-web-app -f
curl http://127.0.0.1:3090/readyz
```

### Test Access
```bash
# Tailscale
curl https://$TS_HOSTNAME.<tailnet-name>.ts.net

# OIDC
curl https://$PUBLIC_URL
```

## Troubleshooting

### Container Won't Start
```bash
incus log $CONTAINER_NAME
incus info $CONTAINER_NAME
# Check profile, network, and storage
```

### Provisioner Errors
```bash
sudo journalctl -u incus-web-provisioner -n 50
# Check INCUS_WEB_PROVISIONER_TOKEN
# Check socket permissions: ls -la /run/incus-web/
# Verify Incus access: sudo -u incus-web-provisioner incus list
```

### Control Plane Errors
```bash
sudo journalctl -u incus-web-app -n 50
# Check provisioner token in web.env
# Verify provisioner socket connectivity
# Check Next.js build: cd apps/web && npm run build
```

### OIDC Issues
```bash
incus exec $CONTAINER_NAME -- journalctl -u oauth2-proxy -f
# Verify callback URL matches OIDC provider
# Check cookie secret is set
# Verify email domains match
```

### Tailscale Issues
```bash
incus exec $CONTAINER_NAME -- tailscale status
incus exec $CONTAINER_NAME -- journalctl -u tailscale -f
# Check authkey is valid
# Verify hostname doesn't conflict
```

## Related Documentation

- [Configuration](../operations/configuration.md) - Complete environment variable reference
- [Security](../operations/security.md) - Security model and hardening
- [Architecture](../architecture.md) - System architecture overview
- [Testing](../operations/testing.md) - Static tests and smoke tests

# incus-web

`incus-web` creates an Incus container, installs a browser terminal inside it, and exposes that terminal through either Tailscale Serve or an in-container OIDC reverse proxy.

The deploy script is meant to be curlable, but it does not bake secrets into the repository. Put your access-mode secrets in a local `.env` file, keep that file out of git, then run the script from the same directory.

## What It Creates

- An Incus container from `images:debian/trixie` by default.
- A non-root terminal user named `agent` by default.
- A small demo developer toolchain: zsh, Node/npm, Python, Go, Rust/Cargo, Git, GitHub CLI, Claude Code, and Codex CLI.
- A browser terminal listening inside the container on `127.0.0.1:3000`, using WeTTY by default or the experimental `ghostty-web` backend when enabled.
- One of two access layers:
  - Tailscale running inside the nested, unprivileged system container with a `tailscale serve` HTTPS route.
  - `oauth2-proxy` running inside the container as an OIDC-authenticated reverse proxy in front of WeTTY.
- A dedicated Incus bridge with an ACL that blocks direct egress to RFC1918 and IPv4 link-local LAN ranges.
- A committed Incus profile YAML (`incus-web-profile.yaml`) as the source of truth for the container shape, including `security.privileged=false` and `security.nesting=true`.
- A host directory mounted into the container for persistent working files.
- A host-local `incus-web-provisioner.service` systemd unit that exposes the provisioner contract over a root-owned Unix socket for the Next.js control plane.

## Requirements

- Linux host with `bash`, `curl`, and `sudo`.
- For `ACCESS_MODE=tailscale`: a Tailscale tailnet where HTTPS certs and Serve are enabled, plus a Tailscale auth key. Ephemeral auth keys are recommended for disposable containers.
- For `ACCESS_MODE=oidc`: an OIDC provider app with callback URL `$PUBLIC_URL/oauth2/callback`. If TLS terminates before the container, keep `OIDC_REVERSE_PROXY=true`.

If Incus is missing, `deploy.sh` attempts to install it with `apt-get` and initialize it with minimal defaults.

The Incus container shape lives in `incus-web-profile.yaml`: profile config, the NIC, and the workspace disk device. Provisioning is intentionally handled by `deploy.sh` after the container launches. The demo does not use cloud-init, so packages, users, services, and agent setup stay in one procedural code path instead of drifting between image metadata and this repository.

## CI Image Build

GitHub Actions builds an Incus image on pull requests and pushes to `main` when the deploy script, runtime profile, `distrobuilder.yaml`, image scripts, static tests, or workflow change. The workflow runs on GitHub-hosted `ubuntu-latest`, validates the shell code, builds the Debian Trixie image from `distrobuilder.yaml`, imports the exported tarball, and launches a smoke-test container from that exported artifact.

Pushes to `main` upload the exported Incus image as the short-lived `incus-web-agent-image` workflow artifact with a 14-day retention period, then publish the same exported image to the rolling GitHub Release `incus-web-agent-latest`. Pull requests build and smoke-test the image but do not upload artifacts or update the release.

The image recipe installs the system toolchains from Debian packages, installs Node/npm from the upstream Node 22 tarball, then installs Claude Code, WeTTY, Tailscale, GitHub CLI, and Codex CLI during the distrobuilder `post-packages` hook.

To build the image locally:

```bash
./scripts/build-image.sh
```

Useful overrides:

```bash
DISTROBUILDER_YAML=$PWD/distrobuilder.yaml
IMAGE_ALIAS=incus-web-agent
EXPORT_DIR=$PWD/dist
BUILD_TYPE=unified
```

The exported artifact can be imported on another Incus host and used as the deploy base image:

```bash
incus image import dist/incus-web-agent.tar.xz --alias incus-web-agent
IMAGE=incus-web-agent ./deploy.sh
```

For the durable rolling build, download `incus-web-agent.tar.xz` from the `incus-web-agent-latest` GitHub Release instead of relying on the expiring Actions artifact.

## Control Plane Web App

The first multi-tenant control-plane slice lives in `apps/web`. It is a Next.js App Router app using Aurora components installed from the Aurora shadcn registry.

Run it locally:

```bash
npm --prefix apps/web run dev
```

Verify it:

```bash
npm --prefix apps/web run lint
npm --prefix apps/web run test
npm --prefix apps/web run build
```

This first slice is read-only. It reads authenticated identity from reverse-proxy/OIDC headers when present, falls back to a local development actor, and renders the current `incus-web` workspace inventory without mutating Incus state.

**Identity trust is proxy-header based — `INCUS_WEB_TRUSTED_PROXY_SECRET` is mandatory before exposing this app beyond a fully-trusted network.** `apps/web/lib/auth/identity.ts` reads `x-auth-request-email` and related headers with no independent verification of their own; without a shared secret gating them (checked against an `x-incus-web-proxy-secret` header your reverse proxy must inject), a direct caller that reaches the app without going through that proxy could set those headers itself and impersonate any user. Set `INCUS_WEB_TRUSTED_PROXY_SECRET` in production — the app refuses to start serving authenticated requests without it (unless you explicitly opt out with `INCUS_WEB_ALLOW_DEV_AUTH=1` for an intentionally closed-network deployment).

`GET /healthz` is deliberately excluded from that identity check — it's a deploy-time readiness probe (see `wait_for_host_web_app` in `scripts/incus-web-lib.sh`) that must succeed before the reverse proxy is even routing to this app. It returns a bare `204` with no body, so it carries no information-disclosure risk; unauthenticated request-volume limits for it are expected to live at the reverse-proxy/edge layer (e.g. SWAG), not in application code.

`deploy.sh` installs the host provisioner service by default. It creates a dedicated `incus-web-provisioner` system user, grants that user Incus access through `incus-admin`, writes a group-readable environment file at `/etc/incus-web/provisioner.env`, generates or reuses `/etc/incus-web/provisioner.token` when `INCUS_WEB_PROVISIONER_TOKEN` is blank, and listens on `/run/incus-web/provisioner.sock` with mode `0660`.

`deploy.sh` also installs the host Next.js control-plane service when it is run from a checkout containing `apps/web/package.json`, or when `ENABLE_HOST_WEB_APP=1` is set explicitly. `incus-web-app.service` builds `apps/web`, runs `next start` on `INCUS_WEB_APP_HOST:INCUS_WEB_APP_PORT`, reads the provisioner env file, and runs as the dedicated `incus-web-app` service user with only the `incus-web` supplementary group needed to call the host-local provisioner. The deployed prototype can set `INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated` so the currently authenticated reverse-proxy user sees the live `incus-web` workspace until database-backed owner and sharing records are introduced.

## Quick Start

Create a working directory and a `.env` file:

```bash
mkdir -p ~/incus-web-run
cd ~/incus-web-run
curl -fsSLO https://raw.githubusercontent.com/jmagar/incus-web/main/.env.example
cp .env.example .env
chmod 600 .env
editor .env
```

Run the deploy script:

```bash
curl -fsSL https://raw.githubusercontent.com/jmagar/incus-web/main/deploy.sh | bash
```

The script loads `.env` from the current directory.

When running from a full local checkout, `deploy.sh` installs the host provisioner from `./scripts/provisioner-server.mjs`. When curl-piping `deploy.sh`, set `ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=1` only if you intentionally want deploy to fetch that host service entrypoint from `INCUS_WEB_PROVISIONER_SERVER_URL`; otherwise set `ENABLE_HOST_PROVISIONER=0`.

Rerunning `deploy.sh` is safe after a partial or successful run. By default it reuses the existing container and reruns provisioning, Tailscale Serve setup, and validation. Set `RECREATE=1` in `.env`, or run with `FORCE_RECREATE=1`, to delete and rebuild the container.

## Configuration

`.env` uses shell-compatible `KEY=value` lines.

```bash
TS_AUTHKEY=tskey-auth-example
ACCESS_MODE=tailscale
CONTAINER_NAME=incus-web
IMAGE=images:debian/trixie
RECREATE=0
INCUS_NETWORK=agentbr0
INCUS_NETWORK_IPV4=198.18.0.1/15
INCUS_ACL=agent-block-lan
ENABLE_NETWORK_ACL=1
INCUS_PROFILE_NAME=incus-web-agent
INCUS_PROFILE_YAML=
CONTAINER_IPV4=
INCUS_WEB_WORKSPACE_ID=workspace-incus-web
INCUS_WEB_INCUS_PROJECT=default
INCUS_WEB_INCUS_CONTAINER=
ENABLE_HOST_PROVISIONER=1
INCUS_WEB_PROVISIONER_TOKEN=
INCUS_WEB_PROVISIONER_SOCKET=/run/incus-web/provisioner.sock
INCUS_WEB_PROVISIONER_SOCKET_MODE=0660
INCUS_WEB_PROVISIONER_USER=incus-web-provisioner
INCUS_WEB_PROVISIONER_GROUP=incus-web
INCUS_WEB_PROVISIONER_INCUS_GROUP=incus-admin
INCUS_WEB_PROVISIONER_NODE=/usr/bin/node
ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD=0
TS_HOSTNAME=incus-web
TS_EXTRA_ARGS=--accept-routes=false
TAILSCALE_SERVE_PORT=443
PUBLIC_URL=https://incus-web.example.com
OIDC_ISSUER_URL=https://issuer.example.com
OIDC_CLIENT_ID=incus-web
OIDC_CLIENT_SECRET=change-me
OIDC_COOKIE_SECRET=
OIDC_EMAIL_DOMAINS=*
OIDC_ALLOWED_EMAILS=
OIDC_PROVIDER_DISPLAY_NAME=OIDC
OIDC_PROXY_PORT=4180
OIDC_HOST_BIND=127.0.0.1
OIDC_HOST_PORT=
OIDC_COOKIE_SECURE=true
OIDC_REVERSE_PROXY=true
OIDC_SKIP_PROVIDER_BUTTON=true
OIDC_COOKIE_REFRESH=1h
OIDC_COOKIE_EXPIRE=8h
OAUTH2_PROXY_VERSION=v7.15.3
TERMINAL_BACKEND=wetty
GHOSTTY_WEB_DEMO_VERSION=0.4.0-next.20.g1858a59
SETUP_ENABLED=1
SETUP_PORT=3080
SETUP_ALLOWED_EMAILS=
SETUP_ALLOW_KEY_PERSISTENCE=0
SETUP_COMMAND_TIMEOUT_MS=1200000
IDENTITY_PROXY_PORT=3090
WETTY_PORT=3000
WEB_USER=agent
INCUS_WEB_WORKSPACE_LABEL=
DOTFILES_REPO=
DOTFILES_SOURCE_DIR=
DOTFILES_AGE_KEY_FILE=
DOTFILES_RUN_MISE=0
DOTFILES_SKIP_APT=1
HOST_WORKSPACE=$HOME/incus-web-data/incus-web
CONTAINER_WORKSPACE=/workspace
DISK_SHIFT=true
```

Important variables:

- `ACCESS_MODE`: `tailscale` or `oidc`. Defaults to `tailscale`.
- `TS_AUTHKEY`: required Tailscale auth key for `tailscale up` when `ACCESS_MODE=tailscale`.
- `CONTAINER_NAME`: local Incus container name.
- `RECREATE`: set to `1` to delete and recreate an existing container with the same name.
- `FORCE_RECREATE`: command-scoped override for `RECREATE`; useful for one-off rebuilds without editing `.env`.
- `IMAGE`: Incus image to launch. Defaults to a non-cloud Debian image because provisioning is handled by `deploy.sh`.
- `INCUS_NETWORK`: managed Incus bridge used by the container.
- `INCUS_NETWORK_IPV4`: IPv4 CIDR used when creating the bridge. The default uses the lab/benchmarking range from the Incus jail article to avoid common home LAN collisions.
- `INCUS_ACL`: Incus network ACL name for the LAN egress deny list.
- `ENABLE_NETWORK_ACL`: set to `0` to skip bridge/ACL management when using a pre-existing custom network.
- `INCUS_PROFILE_NAME`: Incus profile name created/updated from `incus-web-profile.yaml`.
- `INCUS_PROFILE_YAML`: optional path to a local profile YAML. When unset, `deploy.sh` uses the repo file next to the script or downloads it for curl-piped runs.
- `CONTAINER_IPV4`: optional static IPv4 to assign if DHCP does not come up.
- `INCUS_WEB_WORKSPACE_ID`, `INCUS_WEB_INCUS_PROJECT`, and `INCUS_WEB_INCUS_CONTAINER`: workspace tuple shared by the web app and host provisioner. The imported prototype defaults are `workspace-incus-web`, the active Incus project, and `CONTAINER_NAME`; set `INCUS_WEB_INCUS_PROJECT` or `INCUS_WEB_INCUS_CONTAINER` explicitly only when the web app should target a different project/container.
- `ENABLE_HOST_PROVISIONER`: set to `0` to disable the host-local provisioner systemd unit.
- `INCUS_WEB_PROVISIONER_TOKEN`: service token shared between the Next.js app and host provisioner. Leave blank during deploy to generate and persist a token readable only by root and `INCUS_WEB_PROVISIONER_GROUP`.
- `INCUS_WEB_PROVISIONER_SOCKET`: Unix socket path used by the host-local transport.
- `INCUS_WEB_PROVISIONER_SOCKET_MODE`: socket mode used by the host provisioner server. Defaults to `0660`.
- `INCUS_WEB_PROVISIONER_USER`, `INCUS_WEB_PROVISIONER_GROUP`, and `INCUS_WEB_PROVISIONER_INCUS_GROUP`: host service identity. Add the trusted web-app service user to `INCUS_WEB_PROVISIONER_GROUP`, not to `incus-admin`.
- `INCUS_WEB_PROVISIONER_NODE`: absolute Node.js executable used by the systemd unit.
- `ENABLE_CODEX_APP_SERVER`: set to `0` to skip the host Codex app-server controller. Defaults to the host provisioner setting.
- `INCUS_WEB_CODEX_APP_SERVER_USER`: host user that owns the Codex login and runs `incus-web-codex-app-server.service`. Defaults to the sudo caller or current user.
- `INCUS_WEB_CODEX_APP_SERVER_HOST`, `INCUS_WEB_CODEX_APP_SERVER_PORT`, and `INCUS_WEB_CODEX_APP_SERVER_URL`: loopback WebSocket endpoint written into the provisioner env for Codex agent runs. Defaults to `ws://127.0.0.1:4500`.
- `INCUS_WEB_CODEX_APP_SERVER_COMMAND`: optional absolute Codex binary override. When unset, deploy prefers the selected user's standalone Codex install, then `command -v codex` for that user.
- `INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS` and `INCUS_WEB_CODEX_MODEL`: optional Codex app-server request timeout and model override passed to the provisioner.
- `ENABLE_HOST_PROVISIONER_REMOTE_DOWNLOAD`: set to `1` only when curl-piping deploy and intentionally fetching `scripts/provisioner-server.mjs` from `INCUS_WEB_PROVISIONER_SERVER_URL`.
- `ENABLE_HOST_WEB_APP`: set to `0` to skip the host Next.js control-plane systemd unit, or `1` to require it. When unset, checkout deploys enable it and curl-piped deploys leave it off.
- `INCUS_WEB_APP_DIR`: checkout path containing `apps/web/package.json`. Defaults to the repo checkout used by `deploy.sh`.
- `INCUS_WEB_APP_ENV_FILE`: host web-app environment file written by deploy. Defaults to `/etc/incus-web/web.env`.
- `INCUS_WEB_APP_USER`: host user that runs `incus-web-app.service`. Defaults to the dedicated `incus-web-app` service account.
- `INCUS_WEB_APP_HOST` and `INCUS_WEB_APP_PORT`: host bind address and port for `next start`. Keep this loopback-only unless a firewall or reverse-proxy boundary allows only the trusted SWAG host to reach it; the app trusts identity headers set by that proxy.
- `INCUS_WEB_WORKSPACE_OWNER_MODE`: defaults to `none`. `authenticated` assigns the imported prototype workspace to the current authenticated actor and requires `INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1`; use it only as an explicit single-user/prototype opt-in.
- `INCUS_WEB_ALLOW_SHARED_PROTOTYPE`: defaults to `0`. Set to `1` only when intentionally exposing the imported `incus-web` prototype workspace before database-backed per-user workspace records exist.
- `INCUS_WEB_TERMINAL_URL`: optional dashboard terminal link. For the SWAG-backed host web app, set this to `/terminal/` when SWAG routes `/terminal/` and `/ws` to the Ghostty upstream.
- `INCUS_WEB_TRUSTED_PROXY_SECRET`: optional shared secret header guard. When set, requests must include `X-Incus-Web-Proxy-Secret` with this value, which lets a trusted reverse proxy strip client-supplied identity headers and add a private marker before forwarding.
- `TS_HOSTNAME`: tailnet hostname assigned to the container.
- `TS_EXTRA_ARGS`: extra flags passed to `tailscale up`; defaults to `--accept-routes=false`.
- `TAILSCALE_SERVE_PORT`: HTTPS port exposed by `tailscale serve`.
- `PUBLIC_URL`: external URL for the OIDC-protected terminal when `ACCESS_MODE=oidc`.
- `OIDC_ISSUER_URL`: OIDC issuer URL.
- `OIDC_CLIENT_ID`: OIDC client ID.
- `OIDC_CLIENT_SECRET`: OIDC client secret.
- `OIDC_COOKIE_SECRET`: oauth2-proxy cookie secret. Leave blank to generate a per-container secret during deploy.
- `OIDC_EMAIL_DOMAINS`: allowed email domain for oauth2-proxy. `*` allows any authenticated email from the provider.
- `OIDC_ALLOWED_EMAILS`: optional comma- or space-separated email allow list. When set, deploy writes `/etc/incus-web/authenticated-emails`.
- `OIDC_PROVIDER_DISPLAY_NAME`: label shown on the oauth2-proxy login button.
- `OIDC_PROXY_PORT`: oauth2-proxy listen port inside the container.
- `OIDC_HOST_BIND` and `OIDC_HOST_PORT`: optional Incus proxy device bind address and port. Leave `OIDC_HOST_PORT` blank to expose oauth2-proxy only on the container network.
- `OIDC_COOKIE_SECURE`: set to `true` when using HTTPS, including TLS termination in front of the container.
- `OIDC_REVERSE_PROXY`: set to `true` when another proxy terminates TLS before oauth2-proxy.
- `OIDC_SKIP_PROVIDER_BUTTON`: skip the oauth2-proxy provider selection page.
- `OIDC_COOKIE_REFRESH` and `OIDC_COOKIE_EXPIRE`: oauth2-proxy cookie lifetime controls.
- `OAUTH2_PROXY_VERSION`: oauth2-proxy release to install.
- `TERMINAL_BACKEND`: `wetty` or `ghostty-web`. Ghostty-web is experimental and still runs behind the same access layer.
- `GHOSTTY_WEB_DEMO_VERSION`: `@ghostty-web/demo` package version used by the experimental backend. The default pins the `next` build that includes same-origin WebSocket token checks.
- `SETUP_ENABLED`: set to `1` to expose the authenticated `/setup/` page for per-user dotfiles repo entry and age key upload. This applies inside that user's workspace container; it is not baked into the shared image.
- `SETUP_PORT`: local setup service port inside the container.
- `SETUP_ALLOWED_EMAILS`: comma- or space-separated owner email allow list for `/setup/`; defaults to `OIDC_ALLOWED_EMAILS`. Setup returns `403` when no authenticated email is allowed.
- `SETUP_ALLOW_KEY_PERSISTENCE`: set to `1` only when the workspace owner explicitly wants uploaded age keys stored encrypted for future applies. Default `0` removes uploaded keys after each apply.
- `SETUP_COMMAND_TIMEOUT_MS`: timeout for each setup subprocess.
- `IDENTITY_PROXY_PORT`: local identity-aware proxy port between oauth2-proxy and the terminal backend.
- `WETTY_PORT`: local WeTTY HTTP port inside the container.
- `WEB_USER`: non-root terminal user created inside the container.
- `INCUS_WEB_WORKSPACE_LABEL`: optional label shown in the terminal workspace banner, such as a user email or display name.
- `DOTFILES_REPO`: optional per-container chezmoi source, passed to `chezmoi init --apply` as the terminal user.
- `DOTFILES_SOURCE_DIR`: optional host path to an existing chezmoi source directory for this container. When set, deploy copies it into the container and applies it without requiring GitHub credentials in the container.
- `DOTFILES_AGE_KEY_FILE`: optional host path copied to `~/.config/chezmoi/key.txt` for encrypted chezmoi secrets.
- `DOTFILES_RUN_MISE`: set to `1` to install mise for the terminal user and run `mise install` after dotfiles apply.
- `DOTFILES_SKIP_APT`: set to `1` to skip apt/system-package scripts from imported dotfiles. User-level dotfiles and mise still apply; root-level package scripts require an explicit opt-in.
- `HOST_WORKSPACE`: host path mounted into the container.
- `CONTAINER_WORKSPACE`: mount point inside the container.
- `DISK_SHIFT`: use Incus idmapped shifting for the mounted workspace.

## Example

```bash
mkdir -p ~/incus-web-demo
cd ~/incus-web-demo
cat >.env <<'EOF'
TS_AUTHKEY=tskey-auth-your-key
CONTAINER_NAME=incus-web-demo
TS_HOSTNAME=incus-web-demo
HOST_WORKSPACE=$HOME/incus-web-data/demo
CONTAINER_WORKSPACE=/workspace
RECREATE=1
EOF
chmod 600 .env
curl -fsSL https://raw.githubusercontent.com/jmagar/incus-web/main/deploy.sh | bash
```

When it finishes, open the Tailscale HTTPS URL for `TS_HOSTNAME`. The script also prints `tailscale serve status` from inside the container.

For OIDC mode:

```bash
cat >.env <<'EOF'
ACCESS_MODE=oidc
CONTAINER_NAME=incus-web-oidc
PUBLIC_URL=https://incus-web.example.com
OIDC_ISSUER_URL=https://issuer.example.com
OIDC_CLIENT_ID=incus-web
OIDC_CLIENT_SECRET=change-me
OIDC_EMAIL_DOMAINS=example.com
OIDC_HOST_BIND=127.0.0.1
OIDC_HOST_PORT=4180
RECREATE=1
EOF
chmod 600 .env
curl -fsSL https://raw.githubusercontent.com/jmagar/incus-web/main/deploy.sh | bash
```

Configure the OIDC app callback as `https://incus-web.example.com/oauth2/callback`. The example above binds oauth2-proxy to `127.0.0.1:4180` on the host with an Incus proxy device, so a host-level TLS proxy can publish `PUBLIC_URL` while OIDC enforcement stays inside the container.

## Notes

- `.env` and `.env.*` are gitignored. Commit `.env.example`, never real auth keys.
- The Tailscale auth key is copied into the container only long enough to run `tailscale up`, then removed.
- In OIDC mode, `oauth2-proxy` is the only service intended to be exposed; WeTTY stays bound to `127.0.0.1` inside the container.
- Do not build an Incus image with `/var/lib/tailscale` already populated. Cloned containers should join Tailscale with their own node identity.
- The default profile is nested but unprivileged. Keep privileged containers out of the hosted multi-tenant path; use a dedicated trusted pool or an Incus VM for workloads that truly require privileged semantics.

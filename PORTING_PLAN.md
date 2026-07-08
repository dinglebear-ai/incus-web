# incus-unraid → incus-web Porting Plan

## 1. Summary

`incus-unraid` (`/home/jmagar/workspace/incus-unraid`) and `incus-web` (this repo) solve
overlapping problems — LAN-banned Incus dev/agent containers — from opposite architectural
directions. `incus-unraid` is an Unraid plugin: a classic `.plg`/shell OS layer
(`incus.plg`, `source/usr/local/emhttp/plugins/incus/scripts/*.sh`) that installs and
lifecycle-manages a private-prefixed Incus runtime, plus a NestJS/GraphQL API plugin
(`unraid-api-plugin-incus/`) with a single-file Vue 3 settings UI. `incus-web` is a
Next.js control-plane app (`apps/web/`) backed by a host-local provisioner service, driven
by a `deploy.sh` + `incus-web-lib.sh` shell pipeline and a single baked `distrobuilder.yaml`
image, with Tailscale (or OIDC) as a first-class, mandatory access layer.

Net finding: incus-web's core plumbing (Tailscale access, provisioner contract, container
lifecycle, CI image builds) is more mature and more rigorously typed/validated than
incus-unraid's equivalent pieces. What incus-web is missing is almost entirely
**interactive, in-browser configurability** that incus-unraid's Vue UI provides: a live
multi-distro image builder with package search, devcontainer.json/mise.toml/.tool-versions
import, a resource-limit/workspace-override editor per container, and a fleet dashboard with
live CPU/memory telemetry and sparklines. The biggest opportunities are (a) porting the
devcontainer.json and `.tool-versions`/mise.toml import logic — pure client-side TypeScript,
directly portable with minimal translation — and (b) building an interactive per-container
config/detail panel and image builder UI, both of which currently don't exist in incus-web's
read-only dashboard. Tailscale itself needs no porting; incus-web's implementation is already
stronger (mandatory `tailscale serve --https`, not just best-effort `tailscale up`).

---

## 2. Feature-by-feature

### 2.1 Tailscale autojoin

**incus-unraid:**
- Config: `tsAuthKey` field, optional, empty = disabled
  (`unraid-api-plugin-incus/src/config.entity.ts:130-133`, default `""` at line 160).
- Applied only at container **launch** time, best-effort, fire-and-forget:
  `unraid-api-plugin-incus/src/incus.resolver.ts:99-107` — after `launchJail`, if
  `tsAuthKey` is set, runs `tailscale up --authkey=... --hostname=<name>` via
  `IncusExecService.runOnce` (non-interactive exec, no websocket,
  `unraid-api-plugin-incus/src/incus-exec.service.ts:99-155`). Failure is caught and only
  logged as a warning (`this.logger.warn`) — the jail still launches successfully. No
  `tailscale serve`/HTTPS exposure step at all; Tailscale here is purely "make the
  container reachable on the tailnet," not "publish a service."
- UI: `unraid-api-plugin-incus/web/src/App.vue:2741-2768` — a single password-style input
  for the auth key in the Config tab, with help text confirming the best-effort/silent-skip
  semantics.
- Network design note: the LAN-ban ACL's blocked CIDR list deliberately **excludes**
  Tailscale's CGNAT range `100.64.0.0/10` so a joined container can still reach other
  tailnet nodes (`source/usr/local/emhttp/plugins/incus/incus.cfg:27`,
  `unraid-api-plugin-incus/web/src/App.vue:2677`).

**incus-web — exists, and is more mature:**
- `TS_AUTHKEY` is a **required** var when `ACCESS_MODE=tailscale` (the default access mode):
  `deploy.sh:140-141` (`require_var TS_AUTHKEY`).
- Full join + publish flow in `scripts/incus-web-lib.sh:1655-1670`
  (`join_tailnet_and_serve`): installs tailscale if needed
  (`ensure_tailscale_installed`), pushes the auth key into the container via a
  root-only env file (`push_tailscale_env`), then inside the container runs
  `tailscale up --authkey=... --hostname="$TS_HOSTNAME" $TS_EXTRA_ARGS` **and**
  `tailscale serve --bg --https="$TAILSCALE_SERVE_PORT" "http://127.0.0.1:$WETTY_PORT"`,
  then deletes the pushed env file (`rm -f /etc/incus-web/tailscale.env`) so the key
  doesn't linger on disk. This is a real HTTPS-published terminal via Tailscale Serve, not
  just tailnet membership.
- `README.md:117,141-143,219-221,300` documents `TS_AUTHKEY`, `TS_HOSTNAME`,
  `TS_EXTRA_ARGS`, `TAILSCALE_SERVE_PORT`, and explicitly notes the key is only resident in
  the container long enough to run `tailscale up` before being removed.
- Same CGNAT allowance intent is implicit in incus-web's network ACL story (agent bridge +
  ACL block RFC1918/link-local, `README.md:16,190-193`) — worth double-checking the actual
  ACL CIDR list in `incus-web-lib.sh`/`incus-web-profile.yaml` explicitly excludes
  `100.64.0.0/10` the way incus-unraid's does, since this file wasn't found to state it as
  explicitly as incus-unraid's config comment does.

**Porting approach:** None needed for the join/serve mechanism — incus-web's is already
better (secret cleanup, real publish step, required rather than optional). Two small,
optional items worth lifting from incus-unraid:
1. Verify (and if missing, add) an explicit code comment / doc note in
   `incus-web-lib.sh` or `incus-web-profile.yaml` that the ACL's blocked-CIDR list
   intentionally excludes `100.64.0.0/10`, mirroring incus-unraid's self-documenting
   config comment — cheap, prevents a future "helpful" tightening of the ACL from breaking
   Tailscale reachability.
2. incus-unraid's best-effort semantics (skip silently if the image lacks `tailscale`,
   never fail the whole launch) is a reasonable pattern if incus-web ever supports
   `ACCESS_MODE=none`/multi-mode per-workspace Tailscale joins in the DB-backed multi-tenant
   phase — worth keeping in mind for that design, not an immediate change.

**Effort:** N/A (no gap) / **S** for the doc note. **Risk:** none — this section exists to
resolve Jacob's "does incus-web already have this" question: yes, and it's the stronger
implementation.

---

### 2.2 The package builder

**incus-unraid — a live, in-app, multi-distro image builder:**
- Backend: `unraid-api-plugin-incus/src/incus-image-builder.service.ts` — wraps the bundled
  `distrobuilder` binary (`/usr/local/incus/bin/distrobuilder`, private-prefixed, no system
  install) as a detached child process per build (`runBuild`, lines 318-375), tracked
  in-memory by build id with live log tailing (`getStatus`, `tailLog`, lines 235-241,
  377-385). Supports 6 curated distros with real, verified distrobuilder `source`/`packages`
  definitions (`DISTRO_DEFINITIONS`, lines 46-91) plus an "Other… (custom)" escape hatch.
  Renders a full distrobuilder YAML definition per build including a `post-packages` action
  script assembled from arbitrary post-install commands (`renderDefinition`, lines
  253-316). Uses `--import-into-incus=<alias>` so a successful build lands straight in the
  local Incus image store with no separate `incus image import` step. Persists a JSON image
  registry (`image-builds.json`) with master/variant tracking — exactly one image can be
  the "golden master" default (`setMasterImage`, lines 177-196), and every image can record
  `basedOn` for variant lineage.
- Package discovery: `unraid-api-plugin-incus/src/incus-package-search.service.ts` — a
  single unified search box hits apt (Debian/Ubuntu `Packages.gz`, parsed and cached),
  npm (registry.npmjs.org live search API), PyPI (full simple index, cached, locally
  scored), and Homebrew (full formula catalog, cached, locally scored) **concurrently**
  (`searchAll`, lines 124-159, `Promise.allSettled` — one source failing doesn't block the
  others), then merges into one relevance-ranked list (`mergeRanked`, lines 391-401). Has
  a 6h success cache / 1m failure backoff and in-flight request de-duplication
  (`dedupeInFlight`, lines 84-93) so concurrent identical searches share one fetch.
- Saveable builder presets: `unraid-api-plugin-incus/src/incus-builder-presets.service.ts`
  (not fully read above, referenced from `incus.resolver.ts` imports and `config.entity.ts`
  `BuilderPreset`/`BuilderPresetInput`, lines 244-257).
- Post-launch package install (separate from image build): `IncusExecService`'s Homebrew
  installer (`incus-exec.service.ts:170-260ish`) — installs Homebrew into the running
  agent user's own home (`/home/agent/.linuxbrew`, no sudo, since Homebrew's official
  installer needs `sudo` for the shared `/home/linuxbrew/.linuxbrew` prefix which the
  jail's non-root user doesn't have) and then the requested formula, as a background job
  polled via `startHomebrewInstall`/`getHomebrewInstallStatus`.
- UI: Builder tab in `App.vue` (`activeTab === 'builder'`, starting ~line 1783) — distro
  picker, release picker, unified package search box, "anything else" free-text package
  field, live build log streaming per build (lines ~2129-2166), and image registry list
  with master/variant badges.

**incus-web — exists, but a single, CI-baked image, not an in-app builder:**
- `distrobuilder.yaml` (repo root) is one fixed Debian Trixie definition — packages,
  post-install script (Node, GitHub CLI, Tailscale, Claude Code, WeTTY, ghostty-web-demo,
  Codex CLI, agent user creation) are all hardcoded (`distrobuilder.yaml:69-223`).
- `scripts/build-image.sh` (39 lines) is a thin CLI wrapper:
  `distrobuilder build-incus "$DEFINITION" "$EXPORT_DIR" --type "$BUILD_TYPE"`, exporting a
  tarball rather than importing straight into a live daemon's image store.
  `README.md:31-61` documents that GitHub Actions builds this on PR/push to `main`, uploads
  a short-lived artifact, and publishes to a rolling `incus-web-agent-latest` GitHub
  Release; there is no live multi-distro picker, no package search, and no way for an
  operator to build a custom image from the web UI at all.
- `scripts/build-agent-golden.sh` (126 lines, not fully read) appears to build a
  "golden" container by cloning rather than a distrobuilder image — worth a closer look
  before designing the port, since it may already be incus-web's analog of
  incus-unraid's "golden master" image concept, just container-clone-based instead of
  image-registry-based.
- No package search of any kind (apt/npm/PyPI/Homebrew) exists anywhere in the repo.
- No devcontainer.json/mise.toml/.tool-versions import UI (see 2.5/2.6 below) — those are
  precisely the features that, in incus-unraid, feed the Builder tab.

**Porting approach — this is the single largest feature gap.** Sequenced:
1. **Package search backend** (S–M): port `incus-package-search.service.ts` near-verbatim
   into a Next.js API route or a small Node service alongside the existing provisioner
   (`apps/web/app/api/.../package-search/route.ts` or a provisioner command type). The
   logic is dependency-light (native `fetch`, `zlib.gunzipSync`) and framework-agnostic —
   translate the NestJS `@Injectable()` class into a plain module with the same caching
   Maps, or keep it as a class if incus-web later adopts DI. No Incus REST calls needed
   here at all, so this piece can ship independently of the image-builder work.
2. **Image builder as a new provisioner command type** (M–L): incus-web's provisioner
   already models async operations well (`ProvisionerOperation`, `OperationStatus` in
   `apps/web/lib/provisioner/contracts.ts:36,298-312`). Add a `BuildImage` command type
   (payload: distro/release/packages/postInstallCommands/alias/basedOn; result: build id +
   status, mirroring `ImageBuildStatus` in incus-unraid's `config.entity.ts:259-270`), plus
   a `GetImageBuildStatus`/`ListImages`/`SetMasterImage` set. The provisioner-side
   implementation (likely `scripts/provisioner-server.mjs`, since that's the host-privileged
   process with Incus socket access) should port `incus-image-builder.service.ts`'s
   `distrobuilder build-incus ... --import-into-incus=<alias>` approach directly — the
   private-prefix/env-var pattern (`INCUS_SOCKET`, `PATH`, `LD_LIBRARY_PATH`,
   `DEBOOTSTRAP_DIR`) doesn't apply verbatim (incus-web assumes a normal Incus install, not
   a private-prefixed Unraid one) but the child-process/log-tail/JSON-registry pattern
   ports directly.
3. **Distro definitions**: port `DISTRO_DEFINITIONS` (debian/ubuntu/alpine/rocky/alma/fedora)
   as-is — these are verified against upstream `lxc-ci` and not incus-unraid-specific.
4. **Builder UI**: new Next.js page/panel using Aurora components — distro/release select,
   package search-as-you-type box (debounced, hitting the new search API), "anything else"
   free-text field, live build log (poll `GetImageBuildStatus` or use a Server-Sent
   Events/WebSocket log tail), and an image registry table with a "set as default" (master)
   action. This is genuinely new frontend surface, not a port of Vue code, but the
   information architecture (fields, states, badges) from `App.vue`'s Builder tab section
   translates directly into an Aurora component tree.
5. **Presets**: port `incus-builder-presets.service.ts` (small, JSON-persisted) once the
   builder UI exists — low priority, defer to a later pass.
6. Decide whether image builds happen against the *shared* Incus daemon (multi-tenant
   concern — a build should probably be scoped per-project/owner) or a dedicated
   builder project, since incus-web is explicitly multi-tenant-aiming
   (`ProvisionerWorkspaceRef.incusProject`) while incus-unraid is single-tenant
   (one Unraid box, one daemon, no project isolation concept at all).

**Effort:** L overall (package search S–M, image-builder command+backend M, UI M–L).
**Risks:** distrobuilder needs to be present on the host running the provisioner (already
true for incus-web's CI build step, but not guaranteed on every deploy target); multi-tenant
project isolation for builds is a real design question incus-unraid never had to answer;
build concurrency/resource limits per host aren't modeled anywhere yet in either repo.

---

### 2.3 Dashboard

**incus-unraid — live fleet dashboard with polling telemetry:**
- Summary cards: total/running/stopped containers, daemon reachability badge, memory in
  use, and a **live CPU rate with a client-side sparkline** computed from the delta between
  cumulative-CPU-time polls every 5s (`App.vue:2175-2214`, sparkline via inline SVG
  `polyline`, `sparklinePoints`/`fleetHistory`). Explicitly documented as ephemeral/
  client-only, resets on reload.
- Network & ACL status card: bridge name, subnet, ACL name, blocked-range count, default
  egress/ingress action — all read from already-loaded config, not a live probe
  (`App.vue:2216-2240`).
- Launch Container card: name + image picker (defaults to configured golden master or any
  tracked image), inline validation (`App.vue:2241-2263`).
- Containers list/table with per-row actions (start/stop/restart/freeze/delete) and a
  **Details panel** (`JailDetail` in `config.entity.ts:211-233`) showing Incus's fully
  *merged* profile+instance config: image os/release/description, storage pool, network
  bridge, and — critically — **effective CPU limit, memory limit, and workspace host path,
  each independently flagged as either inherited-from-profile or instance-level override**,
  with per-field override/reset controls (`incus.service.ts:330-389`,
  `incus.resolver.ts` mutations `setJailLimits`/`setJailWorkspace`/`clearJailWorkspace`).
- Cleanup action: "delete all stopped" (`incus.service.ts:242-255`).
- Exec/terminal tab riding GraphQL subscriptions (`incus-exec.service.ts`).

**incus-web — read-only workspace inventory, single-workspace-oriented:**
- `apps/web/app/page.tsx` renders `WorkspaceDashboard` from a server-fetched
  `WorkspaceInventory` (`apps/web/lib/workspaces/provisioner.ts`,
  `getWorkspaceInventory`). Explicitly documented as **read-only** in `README.md:81`
  ("This first slice is read-only... without mutating Incus state").
- `apps/web/components/workspace-dashboard.tsx` (617 lines) shows, per workspace: state
  badge, setup phase + 4 setup checks (dotfiles/mise/command/package status via
  `SetupCheck`), and 3 opaque resource strings — `resources.cpu` / `.memory` / `.storage`
  (`apps/web/lib/workspaces/types.ts:50-54`) — with **no numeric telemetry, no live
  polling, no sparkline, no override editor**. `WorkspaceActions` component exists
  (`apps/web/components/workspace-actions.tsx`, referenced at
  `workspace-dashboard.tsx:36`) — need to confirm at read time whether it currently wires
  up start/stop/restart or is still a stub, since the README says this slice is read-only.
- `AgentRunDispatch` component (line 35) is a genuinely richer feature incus-unraid has no
  equivalent for at all — dispatching an autonomous coding-agent run (Codex/Claude) into a
  cloned container (see `apps/web/lib/provisioner/contracts.ts:167-227` `AgentRun*` types).
  This is worth flagging as something incus-unraid could conceivably want *ported the other
  direction* eventually, though that's out of scope here.
- No per-container CPU/memory *numbers* (bytes, cores) are modeled anywhere in
  `WorkspaceRuntimeStatus` beyond `cpuCount`/`memoryUsedBytes`/`memoryLimitBytes`/
  `rootDiskUsedBytes`/`rootDiskLimitBytes`/`loadAverage`
  (`apps/web/lib/provisioner/contracts.ts:125-138`) — the *types* already exist in the
  contract, they're just not populated/rendered yet as live polling data in the current
  slice.

**Porting approach:**
1. **Live polling + sparkline** (S–M): `WorkspaceRuntimeStatus` already has the numeric
   fields needed (`cpuCount`, `memoryUsedBytes`, etc.) — the gap is purely on the
   frontend: add a client-side poll loop (5s interval, matching incus-unraid's cadence)
   calling `GetWorkspaceStatus`, keep a bounded rolling history array client-side (mirror
   `fleetHistory`), and render an inline SVG sparkline exactly like `App.vue`'s pattern —
   no new backend contract needed for a single workspace; for a fleet-of-workspaces
   dashboard (multi-tenant future), aggregate across `ListWorkspaces` once that command
   type exists.
2. **Container config detail + override editor** (M): this needs new provisioner command
   types (`GetWorkspaceDetail` returning the incus-unraid-equivalent of `JailDetail`:
   profiles, image os/release, storage pool, network bridge, and CPU/memory/workspace
   effective-value + is-override flags) plus mutation commands (`SetResourceLimits`,
   `SetWorkspacePath`, `ClearWorkspaceOverride`). Port `incus.service.ts`'s
   `getJailDetail`/`setJailLimits`/`setWorkspace`/`clearWorkspaceOverride` logic
   (expanded_config vs config diffing) into the provisioner server
   (`scripts/provisioner-server.mjs`), which already owns the Incus REST/CLI boundary.
3. **Network & ACL status card** (S): straightforward — the ACL/bridge config is already
   known to `deploy.sh`/`incus-web-lib.sh`; expose it either via a static config command or
   bake it into `WorkspaceRuntimeStatus`.
4. **Cleanup-stopped action** (S): low-value for incus-web's per-user-workspace model
   (each user typically has one workspace, not a fleet of throwaway containers) — likely
   more relevant to the `AgentRun` ephemeral-container cleanup path than the main
   dashboard; consider pairing it with agent-run container lifecycle instead of porting
   verbatim.
5. Verify `WorkspaceActions` component's current wiring before starting — if start/stop/
   restart mutations are already implemented end-to-end, this phase is mostly "add more
   controls to an existing pattern"; if not, wiring those up is a prerequisite for anything
   here.

**Effort:** M overall, decomposable into S-sized increments. **Risks:** the numeric-metrics
polling is safe/additive; the override-editor mutation surface needs the same "resolve
merged config, distinguish inherited-vs-override" care incus-unraid's `incus.service.ts`
takes (`ownConfig[...] !== undefined` checks) — get this wrong and the UI could show a
value as "overridden" when it's actually inherited, or vice versa, misleading operators
about what a reset would actually do.

---

### 2.4 Configuration of the containers (resource limits, devices, mounts, env)

**incus-unraid:**
- Global defaults live in `incus.cfg`/`IncusConfig` (`config.entity.ts:14-134`): CPU/memory
  caps (`jailCpu`/`jailMemory`, empty = uncapped), nesting toggle (`jailNesting`), agent
  uid/gid, workspace root, and a **free-form `jailBindMounts` string** — comma-separated
  `host:container[:ro]` triples for reusing host auth/config directories like `~/.claude`
  (documented in `MANIFEST.md`'s config table and `config.entity.ts:126-128`) — this is
  not further parsed/validated in the code read so far; worth a closer look at
  `config-sync.service.ts` before porting, to see if/how it's turned into actual Incus
  device entries.
- Per-container overrides are **independent of the profile default** at the instance
  level: CPU/memory via `limits.cpu`/`limits.memory` config keys
  (`incus.service.ts:335-344`), workspace host path via a `workspace` disk device
  (`incus.service.ts:307-328`), each with an explicit "is this an override or inherited"
  flag surfaced to the UI (`getJailDetail`, lines 351-389) and a "clear override, revert to
  profile" mutation (`clearWorkspaceOverride`, lines 318-328).
- The profile template itself (`agent-jail-profile.yaml.tmpl`) defines the network device,
  the shared default workspace device, `security.privileged`/`nesting`/`idmap.isolated`,
  and cloud-init `user-data` for base package installation and user creation — this is a
  single shared profile, templated via `sed` substitution in `incus-init.sh`, not a
  per-container customization surface.
- Env vars: not modeled as a first-class Incus `environment.*` config key anywhere found in
  this codebase — toolchain/env setup happens via cloud-init `write_files`/`runcmd` in the
  profile template, or via distrobuilder `post-packages` actions/`post-install` commands
  during image build, not via live per-container env var injection.

**incus-web:**
- `apps/web/lib/workspaces/types.ts:50-54` — `WorkspaceResources` is `{ cpu: string;
  memory: string; storage: string }`, opaque display strings only, no edit path.
- `incus-web-profile.yaml` (38 lines, root) is the single shared profile analogous to
  incus-unraid's `agent-jail-profile.yaml.tmpl` — device/NIC/workspace-disk shape, not
  per-container.
- `deploy.sh`/`incus-web-lib.sh` apply per-deploy overrides at container-create time
  (`incus_cmd config device override "$CONTAINER_NAME" eth0 network="$INCUS_NETWORK"`,
  `deploy.sh:200-201`) but this is a one-shot creation-time step run by the shell deploy
  script, not a live, re-editable, UI-driven per-container config surface — there's no
  provisioner command to change CPU/memory/workspace path on an existing running
  workspace.
- No `jailBindMounts`-equivalent free-form host-mount feature exists in incus-web at all —
  `DOTFILES_SOURCE_DIR`/`DOTFILES_AGE_KEY_FILE` (README.md:249-250) cover one specific
  host→container copy (dotfiles/age key), not a general bind-mount mechanism.

**Porting approach:**
1. **Resource limit editor** (M): same provisioner-command work as 2.3 item 2
   (`SetResourceLimits`) — this is really one feature split across "dashboard display" and
   "config editing," so implement them together.
2. **General bind-mounts** (S–M, judgment call): incus-unraid's `jailBindMounts` is a
   simple, useful pattern for reusing host agent-auth directories
   (`~/.claude`, `~/.codex`, ssh keys, etc.) across container rebuilds without re-auth. For
   incus-web's multi-tenant design this needs more care than incus-unraid's single-owner
   Unraid box — a free-form host-path bind mount is a privilege-escalation-relevant surface
   in a multi-user context (a workspace owner could theoretically request a mount of
   another user's host directory unless validated). Port the *concept* (structured,
   validated `host:container[:ro]` triples, applied as Incus disk devices) but add the
   same directory-containment validation `setJailWorkspace` already uses for the
   single existing mount (`incus.resolver.ts:120-130`, resolving `..` and checking
   path-segment containment) generalized to a per-owner allowed-roots list, not a
   free-for-all host path.
3. **Env var injection**: neither repo does this as a first-class live feature today; low
   priority unless a concrete need surfaces (e.g., devcontainer.json's `containerEnv` field
   — see 2.5, currently explicitly unmapped/skipped by incus-unraid too).

**Effort:** M. **Risks:** multi-tenant bind-mount validation is the one place this section
needs *more* rigor than incus-unraid, not just a straight port — get the path validation
wrong and it's a host filesystem escape from a "just reuse my dotfiles" feature.

---

### 2.5 Importing `.devcontainer/devcontainer.json`

**incus-unraid — client-side, best-effort translator, feeding the Builder tab:**
- `unraid-api-plugin-incus/web/src/App.vue:1159-1338`. Pure frontend logic (no new backend
  endpoint) that reads a picked `devcontainer.json` file and maps it onto the Builder tab's
  existing distro/release/packages/post-install-command state.
- `inferDistroReleaseFromImage` (lines 1166-1202): pattern-matches the devcontainer
  `image` field against known base-image conventions (alpine, fedora, rockylinux/rocky,
  almalinux/alma, ubuntu codenames `jammy|noble|resolute|focal|bionic`, debian codenames
  `bookworm|trixie|sid|bullseye|buster`, plus bare `node:`/`python:` images treated as
  Debian) and resolves to one of the 6 curated distro/release pairs, falling back to a
  sane default release per distro family when the tag doesn't match a curated release.
- `mapFeatureToPrereqGroup` (lines 1204-1212): maps `features` refs
  (`ghcr.io/devcontainers/features/<name>:<ver>`) to curated package groups — only `node`
  and `python` features are mapped to real package groups; `git`/`common-utils` features
  are special-cased to specific package lists (lines 1257-1272); anything else is reported
  as skipped, not guessed.
- `importDevcontainerJson` (lines 1221-1301) is the orchestrator: sets distro/release from
  `image` (or reports `build.dockerfile` as unsupported — Dockerfile-based devcontainers
  aren't translated at all), walks `features`, converts `postCreateCommand`/
  `postStartCommand` into **visible, editable, removable post-install command entries**
  rather than running them silently (explicit comment: these commands assume a checked-out
  repo that doesn't exist at image-build time, so surfacing them for review is a
  deliberate safety choice, not an oversight), and explicitly reports
  `remoteUser`/`containerUser`/`forwardPorts`/`mounts`/`workspaceFolder` as unmapped
  fields rather than silently dropping them.
- `stripJsonComments` (lines 1304-1309) tolerates devcontainer.json's JSONC dialect
  (`//` comments, trailing commas) before `JSON.parse`.
- Result type `DevcontainerImportResult { distroSet, packagesAdded, commandsAdded,
  skipped }` (lines 1214-1219) is surfaced directly in the UI as a summary/skip-list
  (lines 1907-1924 range, referenced from the grep).

**incus-web:** No devcontainer.json handling anywhere in the repo (`grep -ri devcontainer`
across the tree returns nothing). No equivalent "import a config file to seed a build"
concept exists at all — `distrobuilder.yaml` is hand-authored and static.

**Porting approach:**
1. **Prerequisite**: this feature is meaningless without 2.2's image-builder UI existing
   first — devcontainer import's whole purpose in incus-unraid is to *pre-fill* the
   Builder tab's state. Sequence this strictly after 2.2.
2. Port `inferDistroReleaseFromImage`, `mapFeatureToPrereqGroup`, `stripJsonComments`, and
   `importDevcontainerJson` near-verbatim as framework-agnostic TypeScript (they have zero
   Vue-specific dependencies beyond mutating a few `ref()`s — swap those for React
   `useState` setters or a reducer action in the new builder page/component).
3. Reuse the exact same curated distro/release list incus-web's new builder UI will need
   for 2.2 (`CURATED_DISTROS`/`CURATED_RELEASES`, referenced but not fully dumped above —
   read `App.vue`'s top-of-file constants when implementing, to keep the distro/release
   value strings identical to what `DISTRO_DEFINITIONS` in the ported image-builder
   service expects).
4. Preserve the "report what we couldn't map, don't guess" UX contract — this is the
   single most important behavioral property to carry over; a silent wrong-guess (e.g.
   picking the wrong distro because of a fuzzy image-tag match) is worse than an explicit
   "couldn't infer, pick manually" message.
5. Decide file-picker UX in Next.js: incus-unraid uses a plain hidden `<input type=file>` +
   `FileReader` (`App.vue:1312-1338`) — this pattern ports directly to React with no
   framework-specific gotchas.

**Effort:** S once the Builder UI (2.2) exists — this is mostly a direct TypeScript port
of ~150 lines of pure logic plus a file-input component. **Risks:** low; the main risk is
scope-creep trying to map *more* devcontainer fields than incus-unraid does (resist the
urge — the "report and skip" pattern is the right level of ambition for a best-effort
importer).

---

### 2.6 Importing `.tool-versions` (and `mise.toml`)

**incus-unraid — also client-side, feeding post-install commands, not OS packages:**
- `unraid-api-plugin-incus/web/src/App.vue:1340-1456`. Explicit design rationale in the
  header comment (lines 1340-1352): mise/asdf tool pins **cannot** map to OS packages (apt
  rarely has the exact pinned version, and doesn't cover most of mise's backends — cargo,
  npm, go, GitHub releases — at all), so the only correct mapping is baking `mise` itself
  into the image via its official installer, then letting `mise` install the pinned tools
  at image-build time, matching how it'd work on a real dev machine.
- `parseMiseToolsTable` (lines 1359-1379): reads a parsed `mise.toml`'s `[tools]` table;
  handles plain version strings, asdf-style fallback-version arrays (takes only the first),
  and mise's extended object form (`{ version = "...", postinstall = ... }`, only
  `.version` is used — build-time-irrelevant fields like `postinstall`/`os` are ignored).
- `parseToolVersionsFile` (lines 1381-1394): plain-text asdf `.tool-versions` parser —
  `<tool> <version> [<fallback>...] [# comment]` per line, strips `#` comments, splits on
  whitespace, takes only the first version on a fallback-chain line.
- `ensureMiseInstalled` (lines 1396-1409): idempotent (keyed `postInstallCommands` map
  entries so importing both a `mise.toml` and later adding dotfiles bootstrap doesn't
  double-install) — adds `curl`/`ca-certificates` prereqs, sets
  `MISE_DATA_DIR=/opt/mise MISE_CONFIG_DIR=/etc/mise` (system-wide, not the build root
  user's home — critical detail: the actual container runtime user is a *different*,
  non-root uid created at container launch time, not present yet during image build, so
  mise must be installed somewhere that user can reach later), installs via
  `curl https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh`, and writes a
  `/etc/profile.d/mise.sh` activation script.
- `applyMiseToolPairs` (lines 1411-1417): renders one `mise use -g <tool>@<version> ...`
  command from parsed pairs.
- `importMiseToml`/`importToolVersions` (lines 1419-1430) are thin wrappers reporting
  `toolsAdded` for the UI summary, erroring clearly if no entries were found.
- **Bonus, same section**: dotfiles-repo bootstrap (lines 1458-1488+) — clones a
  user-supplied dotfiles git repo into the image and best-effort runs
  `MISE_EXPERIMENTAL=1 mise bootstrap --yes || true` against it, explicitly tolerating
  failure since `mise bootstrap` only does something useful if the cloned repo itself has
  `[dotfiles]`/`[bootstrap.repos]` mise config, which can't be verified client-side before
  the image build actually clones it.

**incus-web:** No `.tool-versions`/`mise.toml`/asdf handling in the image-builder path
(`distrobuilder.yaml` has none). **However**, incus-web already has a **live, per-container,
post-deploy** mise/dotfiles feature that's conceptually adjacent but architecturally
different: `DOTFILES_REPO`, `DOTFILES_SOURCE_DIR`, `DOTFILES_AGE_KEY_FILE`,
`DOTFILES_RUN_MISE`, `DOTFILES_SKIP_APT` (`README.md:172-176,248-252`), and the
`RunSetup` provisioner command (`apps/web/lib/provisioner/contracts.ts:158-165,247-261` —
`RunSetupPayload{ dotfilesRepo, ageKey, skipAptScripts }`, `ProvisionerSetupPhase` includes
`installing_mise`/`applying_dotfiles`/`checking_tools`). This is a **chezmoi**-based,
per-user, post-container-creation apply, not an image-build-time mise tool-version import —
different point in the lifecycle, different tool (chezmoi vs raw git-clone + mise bootstrap),
but solving an overlapping "get my dev environment into this container" problem.

**Porting approach:**
1. Same prerequisite as 2.5: sequence after 2.2's Builder UI exists.
2. Port `parseMiseToolsTable`, `parseToolVersionsFile`, `ensureMiseInstalled`,
   `applyMiseToolPairs`, `importMiseToml`, `importToolVersions` near-verbatim — pure
   TypeScript, no Vue coupling beyond the `ref()`/UI-summary glue.
3. **Reconcile with incus-web's existing `DOTFILES_RUN_MISE`/`RunSetup` path** rather than
   building a second, disconnected mise-install mechanism: incus-web already installs mise
   for the *runtime* user post-deploy when `DOTFILES_RUN_MISE=1`
   (`README.md:251` — "install mise for the terminal user and run `mise install`"). The
   image-builder-time import (this feature) bakes mise + specific pinned tool versions into
   the *image itself* (system-wide, available immediately without a setup step), which is
   complementary, not redundant — image-build-time is "this image always has these tools,"
   while `RunSetup`'s dotfiles-driven mise is "this specific user's tool config, applied
   after container creation." Document the distinction clearly in whichever UI ends up
   exposing both, so operators aren't confused about which one to use when.
4. If/when the dotfiles-bootstrap sub-feature (mise `[bootstrap.repos]`) gets ported too,
   check for overlap with incus-web's existing `DOTFILES_REPO`/`DOTFILES_SOURCE_DIR` — this
   might be redundant with what `RunSetup` already does at the container level, and porting
   it into the image-builder as well could genuinely just be scope creep; recommend
   **not** porting the dotfiles-bootstrap sub-feature initially, since incus-web's
   `RunSetup` chezmoi path already covers "get my dotfiles into this container" more
   robustly (encrypted age-key support, persistence policy, structured setup-phase
   tracking) than incus-unraid's best-effort `mise bootstrap --yes || true`.

**Effort:** S (tool-version import) once Builder UI exists, **skip** the dotfiles-bootstrap
sub-feature (redundant with existing `RunSetup`). **Risks:** low for the core import; the
main risk is UX confusion between two different "get my tools in" mechanisms (image-bake
vs post-deploy chezmoi/mise) if not clearly labeled in the UI.

---

## 3. Suggested phasing

**Phase 1 — quick wins / no new backend surface (days, not weeks)**
1. Doc note: confirm and document that incus-web's network ACL excludes Tailscale CGNAT
   (§2.1 item 1).
2. Package search backend + a minimal search-only UI affordance, even before the full
   image builder exists (§2.2 step 1) — useful standalone (e.g., "what apt packages exist
   for X") and fully decoupled from everything else.
3. Investigate `scripts/build-agent-golden.sh` and `WorkspaceActions` current wiring before
   scoping Phase 2 — both directly change the shape of Phase 2 work and weren't fully read
   in this pass.

**Phase 2 — dashboard + config editing (the direct competitive gap vs incus-unraid's UI)**
4. Extend `WorkspaceRuntimeStatus` polling on the frontend + sparkline (§2.3 item 1) — pure
   frontend, contract fields already exist.
5. New provisioner command types: `GetWorkspaceDetail`, `SetResourceLimits`,
   `SetWorkspacePath`, `ClearWorkspaceOverride` (§2.3 item 2, §2.4 item 1) — the core
   "container config editor" backend work, shared by dashboard and config UI.
6. Container detail panel + override editor UI (§2.3 item 2, §2.4 item 1 UI half).
7. Network & ACL status card (§2.3 item 3) — small, pairs naturally with step 6.

**Phase 3 — image builder (largest, most valuable, most new surface)**
8. `BuildImage`/`GetImageBuildStatus`/`ListImages`/`SetMasterImage` provisioner commands +
   provisioner-server implementation, porting `incus-image-builder.service.ts`'s
   distrobuilder-child-process + JSON-registry pattern (§2.2 steps 2-3).
9. Builder UI: distro/release picker, package search integration (reuses Phase 1 step 2),
   free-text package field, live build log, image registry table (§2.2 step 4).
10. devcontainer.json import, feeding the Builder UI (§2.5) — direct port once step 9 lands.
11. `.tool-versions`/`mise.toml` import, feeding the Builder UI (§2.6) — direct port once
    step 9 lands; explicitly skip the dotfiles-bootstrap sub-feature (redundant with
    existing `RunSetup`).
12. Builder presets (§2.2 step 5) — low-priority polish, can slip past Phase 3 if time-boxed.

**Phase 4 — deferred / needs product decision, not just engineering**
13. General bind-mounts (§2.4 item 2) — needs a multi-tenant path-validation design
    decision before implementation (allowed-roots list per owner, not a free-for-all).
14. Multi-tenant project isolation for image builds (§2.2 item 6) — architecture question,
    not a straightforward port; resolve before or during Phase 3 step 8, not after.

Phases 1 and 2 have no dependency on each other and could run in parallel if resourced.
Phase 3 depends on nothing from Phase 2, but items 10-11 within Phase 3 strictly depend on
Phase 3 item 9. Phase 4 items are gates, not sequenced work — they block specific Phase 2/3
sub-items (noted above) until a decision is made, they don't need their own dedicated slot.

---

## 4. Other useful patterns

Found while exploring beyond the six named features — not required, but worth the team's
attention:

- **Preflight-gate-before-start, not fail-after-start**
  (`source/usr/local/emhttp/plugins/incus/scripts/incus-preflight.sh`): a dedicated,
  read-only, non-mutating script that checks glibc version, required shared libs (bundled
  or host), `unsquashfs`/`nft` on `PATH`, full `ldd` link resolution for the actual `incusd`
  binary, cgroup v2, user namespaces, and `newuidmap`/`newgidmap` presence — printing a
  clear PASS/FAIL report and refusing to start the daemon on FAIL, changing nothing.
  incus-web's `deploy.sh` has some of this ad hoc (`install_incus_if_needed`,
  `ensure_incus_ready`) but not as a single, explicit, re-runnable, side-effect-free
  diagnostic command an operator could run standalone to answer "will this host even
  work?" before touching anything. Worth extracting incus-web's install/readiness checks
  into a similarly named, similarly non-mutating `scripts/incus-web-preflight.sh` (or a
  `--preflight`/`--check` flag on `deploy.sh`) for the same "fails loud, changes nothing"
  UX property, especially useful for a curl-piped deploy where a partial failure mid-script
  is much harder to recover from than a pre-flight refusal.

- **Idempotent, re-run-safe init script pattern**
  (`source/usr/local/emhttp/plugins/incus/scripts/incus-init.sh`): every resource
  (storage pool, ACL, bridge, profile) is check-then-create/re-apply, gated with `flock` to
  prevent concurrent runs, and every `incus` CLI call is explicitly given `</dev/null`
  because several subcommands (confirmed: `profile create`) hang forever waiting on stdin
  in a non-interactive/process-managed context otherwise — a sharp, easy-to-miss gotcha
  worth grep-checking incus-web's own `incus_cmd` invocations in `incus-web-lib.sh` for,
  since the same Incus CLI behavior would apply there too if any bare `incus` calls lack
  stdin redirection.
- Also worth lifting: the "tear down and recreate an unmanaged same-named network
  interface rather than fail" logic (`incus-init.sh:172-190`) — handles the specific case
  of a stale bridge left over from a prior daemon instance pointed at a different
  `INCUS_DIR`, which `network set` can't fix in place (`Only managed networks can be
  modified`). If incus-web ever supports re-pointing `INCUS_NETWORK`/`INCUS_DIR` across
  redeploys, this exact failure mode will recur.
- The **workspace-fstype guard** (`incus-init.sh:196-206`) — refuses to start if
  `JAIL_WORKSPACE_ROOT` resolves to `tmpfs`/`ramfs` (Unraid's RAM-boot root), since that
  would silently discard all workspace data on reboot. incus-web's `HOST_WORKSPACE` has an
  analogous risk if ever deployed on a similarly RAM-rooted host; a cheap, high-value
  guard to add to `ensure_agent_network`/workspace setup in `incus-web-lib.sh`.

- **Per-instance workspace isolation by default**
  (`incus.service.ts:188-211,282-291`): every `launchJail` call gets its own
  `${workspaceRoot}/${name}` subdirectory automatically, rather than sharing one directory
  across concurrent containers from the same image/profile — with a `migrateToOwnWorkspace`
  escape hatch for containers launched before this existed. Cross-check incus-web's
  `HOST_WORKSPACE` handling (`README.md:177-178,253`, single `$HOME/incus-web-data/
  $CONTAINER_NAME` path) — since incus-web is currently closer to one-workspace-per-user by
  design (multi-tenant via separate `incusProject`/`incusContainer` per user, per
  `ProvisionerWorkspaceRef`), this pattern is likely already satisfied structurally rather
  than needing an explicit port, but worth confirming there's no code path where two
  workspaces could share a host directory.

- **Path-containment validation pattern, reusable**
  (`incus.resolver.ts:119-131`, `incus.service.ts:282-291`): `resolve()`-then-
  `startsWith(root + sep)` (not a bare string-prefix check) to stop a workspace/hostPath
  argument from escaping a configured root via `..` traversal or a similarly-prefixed
  sibling directory name (e.g. `/srv/agent-jails-evil` vs `/srv/agent-jails`). This exact
  pattern is the right one to reuse for §2.4's proposed general bind-mounts feature and any
  other user-supplied-path surface incus-web adds.

- **Graceful multi-source degradation** (`incus-package-search.service.ts:124-159`):
  `Promise.allSettled` across independent search sources, each failure captured and
  reported separately (`PackageSearchError[]`) rather than one source's outage taking down
  the whole search — plus a short negative-result cache (`FAILURE_TTL_MS = 60s`) so a
  flaky upstream doesn't get hammered on every keystroke but recovers within a minute. This
  is a directly reusable pattern for incus-web's own package-search port (§2.2 step 1) and
  a generally good template for any future multi-upstream aggregation incus-web adds.

- **Exec-over-existing-transport, not a new endpoint**
  (`incus-exec.service.ts` header comment, lines 17-29): rides the browser-facing
  GraphQL subscription transport already wired up for other purposes, rather than adding a
  bespoke WebSocket route — deliberately reuses existing auth/proxying instead of creating
  a second attack surface / second thing to keep authenticated correctly. Worth keeping in
  mind if incus-web ever adds its own in-browser exec/terminal-attach feature beyond the
  existing WeTTY/Tailscale-Serve terminal — prefer extending the existing provisioner
  transport over standing up a parallel channel.

- **Explicit two-level operation-envelope nesting gotcha** (documented in
  incus-unraid's `CLAUDE.md:47` and reflected in `incus-exec.service.ts`'s `waitForOperation`
  return-type comment, `incus.service.ts:82-97`): the Incus REST API's async operation
  envelope nests operation-type-specific payloads two levels deep
  (`response.metadata.metadata.<field>`), not one — an easy, silent bug source. Worth
  cross-checking incus-web's provisioner Incus REST/CLI client for the same gotcha if it
  talks to the same API surface (vs. shelling out to the `incus` CLI, which incus-unraid
  deliberately avoids but incus-web may use — confirm which approach `provisioner-server.mjs`
  actually takes before assuming this applies).

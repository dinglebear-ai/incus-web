# incus-unraid → incus-web: Full Parity, Elevated

Everything incus-unraid can do, incus-web will do — with a typed provisioner contract instead of a config file, an async job model instead of blocking calls, and a dashboard worth showing off instead of a settings page. Research verified by direct reads of `/home/jmagar/workspace/incus-unraid` (NestJS/GraphQL + Vue 3, Unraid plugin) and `/home/jmagar/workspace/incus-web` (this repo: Next.js 16 + a Node.js host provisioner over a Unix socket). distrobuilder specifics verified against the [official docs](https://linuxcontainers.org/distrobuilder/docs/latest/).

---

## 1. Where we start, where we land

incus-web already wins on foundations: a closed, typed command contract (`contracts.ts`, every command payload/result validated with `hasOnlyKeys`), reverse-proxy identity, a working CI image pipeline, ZFS golden-container cloning for fast ephemeral runs. What it doesn't have is everything that makes a container platform feel *alive* day-to-day: you can't build a custom image without editing YAML and pushing to `main`, you can't change a container's resources without SSHing in, and the dashboard shows you a static snapshot instead of what's actually happening.

incus-unraid has all of that — a live image builder, per-container resource editing, real-time stats, config editing from the UI — but it's built on a looser trust model (one shared GraphQL config surface, no distinct authorization tiers, string-templated build definitions). We're not porting that model. We're porting the *capability* and building it on incus-web's stricter foundation: every new mutating command gets the same discriminated-union + allow-list treatment as the existing eight, every privileged operation gets its own isolation boundary, and the dashboard becomes the best-looking part of the whole system.

**Six features, all in scope, all built better than the source:**

1. **Tailscale autojoin** — already done, already better than incus-unraid's. Ship as-is.
2. **Image builder** — real, interactive, distrobuilder-backed, sandboxed, async. Not a bolt-on.
3. **Dashboard** — the standout feature. Live telemetry, a real Details panel, a Builder tab, a Config surface, multi-workspace navigation.
4. **Container configuration** — CPU/memory/mount editing from the UI, with a proper capability model from day one.
5. **devcontainer.json import** — near-verbatim port, feeds the Builder directly.
6. **`.tool-versions` / mise.toml import** — both build-time (bake into the image) and runtime (seed the existing per-user bootstrap) supported, user's choice.

---

## 2. The image builder, built right

This is the centerpiece. incus-unraid's version (`incus-image-builder.service.ts`) proves the shape works: pick a distro, add packages, add post-install commands, get an image. We're building the same experience with a materially safer implementation, using distrobuilder's actual documented interface rather than string-templated YAML.

### 2.1 What distrobuilder actually needs

A definition file has five sections that matter to us:

- **`image`** — `distribution`, `release`, `architecture`, `description`, `variant`. Required: `distribution`.
- **`source`** — a `downloader` (one of `debootstrap`, `ubuntu-http`, `alpinelinux-http`, `centos-http`, `fedora-http`, `archlinux-http`, and ~15 others), plus `url`, `keys`/`keyserver` for verification, `components` (debootstrap-specific).
- **`packages`** — a `manager` (`apt`, `dnf`, `yum`, `apk`, `pacman`, `zypper`, `xbps`, ...), `update`/`cleanup` booleans, and a list of package *sets* — each set is `{packages: [...], action: "install"|"remove", architectures?, releases?, variants?}`.
- **`actions`** — a list of `{trigger, action, architectures?, releases?, variants?}`. Triggers fire in a fixed order: `post-unpack` → `post-update` → `post-packages` → `post-files`. `action` is a shell script (needs a shebang) run inside the build chroot.
- **`targets.incus`** — for VM builds only (`vm.size`, `vm.filesystem`); container builds need nothing here.

`distrobuilder build-incus <definition> <output-dir> --type unified --import-into-incus=<alias>` is exactly what `scripts/build-image.sh` already runs — we're not introducing a new tool, just making the definition dynamic.

### 2.2 Definition rendering: structured, not templated

The single most important departure from incus-unraid's implementation: **never build the YAML by string interpolation.** incus-unraid's `renderDefinition()` builds up a definition object and hands it to a YAML serializer — that's the right instinct, and we'll do the same, but with explicit input validation at every field:

- **Distro/release**: a closed enum (`apps/web/lib/builder/distros.ts`), each entry a fully-specified `{downloader, url, keys, packageManager}` tuple — start with Debian trixie/bookworm and Ubuntu noble/jammy (incus-web's actual production targets), expand to Alpine/Rocky/Fedora once the pipeline is proven. A user picks from a `<select>`, never types a distro string.
- **Packages**: free-text input allowed, but validated server-side against a per-distro allow-pattern (`^[a-z0-9][a-z0-9+.\-]*$`, matching real Debian/apt package-name grammar) before ever reaching the definition — rejects shell metacharacters and injection payloads outright, not just "escapes" them.
- **Post-install commands**: the one place where the user is genuinely writing a shell script, because that's the actual feature — full editor freedom, always run inside the *sandboxed build worker* (below), never on the provisioner host, and always shown back to the user for review before a build starts, with the same "this came from an import, not from you" provenance flag as devcontainer.json imports (§5).

The renderer is a pure TypeScript module (`apps/web/lib/builder/render-definition.ts`) — given `{distro, release, packages, postInstallCommands}`, it returns a definition object, which a real YAML library (`js-yaml`) serializes. No string concatenation into YAML, ever.

### 2.3 Isolation: the build runs somewhere that isn't the provisioner

distrobuilder needs loopback mounts and debootstrap-class privileges — a fundamentally different trust tier than "run `incus start`." The provisioner today holds one bearer token that authorizes every lifecycle command; a build worker must not share that trust boundary.

Design: a **dedicated build-worker service** — its own systemd unit, its own service account, no access to the provisioner's Unix socket or bearer token. The Next.js app talks to it the same way it talks to the provisioner (a second typed command channel, `BuildCommand` union, same `hasOnlyKeys` discipline), but the worker's *only* capability is "run distrobuilder against a definition I rendered and hand back a log + an image alias." It cannot start, stop, or reconfigure any live container. If the build worker is ever compromised via a crafted definition, the blast radius stops at image-building — it can't touch running workspaces.

### 2.4 The async job model

Builds run for minutes; incus-web's existing command contract is synchronous with an 8-second timeout because it was designed for `start`/`stop`/`restart`. Rather than stretch that model, the builder gets its own shape from day one:

- `DispatchBuildImage(distro, release, packages, postInstallCommands, idempotencyKey)` → returns `{buildId}` immediately (buildId is a UUID, not sequential).
- `GetBuildStatus(buildId)` → `{status: queued|running|succeeded|failed, logOffset, logChunk}` — the dashboard polls this, and the poll takes a `since` byte offset so it only pulls new log bytes each tick (not incus-unraid's flat 16KB re-read).
- The `idempotencyKey` means a client retry after a network blip doesn't kick off a second build — the worker dedupes on it.
- Build state lives in SQLite (single-writer, WAL mode) — not a hand-rolled JSON file rewritten in full on every log line the way `agent-runs.mjs` does it today. Logs are appended, not re-serialized wholesale; querying "give me bytes 4096 onward" is a cheap read, not a full-file parse.
- Every `GetBuildStatus`/log-poll call re-checks that the requesting actor owns the build, exactly like every other workspace-scoped route.

Because builds are async and live on their own worker, they never touch the provisioner's 4-slot `acquireIncusSlot()` concurrency pool — someone building an image and someone starting their workspace never contend for the same resource.

### 2.5 Everything else incus-unraid's builder has — ported, improved

- **Package search across managers** (apt/npm/PyPI/Homebrew, incus-unraid's `Promise.allSettled`-graceful-degradation pattern) — ported as-is, plus a short-TTL response cache per query string (incus-unraid only had in-flight dedup; registries are slow and rate-limited, a cache is free latency to cut).
- **Saveable presets** — a named, reusable `{distro, release, packages, postInstallCommands}` bundle, stored per-actor.
- **Image registry** — `isMaster` (exactly one golden image at a time) and `basedOn` (variant lineage), same as incus-unraid, but living in the same SQLite store as build history rather than a separate JSON file. This is explicitly a *different* mechanism from `scripts/build-agent-golden.sh`'s ZFS clone-for-speed path — the registry tracks *what got built*, the ZFS clone is *how a workspace launches fast*. They compose: a workspace launch can clone from any registry-tracked image.
- **CI pipeline stays** — the interactive builder is additive. `distrobuilder.yaml` + GitHub Actions remains the canonical, environment-pinned path for the production base image; the interactive builder is for variants and one-offs.

---

## 3. The dashboard, elevated

incus-unraid's dashboard is a competent settings page. incus-web's should be the reason someone picks this over raw `incus` CLI usage. Four tabs, each better than the incus-unraid equivalent:

### 3.1 Containers (today's dashboard, made live)

- Real-time CPU/memory sparklines per workspace, like incus-unraid's, but **persisted server-side** instead of resetting on page reload — a small ring-buffer table (last N samples per workspace) so a returning user sees recent history, not a blank chart. incus-unraid's client-only history is a real regression we won't repeat.
- Prerequisite: `statusCache`/`statusInFlight` in `provisioner-server.mjs` become a `Map` keyed by workspace ID (they're bare variables today, correct only because there's exactly one workspace) — this unblocks both live per-container polling and multi-workspace without silent cache-thrash.
- Push over poll where it's cheap: the existing 2-3s dashboard polling stays for now, but the Details panel's live stats are a good first candidate for Server-Sent Events once the Map-based cache lands — one open connection instead of a poll loop per open panel.

### 3.2 Details panel (per-workspace, editable)

Everything incus-unraid's Details panel shows — image OS/release, storage pool, network bridge, effective CPU/memory limits with override badges, `/workspace` host path — plus editable limits and mount overrides, wired to the new mutating commands in §4. One thing incus-unraid doesn't have: a per-workspace **activity log** (start/stop/restart/limit-change/build-triggered events, timestamped, actor-attributed) — since incus-web already has structured, redacted operation logging in `contracts.ts`, surfacing it as a real audit trail in the UI is a small addition with outsized value for "wait, why did this container's limits change."

### 3.3 Builder (new)

Distro/release selects, package search-and-add, a post-install-command editor (with the provenance warnings from §5.3 when commands come from an import), a live build log (streamed via the offset-polling from §2.4), and the image registry (saved builds, master/variant badges, presets). This is where §2's design lands in the UI.

### 3.4 Config (new, read-first)

incus-unraid lets you edit every `incus.cfg` key from the UI. incus-web's config is spread across `.env`, `distrobuilder.yaml`, and `incus-web-profile.yaml` — a full editable-everything surface would mean the UI silently rewriting deploy-time YAML, which is a bigger and different problem than the rest of this plan. Ship the read side first — a clean view of access mode, network CIDR, resource profile, Tailscale status — and layer editability on per-field as each one has a real mutating command behind it (resource profile becomes editable the moment §4 ships, for instance). Better than incus-unraid's everything-at-once edit surface: never show an editable field that doesn't have a real, authorized command behind it.

### 3.5 Multi-workspace navigation

The data model (`WorkspaceInventory.workspaces[]`) already supports this — only the UI's `primaryWorkspace = inventory.workspaces[0]` assumption needs to go. Promote `WorkspaceCard` to an actual list+detail split. Every new workspace-scoped route must reuse the exact `getWorkspaceRefForActor` + ID-match pattern already correct in `apps/web/app/api/workspaces/[workspaceId]/actions/route.ts:40-42` — this is the one place a "just add a list endpoint" change could quietly become an IDOR, so it's called out explicitly here, not left as an implicit assumption.

---

## 4. Container configuration: full CRUD, real authorization

incus-unraid's `setJailLimits`/`setWorkspace`/`clearWorkspaceOverride` (`incus.service.ts:282-344`) prove the UX: editable CPU/memory limits with override badges, an editable `/workspace` mount path, one-click reset to profile default. We're building the same commands — `SetWorkspaceLimits`, `SetWorkspaceMount`, `ClearWorkspaceMount` — added to `contracts.ts` with the same typed-payload, `hasOnlyKeys`-validated discipline as the existing eight commands.

Two things incus-web gets that incus-unraid didn't design for:

**An explicit authorization tier.** Today, `getWorkspaceRefForActor` answers one question: "is this actor the owner of this workspace?" That's sufficient for start/stop, where the blast radius of getting it wrong is "someone restarts their own container." It's not sufficient for "can uncap CPU/memory" or "can mount an arbitrary host path into the container" — those need their own capability check (`actorCanMutateWorkspaceConfig`), composed with the existing owner check rather than reusing it silently. This is what makes multi-actor mode (`INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1`) safe to actually use once it exists: a shared/invited actor can be granted "start/stop my own workspace" without automatically getting "uncap resources or mount host paths."

**A concrete mount-path guard.** `fs.realpath`-canonicalize, reject anything that escapes a single allowlisted parent (`/var/lib/incus-web/workspaces/<id>/`), reject symlinks, validate on the provisioner side (the actual trust boundary — never trust client-side validation alone). incus-unraid's own path-traversal guard exists but the plan we're building from doesn't specify its exact restriction shape, so we specify our own instead of assuming parity is enough.

Incus's real gotcha, ported carefully: `limits.cpu`/`limits.memory` clear via omit-or-empty-string, but `disk` device overrides clear only via omitting the key entirely from a full-map PATCH (empty string does *not* clear a mount override — incus-unraid hit this as a production bug, changelog `2026.07.07n`). Both commands ship with a contract test asserting their clear semantics explicitly, in both directions, before any UI wires up to them — this is a cheap test that prevents a real, previously-observed bug class.

Env vars: still skipped — neither repo has a per-container env-var pattern worth porting; if a real need shows up, design it fresh.

---

## 5. Importers: devcontainer.json and .tool-versions/mise.toml

Both are pure-function ports from incus-unraid's `App.vue`, feeding directly into the Builder from §2 — no reason to gate them behind anything, they're the fastest-to-ship, lowest-risk part of this plan.

### 5.1 devcontainer.json

Port `inferDistroReleaseFromImage`, `mapFeatureToPrereqGroup`, `stripJsonComments`, and the field-mapping table verbatim into `apps/web/lib/import/devcontainer.ts`:

| field | mapping |
|---|---|
| `image` | pattern-matched to distro+release (alpine/fedora/rocky/alma/ubuntu/debian, `node:`/`python:` → debian) |
| `build.dockerfile` | skipped — surfaced as "pick a distro/release manually" |
| `features` | `/node`→nodejs group, `/python`→python3, `/git`→adds git, `/common-utils`→adds curl/sudo/ca-certificates, else skipped |
| `postCreateCommand`/`postStartCommand` | added as editable/removable post-install-command entries, never silently run |
| `remoteUser`/`containerUser` | skipped — incus-web uses one fixed agent user |
| `forwardPorts`/`mounts`/`workspaceFolder` | skipped — not applicable to image building |

Same "never silently drop a field" principle: every skip is surfaced in the UI with a reason. Feeds straight into the Builder's package/post-install-command state (§2, §3.3) — importing a `devcontainer.json` pre-fills a Builder session.

### 5.2 .tool-versions / mise.toml

Port `parseMiseToolsTable` and `parseToolVersionsFile` into `apps/web/lib/import/mise.ts`. incus-web gets a real advantage over incus-unraid here: **support both integration modes, not just one.**

- **Build-time** (matches incus-unraid): bake `mise` + pinned tools into the image via the Builder's post-install-command pipeline — `MISE_DATA_DIR=/opt/mise`, system-wide since the runtime user doesn't exist at build time, `mise use -g <tool>@<version> ...` to pin. Produces a self-contained image.
- **Runtime** (incus-web's existing path, extended): seed `/etc/mise/config.d/<workspace>.toml` with the imported tool pins for the existing `DOTFILES_RUN_MISE` → `mise install` step to pick up on first boot — no image rebuild needed, faster iteration.

Let the importer UI offer both as a choice at import time ("bake into a new image" vs. "apply to this workspace now") rather than picking one and locking incus-web out of the other's use case. Skip porting the dotfiles-bootstrap-via-mise sub-feature (incus-web's own chezmoi/dotfiles flow is already more developed) and skip re-evaluating `mise oci build` (incus-unraid already correctly rejected it — wrong image format for distrobuilder).

### 5.3 Import provenance

Both importers can surface commands the user didn't write themselves — a `postCreateCommand` from a cloned third-party repo, for instance. When the import source isn't the workspace owner's own project, flag any command containing a network fetch (`curl`, `wget`, `nc`) with a visible "from an external source — review before running" marker before it's editable/removable in the Builder UI. Cheap to add, closes a real gap incus-unraid's "never silently drop a field" design doesn't cover (it protects against *dropping* fields, not against *blindly trusting* the ones it keeps).

---

## 6. Tailscale autojoin

Already implemented, already better than incus-unraid's version:

- `scripts/incus-web-lib.sh:348-366` — transient secret-file push (`incus file push`, mode 600), never stored in any persistent config the way incus-unraid's GraphQL-stored `tsAuthKey` is.
- `scripts/incus-web-lib.sh:1655-1670` — `tailscale up` + `tailscale serve --https` to expose the terminal, then deletes the secret file.
- `distrobuilder.yaml:170-172` — Tailscale installed at build time but deliberately not joined; join always happens per-container at deploy, so cloned containers get their own node identity.

Two small follow-ups, not a rebuild:
1. Verify whether the network ACL (`ensure_agent_network()`, `scripts/incus-web-lib.sh:109-149`) needs incus-unraid's explicit CGNAT (`100.64.0.0/10`) carve-out — Tailscale tunnels over UDP/DERP rather than the container's default route, so this may be confirm-only.
2. Once §5's importers can inject post-install commands, confirm the secret-delete-after-join ordering happens *before* any imported command runs — otherwise the importer feature opens a credential-exfiltration window that doesn't exist today.

---

## 7. Build order

Not "cut vs. keep" — everything ships, sequenced so each phase produces something usable and nothing gets built on a foundation that isn't there yet.

**Phase 0 — Foundations (small, do first)**
- `statusCache`/`statusInFlight` → `Map` keyed by workspace ID (§3.1) — unblocks live polling and multi-workspace.
- Design `actorCanMutateWorkspaceConfig` (§4) — unblocks every mutating command after this point.
- Stand up the build-worker service skeleton (§2.3) — its own systemd unit, service account, and typed command channel, even before it does anything — unblocks the builder without retrofitting isolation later.

**Phase 1 — Fast wins**
- devcontainer.json importer + Builder pre-fill (§5.1).
- `.tool-versions`/mise.toml importer, both modes (§5.2).
- Tailscale follow-ups (§6).
- `SetWorkspaceLimits` (§4), gated on Phase 0's authorization design.

**Phase 2 — The builder comes online**
- Definition renderer (§2.2), distro/release enum starting with Debian/Ubuntu.
- `DispatchBuildImage`/`GetBuildStatus` async pair (§2.4), SQLite-backed build/log store.
- Minimal Builder tab UI (§3.3): distro/release picks, package add, post-install editor, live log.
- Wire the importers (§5) into the Builder as pre-fill sources.

**Phase 3 — Full dashboard**
- Details panel with editable limits/mounts (§3.2), `SetWorkspaceMount`/`ClearWorkspaceMount` (§4).
- Per-workspace activity log.
- Multi-workspace list+detail navigation (§3.5).
- Read-first Config tab (§3.4).

**Phase 4 — Polish and parity extras**
- Package search-across-managers + presets + image registry (`isMaster`/`basedOn`) in the Builder (§2.5).
- SSE for live Details-panel stats in place of polling.
- Persisted CPU/memory sparkline history (§3.1).
- Snapshot/backup UI — neither repo has this built; use the existing ZFS golden-container clone infrastructure (`scripts/build-agent-golden.sh`) as the storage-layer foundation, since it's already better positioned for this than anything in incus-unraid.
- Additional distro coverage in the Builder (Alpine, Rocky, Fedora) once Debian/Ubuntu are proven.

---

## 8. Other patterns worth carrying over

- **Every bare `incus` CLI invocation gets `</dev/null`** — some subcommands (confirmed: `profile create`) hang indefinitely waiting on stdin even non-interactively. Audit `scripts/incus-web-lib.sh` and `provisioner-server.mjs`'s `run()`/`spawn()` calls; the build worker's own `incus`/`distrobuilder` invocations need this from day one.
- **Preflight gating over fail-fast** — check glibc, cgroup v2, `newuidmap`/`newgidmap`, `nft`/`unsquashfs` *before* running anything, since their absence causes indefinite hangs, not clean errors, in `incusd`/`distrobuilder`. Directly relevant to the build worker, which invokes distrobuilder on the host rather than in CI's controlled environment.
- **Idempotent, `flock`-guarded provisioning** — every resource (pool/ACL/bridge/profile) existence-checked before creation, concurrent execution guarded. Confirm `ensure_agent_network()` and friends already do this; the build worker introduces more concurrent provisioning activity than exists today.
- **Bridge idempotency/repair** — distinguish "not managed by Incus" from "doesn't exist," tear down and recreate rather than failing on `network set`.
- **Security posture side-by-side diff** — incus-unraid's `security.privileged: "false"`, `security.idmap.isolated: "true"`, `disable_root: true`, `ssh_pwauth: false` defaults. Confirm `incus-web-profile.yaml`/`distrobuilder.yaml` match; this is the kind of default that silently drifts.
- **Nested Incus operation envelopes** (`response.metadata.metadata.<field>`) — incus-web mostly shells out to the CLI rather than hitting the REST API directly, so this may not apply; worth a quick audit of `provisioner-server.mjs:279-337` before assuming either repo's handling is right.
- **subuid/subgid bootstrap that doesn't clobber other tools** — relevant if the build-worker host also runs other rootless container tooling.
- **"jail" internally, "dev container" externally** — incus-unraid's deliberate internal/external naming split is a fine precedent if incus-web ever needs one; not directly actionable today.

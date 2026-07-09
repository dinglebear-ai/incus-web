---
date: 2026-07-09 10:36:24 EST
repo: git@github.com:jmagar/incus-web.git
branch: claude/vigorous-shaw-bbf113
head: a3fe175
working directory: /home/jmagar/workspace/incus-web/.claude/worktrees/vigorous-shaw-bbf113
worktree: /home/jmagar/workspace/incus-web/.claude/worktrees/vigorous-shaw-bbf113
pr: #23 "Add golden config export/import for workspaces", #24 "fix(deploy): install service-auth.mjs alongside the provisioner", #25 "fix(deploy): close stdin on bare incus invocations to prevent hangs" (all merged), https://github.com/jmagar/incus-web/pull/23, https://github.com/jmagar/incus-web/pull/24, https://github.com/jmagar/incus-web/pull/25
---

## User Request

Build a Rust CLI (later redirected to a Node script) to export a user's `~/.claude`/`~/.codex` config into a zip "golden config"; build the incus-web backend to import that zip into a workspace; build and wire up the frontend for it; then "stage commit and push everything and merge it into main and then switch to local main checkout and sync the latest and then redeploy or build or w/e." Later: investigate an `incus profile edit` hang encountered during redeploy, search the web for root cause, and update `PORTING_PLAN.md` to note the fix.

## Session Overview

Shipped a full-stack "golden config" import feature (export script + provisioner command + upload route + dashboard UI), merged it to `main` via PR #23, and redeployed it live on `dookie`. Redeployment surfaced two real, pre-existing infrastructure defects — a missing `service-auth.mjs` install step that crash-looped the provisioner, and a confirmed-upstream Incus stdin-hang bug affecting `deploy.sh` — both root-caused, fixed, and merged as PRs #24 and #25. `PORTING_PLAN.md` was updated to record the stdin fix and its root cause for future reference.

## Sequence of Events

1. Designed and built `scripts/export-onboarding.mjs`, a zero-dependency Node script bundling a user's `~/.claude`/`~/.codex` config surface into a zip, iterating three times on scope after live-testing against the real `~/.claude`/`~/.codex` on the host: first pass (5,806 files/72MB) included full marketplace/plugin git clones; second pass (952 files/15MB) dropped those as re-fetchable; third pass (721 files/7.4MB) dropped Codex's auto-generated `rollout_summaries` and built-in `.system` skill cache after user clarification via `AskUserQuestion`.
2. Researched the existing provisioner command architecture via a background `Explore` agent (`SetWorkspaceLimits` precedent: contract validation in `contracts.ts`, mirrored validation in `provisioner-server.mjs`, `MUTATING_COMMAND_TYPES` authorization gate, `incus file push`/`exec` mechanics) before designing the new `ImportGoldenConfig` command, resolving two real architecture questions via `AskUserQuestion` (stage-to-disk + lightweight command vs. base64-in-payload; push-zip-and-unzip vs. push-each-file).
3. Implemented `ImportGoldenConfig` end-to-end: contract type/payload/result/validators (`apps/web/lib/provisioner/contracts.ts`), host execution (`scripts/provisioner-server.mjs`: hash re-verification, `incus file push` + single `exec` script that unzips and `cp -a`-merges into the container user's `~/.claude`/`~/.codex`), a new upload route (`apps/web/app/api/workspaces/[workspaceId]/golden-config/route.ts`) with a byte-counting streaming reader and zip-magic validation, and `apps/web/lib/workspaces/golden-config.ts` for atomic staging + sha256. Added contract tests, a hermetic provisioner-server integration test suite, and route tests.
4. Researched dashboard/frontend conventions via a second background `Explore` agent, then built `apps/web/components/golden-config-import.tsx` (drag-and-drop zip upload, Aurora tokens, inline error/result display matching `workspace-actions.tsx`/`agent-run-dispatch.tsx` conventions) and wired it into `WorkspaceCard`. Replaced a pre-existing fibbing "MCP import — ready" feature tile that claimed a capability that didn't exist.
5. Verified locally: `tsc --noEmit`, `eslint .`, full `vitest run` (185/185), and a production `next build` — all clean.
6. Committed, pushed, opened PR #23, merged it (user-directed, no review requested), fast-forwarded the main checkout on `dookie` to the merge commit.
7. Attempted a full `./deploy.sh` re-run twice to pick up the new feature; both hung and were killed by `timeout 300` (exit 124) at the `ensure_incus_profile` → `incus profile edit` step, with no further output.
8. Worked around the hang: manually created the shared `/var/lib/incus-web/golden-config` staging directory (mode 2770, group `incus-web`), appended `INCUS_WEB_GOLDEN_CONFIG_DIR`/`INCUS_WEB_WORKSPACE_USER` to `/etc/incus-web/provisioner.env` and `/etc/incus-web/web.env`, and restarted both `incus-web-provisioner` and `incus-web-app` via `systemctl restart`.
9. `incus-web-provisioner` immediately crash-looped with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/usr/local/lib/incus-web/service-auth.mjs'`. Root-caused: `/usr/local/lib/incus-web/` only contained `provisioner-server.mjs` and `agent-runs.mjs` — `service-auth.mjs` (a relative import required by `provisioner-server.mjs`) had never been installed by either `deploy.sh`'s `install_host_provisioner_server` or `scripts/auto-redeploy-provisioner.sh`, a pre-existing gap in both install paths. Restored the running service immediately by copying the file in by hand, then fixed both scripts (added `install_host_provisioner_service_auth_module` to `incus-web-lib.sh`, a matching sync block to `auto-redeploy-provisioner.sh`), committed, pushed, opened and merged PR #24, and re-synced the main checkout.
10. User asked whether the `incus profile edit` hang would recur and to research it. Reproduced `incus profile edit` manually three times post-hoc — all succeeded in under 2 seconds, and `journalctl -u incus` showed no daemon-side errors, only client-disconnect warnings from the earlier `timeout`-killed attempts. Searched the web (`WebSearch`, then `gh issue view`) and found the confirmed upstream root cause: [lxc/incus#1467](https://github.com/lxc/incus/issues/1467), where maintainer `stgraber` explains that `create`/`edit`/`launch`-style `incus` subcommands read a full YAML object from stdin and block until EOF whenever stdin isn't explicitly closed, even when the command line already specifies everything. This matched an already-documented but never-fixed TODO in `PORTING_PLAN.md` §8 ("confirmed: `profile create`").
11. Fixed it: `incus_cmd()` in `scripts/incus-web-lib.sh` now redirects `</dev/null` by default; added a new `incus_cmd_stdin()` variant for the two call sites that legitimately feed real content (`network acl edit <<EOF`, `profile edit <file`), which would otherwise have their real input clobbered by `incus_cmd`'s new default. Confirmed `provisioner-server.mjs`'s and `bootstrap-server.mjs`'s own `spawn()`-based `run()` helpers were already correct (`stdio` defaults to `"ignore"` for stdin unless explicit `input` is passed) — no Node-side changes needed. Updated the one affected literal-string check in `tests/deploy_static_tests.sh`, updated `PORTING_PLAN.md` §8 to mark the item done with the confirmed root cause on record, committed, pushed, opened and merged PR #25, and re-synced the main checkout (no service restart needed — pure shell-script change).
12. User separately asked for a status update on the wider `incus-unraid` → `incus-web` porting effort; answered directly from `PORTING_PLAN.md` (Phase 0 and Phase 1's `SetWorkspaceLimits` done; devcontainer/mise importers, the image builder, `SetWorkspaceMount`/`ClearWorkspaceMount`, multi-workspace nav, and all of Phase 4 not started) without making any code changes for that turn.

## Key Findings

- `scripts/provisioner-server.mjs`'s command-channel body cap (`readJson`, ~1MB) is far too small for multi-MB zip uploads, and the socket-based command channel is shared by every provisioner command — ruled out raising the global cap or base64-in-payload in favor of staging the upload to a shared host directory and sending only a content hash.
- `~/.claude/plugins/marketplaces/` and `~/.codex/plugins/cache/` are full git clones of every installed marketplace/plugin repo (72MB → 15MB reduction when excluded) — re-fetchable from `known_marketplaces.json`/`installed_plugins.json` on the target, not part of the user's actual config.
- `deploy.sh`'s `configure_host_web_app` always calls `sudo systemctl restart incus-web-app` and reinstalls the systemd unit file on every run — necessary here because `INCUS_WEB_GOLDEN_CONFIG_DIR` is read from `process.env` at Node process startup, so hot-reload (`npm run dev` file-watching) alone would not have picked up the new env var.
- `deploy.sh`/`incus-web-lib.sh` already had a shared-group pattern (`INCUS_WEB_PROVISIONER_GROUP=incus-web`, with `incus-web-app` added as a supplementary member) used for provisioner-socket access — reused directly for the new golden-config staging directory rather than inventing a new mechanism.
- `/usr/local/lib/incus-web/` on `dookie` was missing `service-auth.mjs` before this session (directory mtime `Jul 9 02:18`, matching the last file sync by the `incus-web-auto-redeploy.timer`) — neither install path had ever copied it, a latent bug that only surfaces on a service restart, which is otherwise rare (the provisioner had been running continuously since `Jul 6 13:29` without needing one).
- `PORTING_PLAN.md:207` already flagged the Incus stdin-consumption bug class before this session, citing `profile create` as "confirmed" — this session found the actual upstream issue (`lxc/incus#1467`) and closed the TODO out.
- Two independent, plausible explanations exist for the specific hang observed: the confirmed stdin-consumption bug (doesn't fully explain it, since `profile edit`'s stdin was already explicitly redirected from a file), or Incus's own documented `profile edit` slowness under load (propagates changes to every instance using the profile) combined with genuine host contention at the time (a concurrent `cargo nextest run` and `next build` from unrelated worktrees were active) — the fix applied protects against the first regardless of which explains this incident.

## Technical Decisions

- **Stage-to-disk + hash-only command payload over base64-in-payload**: keeps the provisioner's small JSON command channel small and avoids doubling multi-MB buffers in memory during a request; costs a shared-directory permission setup but reuses an existing pattern.
- **Push zip + single `incus exec` unzip script over per-file `incus file push`**: one file transfer plus one exec call for a few-hundred-file archive, versus hundreds of separate process spawns; accepted `unzip` as an image dependency (already present per `distrobuilder.yaml`).
- **`cp -a` merge into `~/.claude`/`~/.codex` rather than wipe-and-replace**: preserves container-local state the export deliberately never captures (session sockets, caches), so re-importing an updated golden config doesn't destroy live state.
- **`incus_cmd_stdin()` as a separate function rather than a parameterized flag on `incus_cmd()`**: a bash function body's own redirect always overrides whatever the caller set up, so a single function with a "sometimes redirect, sometimes don't" flag would still need per-call-site changes to set that flag correctly — a second, clearly-named function is no more code and self-documents intent at each of the two real call sites.
- **Manual, targeted host redeploy over debugging/forcing the full `deploy.sh` run**: given `deploy.sh` hung twice at 300s with no clear root cause visible in real time, applied the exact subset of changes `deploy.sh` would have made (directory, env vars, service restarts) by hand rather than risk a longer blocking run against a host serving other live sessions.
- **Force-deleting `chore/ui-cleanup` and `feat/set-workspace-limits` local branches** (git maintenance, this write-up): both showed `[origin/...: gone]` and `git branch -d` refused them as "not fully merged" (expected for squash-merged branches, which break simple ancestor checks) — verified via `gh pr list --state merged --search "head:<branch>"` that PR #22 and PR #21 respectively were merged before using `-D`.

## Files Changed

| status | path | purpose | evidence |
|---|---|---|---|
| created | `scripts/export-onboarding.mjs` | Bundles `~/.claude`+`~/.codex` config into a zip, excluding fetchable/derived content | commit `279481b` |
| created | `apps/web/lib/workspaces/golden-config.ts` | Atomic staging + sha256 + zip-magic check for uploaded golden configs | commit `279481b` |
| created | `apps/web/app/api/workspaces/[workspaceId]/golden-config/route.ts` | Upload route: auth, streaming byte-limited read, stage, dispatch `ImportGoldenConfig` | commit `279481b` |
| created | `apps/web/app/api/workspaces/[workspaceId]/golden-config/route.test.ts` | Route tests (auth, content-type, size, success/failure mapping) | commit `279481b` |
| created | `apps/web/components/golden-config-import.tsx` | Dashboard drag-and-drop upload widget | commit `279481b` |
| created | `apps/web/components/golden-config-import.test.tsx` | Component tests for upload success/failure paths | commit `279481b` |
| modified | `apps/web/components/workspace-dashboard.tsx` | Wired in `GoldenConfigImport`; fixed placeholder "MCP import" tile; later merge-resolved against PR #22's dead-component cleanup | commits `279481b`, `8da7140` |
| modified | `apps/web/lib/provisioner/contracts.ts` | New `ImportGoldenConfig` command: payload/result types, validators, `golden_config_failed` error code | commit `279481b` |
| modified | `apps/web/lib/provisioner/contracts.test.ts` | Validation tests for the new command | commit `279481b` |
| modified | `apps/web/lib/workspaces/provisioner.test.ts` | Updated `MUTATING_COMMAND_TYPES` pinning test for the new command | commit `279481b` |
| created | `apps/web/lib/provisioner/provisioner-server-golden-config.test.ts` | Hermetic provisioner-server integration tests (invalid payload, missing/mismatched staged file, real-incus-call-attempted) | commit `279481b` |
| modified | `scripts/provisioner-server.mjs` | `importGoldenConfig()` host execution: hash re-verification, push, unzip/merge/chown exec script, manifest-based result | commits `279481b`, `bc4b451` (unrelated: service-auth install) |
| modified | `docs/contracts/provisioner-boundary-v1.md` | New `### ImportGoldenConfig` section | commit `279481b` |
| modified | `openwiki/domain/provisioner-contract.md` | New `### ImportGoldenConfig` section + `golden_config_failed` error code | commit `279481b` |
| modified | `deploy.sh` | `INCUS_WEB_GOLDEN_CONFIG_DIR` var; later `service-auth.mjs` install vars | commits `279481b`, `bc4b451` |
| modified | `scripts/incus-web-lib.sh` | Golden-config staging dir + env plumbing; `service-auth.mjs` install function; `incus_cmd`/`incus_cmd_stdin` stdin fix | commits `279481b`, `bc4b451`, `a3fe175` |
| modified | `scripts/auto-redeploy-provisioner.sh` | Sync `service-auth.mjs` alongside the other two provisioner modules | commit `bc4b451` |
| modified | `PORTING_PLAN.md` | §8 marked done with confirmed root cause (`lxc/incus#1467`) | commit `a3fe175` |
| modified | `tests/deploy_static_tests.sh` | Updated literal-string check for `incus_cmd_stdin` rename | commit `a3fe175` |
| deleted (local branch) | `chore/ui-cleanup` | Stale, confirmed merged via PR #22 | this write-up |
| deleted (local branch) | `feat/set-workspace-limits` | Stale, confirmed merged via PR #21 | this write-up |
| created | `docs/sessions/2026-07-09-golden-config-import-and-deploy-hardening.md` | This session log | this commit |

Note: the diff between `279481b` and `bc4b451`/`a3fe175` also shows unrelated churn (deletions of `apps/web/components/aurora/*` files, `docs/sessions/2026-07-09-ui-cleanup.md`) — this is PR #22 ("remove dead Aurora component library") landing on `main` concurrently and being picked up by the `git merge origin/main` in step 6/commit `8da7140`, not something this session authored.

## Beads Activity

No bead activity observed. Consistent with this repo's established convention (see `docs/sessions/2026-07-08-phase0-mutation-gate-and-porting-plan.md`): `PORTING_PLAN.md`-driven work is tracked via the plan file and session docs, not `bd`. Checked `bd list --status=in_progress`: two pre-existing in-progress issues (`incus-web-ks1` "Make Next.js workspace dashboard the primary web experience", `incus-web-evf` "Add Incus runtime/profile parity smoke checks") exist but neither was touched this session — `incus-web-evf`'s acceptance criteria (smoke coverage for profile/image/deploy parity) is adjacent to but distinct from the stdin-hang fix and was not updated.

## Repository Maintenance

- **Plans**: `docs/plans/` does not exist in this repo (confirmed via `ls`); no plan file was used or created for this session's work (ad hoc, not `/writing-plans`-driven). Not applicable.
- **Beads**: See Beads Activity above — none created, edited, or closed; none warranted by this session's changes.
- **Worktrees**: `git worktree list --porcelain` shows only the primary `main` worktree and this session's `vigorous-shaw-bbf113` worktree — no stale worktrees found.
- **Branches**: Deleted two confirmed-merged local branches (`chore/ui-cleanup`, `feat/set-workspace-limits`) after verifying via `gh pr list --state merged --search "head:<branch>"` (PR #22 and #21 respectively) that `git branch -d`'s "not fully merged" refusal was a squash-merge artifact, not a real risk, before using `-D`. Left `origin/claude/agitated-bhabha-62e95f` (an unrelated remote branch, not investigated) alone. Did not delete the active `claude/vigorous-shaw-bbf113` branch (currently checked out in this worktree).
- **Stale docs**: Checked for other references to the pre-existing fake "MCP import" dashboard tile and to "golden-config" outside this session's own edits (`grep -rln` across `openwiki/`, `README.md`, `docs/`) — found none needing updates beyond what was already committed in `279481b`/`a3fe175`. `openwiki/` is otherwise auto-generated by a GitHub Action (`openwiki-update.yml`) and was not hand-edited beyond the one contract-doc section explicitly warranted.

## Tools and Skills Used

- **Shell (`Bash`)**: git operations, `gh` CLI (PR create/merge/view/issue view), `npm`/`npx` (install, `tsc`, `eslint`, `vitest`, `next build`), live host inspection and remediation on `dookie` (`systemctl`, `sudo install`, `journalctl`, direct `incus` CLI calls), file staging and env-file edits. No failures beyond the two hangs investigated as the session's actual subject matter.
- **`Read`/`Edit`/`Write`**: all source, test, doc, and shell-script changes.
- **`Agent` (background, `Explore`-style research)**: two dispatches — provisioner command architecture research (before designing `ImportGoldenConfig`) and dashboard/frontend convention research (before building `golden-config-import.tsx`). Both returned useful, actionable findings with file:line references; no failures or retries.
- **`AskUserQuestion`**: four uses — export scope precision (plugin-installed skills/agents; Codex `rollout_summaries`/`.system`), zip-transfer architecture (stage-to-disk vs. base64), extraction method (push-zip-and-unzip vs. per-file push). All resolved cleanly on first ask.
- **`WebSearch`**: two queries researching the `incus profile edit`/`profile create` stdin-hang bug class; both returned directly relevant results (Incus forum thread, GitHub issue search).
- **`WebFetch`**: fetched the Incus forum thread and (initially) the GitHub issue page for a summary; the GitHub issue was then re-fetched via `gh issue view --json` for authoritative comment text, since `WebFetch`'s AI-summarized version was serviceable but the raw maintainer quote was worth pulling exactly.
- **`ScheduleWakeup`**: attempted once, rejected by the tool (missing required `prompt` param for the `-dynamic` sentinel in a non-`/loop` context) — abandoned in favor of simply waiting for the automatic background-task notification, which is the correct mechanism per the tool's own guidance.
- **`Skill` (`save-to-md`)**: this document.

## Commands Executed

| command | result |
|---|---|
| `node scripts/export-onboarding.mjs --out ./test-export.zip` (iterated 3x with scope changes) | 5,806→952→721 files, 72MB→15MB→7.4MB |
| `npx tsc --noEmit -p tsconfig.json` | clean, no output, each verification pass |
| `npx eslint .` | 0 errors (pre-existing unrelated warnings only) |
| `npx vitest run` | 183/183 → 185/185 passing across verification passes |
| `npx next build` | succeeded, new route registered, each time |
| `gh pr create` / `gh pr merge --merge` ×3 | PRs #23, #24, #25 all merged |
| `git fetch origin main && git merge --ff-only origin/main` (main checkout, ×3) | fast-forwarded each time |
| `timeout 300 ./deploy.sh` ×2 (backgrounded) | both exit 124 (killed), hung at `ensure_incus_profile` |
| `sudo install -d -m 2770 -o incus-web-provisioner -g incus-web /var/lib/incus-web/golden-config` | directory created with correct perms |
| `sudo systemctl restart incus-web-provisioner` (first attempt) | crash-looped, `ERR_MODULE_NOT_FOUND: service-auth.mjs` |
| `sudo install -m 644 scripts/service-auth.mjs /usr/local/lib/incus-web/service-auth.mjs` + restart | stable, `NRestarts=0` |
| `sudo systemctl restart incus-web-app` | stable, `/healthz` → `204` |
| `for i in 1 2 3; do time timeout 10 incus profile edit incus-web-agent < incus-web-profile.yaml; done` | all three: 0.5–1.6s, exit 0 |
| `gh issue view 1467 --repo lxc/incus --json title,body,state,comments,closedAt` | confirmed maintainer root-cause explanation |
| `bash tests/deploy_static_tests.sh` | pass, each verification pass |
| `git branch -D chore/ui-cleanup feat/set-workspace-limits` | deleted, after confirming via `gh pr list --state merged --search "head:<branch>"` |

## Errors Encountered

- **`incus profile edit` hang during `deploy.sh`**: two `timeout 300 ./deploy.sh` runs both killed at exit 124, hanging at `ensure_incus_profile`. Root cause not fully pinned (see Key Findings) — either the confirmed upstream Incus stdin-consumption bug ([lxc/incus#1467](https://github.com/lxc/incus/issues/1467)) or Incus's documented `profile edit` slowness under concurrent-instance/host load; the applied fix protects against the former regardless. Resolved by working around it for this deploy (manual redeploy steps) and later hardening `incus_cmd()` against the bug class.
- **`incus-web-provisioner` crash loop after restart**: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/usr/local/lib/incus-web/service-auth.mjs'`. Root cause: neither `deploy.sh`'s `install_host_provisioner_server` nor `scripts/auto-redeploy-provisioner.sh` had ever installed that file — a pre-existing gap that only manifests on a service restart against a wiped/incomplete install directory. Fixed in PR #24.
- **Running `scripts/auto-redeploy-provisioner.sh` via `sudo bash ...`**: failed with `git@github.com: Permission denied (publickey)` because `sudo` changes the effective user/HOME/SSH-agent context away from the systemd timer's actual `User=jmagar` execution context. Not a real bug in the script; worked around by performing the file sync manually instead of through the script.
- **`gh pr merge 23/24/25 --merge` initially reported "not mergeable" for PR #23**: caused by `main` having advanced (PR #22 merged concurrently) since the branch was created. Resolved with `git fetch origin main && git merge origin/main`, resolving one real conflict in `apps/web/components/workspace-dashboard.tsx` (PR #22 had already removed the placeholder "MCP import"/"Secrets" feature tiles this session had also edited independently), then completing the merge commit and re-pushing.

## Behavior Changes (Before/After)

| area | before | after |
|---|---|---|
| Workspace dashboard | No way to seed a workspace's `~/.claude`/`~/.codex` from an existing setup; a "MCP import — ready" feature tile falsely claimed this capability existed | Real drag-and-drop golden-config zip import, wired to a full provisioner command |
| `incus-web-provisioner` on a fresh/restarted install | Crash-loops with `ERR_MODULE_NOT_FOUND` if `service-auth.mjs` is missing (as it was on `dookie`) | Both deploy paths install all three required modules |
| `scripts/incus-web-lib.sh`'s `incus_cmd()` | Bare `incus` invocations inherit whatever stdin the parent process has, vulnerable to the confirmed upstream stdin-consumption hang | Defaults to `</dev/null`; the two legitimate stdin-consumers use a separate `incus_cmd_stdin()` |

## Verification Evidence

| command | expected | actual | status |
|---|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | no errors | no output | pass |
| `npx eslint .` | 0 errors | 0 errors, pre-existing warnings only | pass |
| `npx vitest run` | all tests pass | 185/185 passing | pass |
| `npx next build` | succeeds, route registered | succeeded, `/api/workspaces/[workspaceId]/golden-config` listed | pass |
| `bash tests/deploy_static_tests.sh` | passes after `incus_cmd_stdin` rename | "deploy validation checks are wired", exit 0 | pass |
| `bash -n` on all touched shell scripts | valid syntax | no errors | pass |
| `systemctl show incus-web-app incus-web-provisioner --property=ActiveState,SubState,NRestarts` | both active/running, 0 restarts post-fix | confirmed | pass |
| `curl .../healthz` | `204` | `204` | pass |
| `incus_cmd profile show` / `incus_cmd_stdin profile edit <file` (manual, post-fix) | both complete without hanging | both `exit=0`, fast | pass |

## Risks and Rollback

- All three PRs (#23, #24, #25) are already merged and live on `main` and on `dookie`. Rollback would mean reverting the merge commits and re-running the equivalent of the manual redeploy steps in reverse (remove the staging directory/env vars, revert `service-auth.mjs`/`incus_cmd` changes) — not expected to be needed; all verification passed.
- The `incus profile edit` hang's true root cause is not 100% pinned (two plausible explanations, evidence for both). If `deploy.sh` hangs again at the same step under similar conditions, check host load (`top`/`uptime`) before assuming the stdin fix was insufficient — it protects against one confirmed bug class, not necessarily the specific incident observed.

## Decisions Not Taken

- **Raising the provisioner command channel's 1MB body cap / base64-in-payload for the golden-config zip**: rejected in favor of stage-to-disk + hash-only payload, to avoid widening the attack/complexity surface of the shared command channel for one large-payload use case.
- **Forcing `</dev/null` unconditionally inside a single `incus_cmd()` regardless of caller redirects**: would have silently broken the two legitimate stdin-consuming call sites, since a function body's own redirect always overrides an inherited one; used a second named function instead.
- **Deep daemon-side tracing of the `incus profile edit` hang** (e.g., goroutine dumps): not pursued, since the issue was non-reproducing on manual retest and the maintainer-confirmed upstream fix is cheap, protective, and already recommended by `PORTING_PLAN.md`.

## References

- [lxc/incus#1467 — "incus storage create hangs in script"](https://github.com/lxc/incus/issues/1467) — confirmed upstream root cause for the stdin-consumption bug class.
- [Incus forum — "incus profile edit is noticeably slow"](https://discuss.linuxcontainers.org/t/incus-profile-edit-is-noticeably-slow/23010) — alternative/complementary explanation for `profile edit` specifically.
- `PORTING_PLAN.md` §8 — pre-existing TODO this session closed out.
- PR [#23](https://github.com/jmagar/incus-web/pull/23), [#24](https://github.com/jmagar/incus-web/pull/24), [#25](https://github.com/jmagar/incus-web/pull/25).

## Open Questions

- Whether the specific `incus profile edit` hang observed this session was actually the stdin-consumption bug (unlikely, given the explicit file redirect already present) or Incus's documented per-instance propagation slowness under host contention — not resolvable without daemon-side tracing during a live recurrence.

## Next Steps

- No unfinished work from this session; golden-config import is live and verified end-to-end on `dookie`, and both deploy-tooling fixes are merged and verified.
- Per the user's separate status-check this session: the wider `incus-unraid` → `incus-web` porting effort (`PORTING_PLAN.md`) remains mostly undone — Phase 1's devcontainer.json/mise importers and Tailscale follow-ups, all of Phase 2 (image builder), Phase 3 (editable Details panel, `SetWorkspaceMount`/`ClearWorkspaceMount`, multi-workspace nav, Config tab), and Phase 4 are not started. Recommended entry point if resumed: Phase 1's remaining importers (lowest risk, no new authorization surface) or Phase 3's `SetWorkspaceMount`/`ClearWorkspaceMount` (natural continuation of this session's `SetWorkspaceLimits`/`ImportGoldenConfig` mutating-command pattern).
- The future build-worker service (`PORTING_PLAN.md` §2.3, not yet built) will need the same `</dev/null` treatment for its own `incus`/`distrobuilder` invocations from day one — noted in the plan, not yet actionable since the service doesn't exist.

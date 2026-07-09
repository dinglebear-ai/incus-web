# UI/UX revamp plan

Date: 2026-07-09

## Goal

Make incus-web feel like a real operator console for browser-accessible Incus workspaces: clear first action, visible system state, guided workspace lifecycle, first-class agent dispatch, and clean Aurora-native composition.

The redesign must use Aurora tokens and Aurora components throughout. Raw controls, one-off pills, hand-styled buttons, and local chrome should be replaced with registry primitives or identified as upstream Aurora gaps.

The redesign must also be space-disciplined. No component gets area merely to contain explanatory text. Screen real estate is allocated by usefulness: frequent actions, current state, and decision-making information stay visible; rare controls collapse into drawers, popovers, menus, or secondary tabs.

This epic must not recreate the deleted Aurora component-library bloat. Use Aurora primitives already present in `apps/web/components/ui/aurora` first. If a desired Aurora block is missing, choose one explicitly before coding: defer it, sync the upstream registry component intentionally, or use a small existing primitive composition. Do not rebuild large local `PromptInput`, `Terminal`, `CodeBlock`, `FilePicker`, `CommandPalette`, or workspace-block clones inside this revamp.

## Current audit

Screenshots captured from the authenticated dev dashboard:

- Desktop: `.codex-ui-audit/desktop.png`
- Mobile: `.codex-ui-audit/mobile.png`

Observed route: `/`

Current strengths:

- Core functionality exists: workspace status, terminal link, telemetry, setup state, golden config import, agent runs, builder, config, limits, mounts, snapshots, and activity.
- Aurora token layer and many vendored Aurora primitives are already present.
- The system has useful domain concepts: workspace lifecycle, terminal readiness, setup completion, golden config, agent runs, builder images, and snapshots.

Current issues:

- The page does not express a workflow. Terminal, telemetry, setup, config import, agent dispatch, limits, snapshots, and activity are stacked as peer sections.
- The primary job of the product is unclear. Opening the workspace terminal should read as the first-class path, with agent dispatch and workspace health as adjacent jobs.
- The right inspector mixes read-only metadata with destructive/mutating configuration. This makes the panel feel like a miscellaneous drawer instead of a reliable inspector.
- Mobile spends its first viewport on repeated shell chrome, workspace selector, tabs, and lifecycle buttons. The useful work starts too low.
- Several controls bypass Aurora components: raw `select`, label-styled upload buttons, local list buttons, ad hoc cards, custom selected list items, and dismissal controls.
- The current radius/shadow language is inconsistent with Aurora recipes. Many panels force `rounded-[4px]` and suppress elevation, so the page loses Aurora's tiered depth system.
- Error/status messages are inline text where `Banner`, `Callout`, `Toast`, or `EmptyState` would communicate state more clearly.
- The builder is a dense form, not a guided image-building flow.
- Agent runs use form fields where Aurora's AI prompt pattern would better fit the mental model: choose agent, choose repo/context, give task, dispatch, watch queue.
- Too much vertical space is spent on passive cards whose only job is to hold copy. These should be removed, collapsed, or converted into useful controls/status rows.
- Important actions can fall below the fold on both desktop and mobile. A user should not have to scroll to open the terminal, inspect workspace health, dispatch an agent, or understand a blocking failure on the active screen.

## Engineering review summary

The plan was reviewed as a pretend epic bead by architecture, simplicity, security, and performance reviewers.

Key findings applied:

- Keep the revamp page-local. Do not build a generic dashboard shell/layout framework.
- Make inspector observation-only. Mutations belong in Settings or explicit task-surface dialogs.
- Preserve server/client boundaries, trusted proxy identity, mutable authorization checks, and hydration-safe browser API usage.
- Add explicit redaction, authorization, polling, log, and bundle constraints before implementation.
- Avoid resurrecting deleted Aurora feature blocks or broad component imports.
- Keep Agents and Builder simpler than the original plan: dense panels with existing primitives, not stepper/table/prompt-terminal rebuilds unless existing data proves they are needed.

## Data and mutation architecture

The implementation should keep state scoped by surface instead of creating one monolithic cockpit component.

Surface boundaries:

- `Overview`: reads workspace status, telemetry, terminal readiness, setup readiness, and dotfiles state. It may trigger lifecycle actions only through existing authorized workspace action routes.
- `Agents`: owns agent selection, repo/ref/task inputs, dispatch, bounded run queue, and selected-run summary. It must not mount or poll when the Agents tab is inactive.
- `Builder`: owns image definition inputs, package/import state, build dispatch, and bounded build-log polling. It must clean up timers and abort in-flight requests on unmount or tab switch.
- `Settings`: owns limits, mount, snapshots, and other configuration mutations. Each mutation keeps its own pending/error state.
- `Inspector`: read-only. It renders dense metadata, recent activity summary, setup/route facts, and snapshot summaries. It must not contain mount, limit, snapshot-create, golden-import, lifecycle, build, or agent-dispatch mutations.

Implementation constraints:

- Keep view-model helpers in the UI/app layer. Domain contracts remain in `lib`.
- Avoid shared mutable dashboard state imported by every tab.
- Hidden tabs must not keep polling, appending logs, or rendering large histories.
- Persisted UI preferences, selected tabs, dismissed notices, media-query behavior, and timestamps must be post-mount safe. Do not read browser APIs during server render or hydration-sensitive initializers.

## Security invariants

The UI revamp must preserve server-side trust boundaries. Styling or moving controls must never change authorization.

Authorization matrix:

| Surface/action | Required server-side guard |
|---|---|
| Non-health app/API routes | `getActorFromHeaders` or existing trusted identity path |
| Workspace read/status/activity/snapshots | Workspace owner/access check for the current actor |
| Lifecycle actions | Existing workspace action route authorization |
| Agent dispatch/run reads | Existing workspace access plus workspace tuple validation |
| Limits, mount, golden config import, image master/config mutations | Mutable workspace authorization, not just authenticated access |
| Snapshot creation/deletion/restoration | Mutable workspace authorization |
| Build dispatch | Actor-scoped build worker request |
| Build status/logs/images/presets | Owner-filtered server-side; never rely on UI hiding alone |

Redaction contract:

- No new UI surface may render raw provisioner/build-worker operation payloads.
- UI-facing logs/errors must be bounded and redacted server-side before display.
- Do not expose tokens, auth headers, age keys, environment files, raw stderr that may contain secrets, controller/app-server URLs, or imported executable commands unless explicitly classified safe.
- Tables/timelines should consume safe summary DTOs, not raw command output.
- Imported devcontainer/mise/tool-version commands require an explicit review step before dispatching a build.

Action-risk rules:

- Icon-only buttons are fine for low-risk navigation, refresh, inspect, copy, reveal, collapse, and filter actions.
- Destructive, disruptive, costly, or privilege-sensitive actions must keep visible text, clear tone, disabled/pending states, and confirmation where appropriate.
- Stop, restart, reset mount, import golden config, build image, dispatch agent, set image master, and snapshot mutation are not icon-only primary controls.
- Tooltips never replace visible copy or confirmation for dangerous actions, especially on touch devices.

## Performance contract

The revamp must preserve and extend the current polling guardrails.

Polling:

- Only the active visible surface may poll.
- Poll loops must avoid overlap.
- Polling pauses when `document.visibilityState` is hidden where practical.
- All intervals/timeouts are cleared on unmount or tab switch.
- Fetches use `AbortController` where practical.
- Repeated failures back off instead of hammering APIs.
- Do not use `router.refresh()` for high-frequency telemetry, run-log, or build-log updates.
- The workspace rail must use inventory/batched status data, not one status request per workspace row.

Logs and histories:

- Builder logs use cursor/offset polling, bounded client state, fixed-height internal scroll, and cleanup on unmount.
- Agent logs render a bounded tail window in the dashboard.
- Full logs move to a fixed-height internal panel/route and use pagination or virtualization above a defined threshold, for example 500 rows.
- Test with synthetic long logs, at least 5k lines, and verify no page scroll jank at `1440x900` and `390x844`.

Bundle:

- Overview first load must not include Builder, full session viewer, DataTable-heavy inventories, Aurora AI blocks, or large rarely used surfaces.
- Use `next/dynamic` or equivalent lazy loading for Agents, Builder, Settings, and full log/session surfaces where feasible.
- Do not barrel-import broad Aurora modules into the dashboard route.
- Run a bundle check such as `ANALYZE=true npm --prefix apps/web run build` when supported, or document the closest available build-size evidence.
- Meaningful dashboard first-load regression from the post-`ce5d7f2` baseline needs explicit justification.

## Product flow

The redesigned page should support four explicit jobs:

1. Get into a workspace.
   - See whether the workspace is ready.
   - Open the browser terminal.
   - Understand setup, dotfiles, and route status.

2. Run an agent against the workspace.
   - Choose Codex or Claude.
   - Provide repository/ref and task.
   - Dispatch and monitor queue/session status.

3. Maintain the workspace.
   - View live health and recent activity.
   - Adjust resource limits and mounts intentionally.
   - Create snapshots.

4. Build or import workspace images.
   - Start from distro/release/preset.
   - Add packages and commands.
   - Import devcontainer/mise/tool-versions.
   - Dispatch build and read logs.

Space priority:

1. Primary action for the current screen.
2. Current state that changes what the user should do next.
3. Inputs required to complete the current job.
4. Secondary actions and history.
5. Documentation, explanatory copy, and rarely used metadata.

Anything in priority 5 must be inline, collapsible, or moved out of the working viewport.

## Proposed information architecture

Use one page-local app shell with a workspace rail and a task-oriented main area. Do not create a reusable shell framework unless implementation proves repeated structure outside this page.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Compact top bar: incus-web / active workspace / health / user / actions     │
├───────────────┬─────────────────────────────────────────────┬───────────────┤
│ Workspace rail│ Main task surface                            │ Inspector     │
│ - workspace   │ Overview / Agents / Builder / Settings       │ Contextual    │
│ - state       │                                             │ details       │
│ - terminal    │                                             │ read-only     │
└───────────────┴─────────────────────────────────────────────┴───────────────┘
```

Mobile:

```text
┌────────────────────────────┐
│ Workspace status + terminal│
│ Compact task switcher      │
│ Active task content        │
│ Read-only inspector drawer │
└────────────────────────────┘
```

## Screen design

### Shell

- Root remains `aurora-page-shell`.
- Left workspace rail uses `aurora-nav-shell` and Aurora selected-item behavior: border plus `--aurora-active-glow`, not filled tabs.
- Top bar uses the Aurora Tier 1 toolbar recipe: `--aurora-panel-medium`, `--aurora-border-default`, `--aurora-shadow-medium`, inset highlight.
- Main task panels use Tier 2 inspector/panel recipe: `--aurora-panel-strong`, `--aurora-border-strong`, `--aurora-shadow-strong`, `--aurora-radius-3`.
- Replace local icon chips and workspace buttons with `Button`, `Badge`, `StatusIndicator`, `Item`, and `Tooltip` where appropriate. `CommandPalette` is out of scope for this epic.
- Buttons are icon-only by default for low-risk actions. Text labels are reserved for high-commitment actions, destructive/disruptive operations, empty-state primary actions, and forms where ambiguity would slow the user down. Every icon-only action needs an accessible label and a `Tooltip`.
- Avoid card grids for isolated facts. Prefer status rows, compact toolbar clusters, split panes, tables, or inline metadata.
- The page should behave like a cockpit, not a brochure: compact controls, clear affordances, no marketing copy, no spacer cards.
- Mobile must not spend the first viewport on duplicated workspace selection, global toolbar, and tabs. It starts with active workspace status, readiness, and the primary action.

### Overview tab

Purpose: answer "Can I work in this workspace right now?"

Above the fold:

- Active workspace header: name, `Badge` state, project/container path in `.aurora-text-code`.
- Primary CTA: terminal action with a prominent icon button. Use a visible text label only when the terminal is the single largest action in the active surface.
- Secondary lifecycle actions: restart/stop/start grouped with `ToolbarGroup`; destructive/stop uses warn/destructive treatment, visible text, and confirmation where disruptive.
- Readiness strip with three compact `StatusIndicator` items:
  - Terminal route
  - Setup
  - Dotfiles

Main body:

- Health panel with CPU, memory, and storage using `StatCard`, `Progress`, and compact chart treatments.
- Setup panel only appears when incomplete or failed. Complete setup becomes a compact status row, not a persistent card.
- Golden config import appears only when it is actionable or recently changed. Otherwise it collapses into a small "onboarding" action in Settings or the active toolbar. Import requires mutable authorization and safe result messaging.

Inspector:

- Read-only workspace metadata in `DescriptionList`.
- Activity in `Timeline`, not freeform bordered rows.
- Snapshots summarized, with create action moved to maintenance/settings unless urgent.
- Metadata should be dense and scannable. Do not give one row the height of a card unless the row includes controls or live status.
- Inspector is observational only. No lifecycle, limits, mount, golden import, snapshot mutation, agent dispatch, or build controls.

### Agents tab

Purpose: dispatch and monitor AI work.

Layout:

- A Tier 2 "New agent run" panel.
- Agent selector via `Tabs`, `Segmented`, or `Select`, not a plain stacked form.
- Use existing local Aurora primitives for task text. Do not sync or rebuild `PromptInput` in this epic unless a separate dependency decision is made.
- Repo URL/ref fields use `Field`, `Input`, and `InputGroup`.
- Dispatch button uses `Button variant="rose"` with visible text and pending/disabled state.
- Queue uses a compact `Item` list with `Badge` status and `EmptyState` for no runs. Defer `DataTable`/rich timelines unless record count and behavior justify them.
- Errors use `Banner tone="error"` with matter-of-fact copy.
- Agent dispatch should fit in the first viewport on desktop: agent selector, repo/ref, task composer, dispatch, and queue summary must all be visible without scrolling.
- Empty queue should be a compact inline empty state, not a large card.
- Run history is bounded and selected-run details lazy-load. Long logs are redacted, bounded, and internally scrollable.

### Builder tab

Purpose: create a reusable workspace image without reading a dense form.

Flow:

- Keep Builder as one dense panel with internal sections rather than a stepper unless user testing proves grouped controls are still confusing:
  - Base image: distro, release, preset.
  - Tooling: packages, devcontainer import, mise/tool-versions import.
  - Commands: post-install commands with explicit imported-command review.
  - Build: alias, dispatch, logs.
- Use `NativeSelect`/`Select`, `Field`, `TagInput` or `Badge` chips for packages, `Textarea` for commands, `ButtonGroup` for import actions.
- Package search results use `SearchResults` or `Item`, not raw bordered buttons.
- Images/presets use compact lists first. Use `DataTable` only when record count justifies sorting/filtering.
- Build logs use existing compact code/log styling. Do not sync/rebuild `Terminal` or `CodeBlock` in this epic unless separately approved.
- Builder can scroll internally if logs are long, but the page should not push build controls out of sight. Long logs live in a fixed-height terminal region.
- Build polling must be cancellable and clean up after tab switch/unmount.

### Settings tab

Purpose: deliberate workspace maintenance.

Sections:

- Resource limits: `Field`, `NumberInput` or `Input`, and a single `Save limits` action.
- Mount: `Field`, `InputGroup`, `Save mount`, `Reset`.
- Snapshots: create snapshot form plus `Timeline`/`DataTable` of snapshots.
- Sharing/ownership: read-only for now, with `Callout` explaining private workspace state.

Settings should not compete with "Open terminal" or "Dispatch agent" on the overview.

Settings is allowed to be denser than overview. It is a maintenance screen, so compact form rows and tables are preferred over explanatory panels.

Each Settings mutation has separate pending/error state. A failed mount update must never be obscured by a stale success message from limits or snapshots.

## Aurora component replacement checklist

- Replace raw tab buttons with `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent`.
- Replace workspace rail buttons with `Item`/`Button` using selected border plus glow.
- Replace raw `select` elements with `NativeSelect` or `Select`.
- Replace label-styled file upload controls with Aurora `Button asChild` plus file input. Do not sync or rebuild `FilePicker` in this epic.
- Replace inline error paragraphs with `Banner`/`Callout`.
- Replace ad hoc package chips with `Badge`/`TagInput`.
- Replace ad hoc activity and snapshot rows with `Timeline`, `Item`, or `DataTable`.
- Replace build log `<pre>` with compact Aurora-tokenized log chrome using existing primitives. Do not sync or rebuild `Terminal`/`CodeBlock` in this epic.
- Replace local metric boxes with `StatCard`, `Progress`, and chart primitives.
- Keep icons from `lucide-react`, 14-18px, 1.5-1.75 stroke.
- Use `.aurora-text-*` classes for all type and restrict mono to IDs, paths, code, and logs.
- Remove forced `rounded-[4px]` panel styling except table wrappers or canonical badge chips.
- Wrap icon-only buttons in `Tooltip`; use `aria-label` for every icon-only control.
- Delete passive cards that only restate static text. If the information matters, make it a status row, tooltip, inline note, or callout tied to an action.
- Do not sync/rebuild missing Aurora feature blocks as part of this epic. Use existing primitives or defer.
- Do not use `CommandPalette` in this epic.

## Visual direction

Subject: an operator console for disposable, browser-native Incus workspaces.

Audience: a developer/operator who wants to get into a container quickly, dispatch agents, and maintain the environment without reading deployment internals.

Single job of the first screen: show whether the active workspace is ready and provide the shortest path to work.

Design signature: "workspace flight deck" without decorative imagery. The memorable element is a compact readiness runway across the top of the active workspace: terminal, setup, dotfiles, route, and agent queue as status stops with cyan/rose/violet accents. It encodes real state and guides the user from readiness to action. This is the one expressive element; everything else is dense, clean, and earned.

Palette and type come from Aurora only:

- Page/nav/panel/control surfaces via `--aurora-page-bg`, `--aurora-nav-bg`, `--aurora-panel-medium`, `--aurora-panel-strong`, `--aurora-control-surface`.
- Cyan for primary workspace actions and selection.
- Rose for agent dispatch/import affordances.
- Violet only for AI/autonomous identity if the local token exists; otherwise add/sync from Aurora before use.
- Status tokens for health, setup, and failures.
- Manrope for product/page titles, Inter for UI, JetBrains Mono only for IDs/paths/logs.

## Implementation phases

### Phase 1: Overview shell, readiness, and inspector

- Convert dashboard tab state to Aurora `Tabs`.
- Build a true workspace rail with selected glow state.
- Rework header into a compact Tier 1 toolbar.
- Move primary workspace readiness and terminal CTA above telemetry.
- Move read-only metadata/activity to an observation-only inspector.
- Convert most repeated controls to icon-only `Button size="icon"` with `Tooltip`.
- Keep disruptive lifecycle controls visibly labeled and confirmed where appropriate.
- Remove or collapse passive cards that do not provide live state, inputs, or actions.
- Rebuild telemetry with Aurora stat/progress patterns while preserving current no-overlap and hidden-tab pause behavior.
- Convert setup complete/incomplete states to compact status rows or `Banner`, not large persistent cards.
- Rework golden config import so it is visible only when actionable/recently changed and never appears as a passive card.
- Verify desktop and mobile screenshots.

### Phase 2: Agents

- Turn agent dispatch into a dedicated task panel that fits in the first desktop viewport.
- Replace current form hierarchy with agent selector, repo/ref fields, prompt/task composer, dispatch action, queue/session viewer.
- Use `Banner`, compact `EmptyState`, `Item`, and `Badge` for status and run history. Defer `DataTable` and rich timelines unless justified.
- Keep dispatch visibly labeled, rose-toned, disabled while pending, and protected against duplicate submission.
- Bound queue/history rendering and lazy-load selected-run details.
- Ensure inactive Agents surfaces do not poll.

### Phase 3: Builder and settings cleanup

- Convert Builder into one dense, grouped image builder panel.
- Replace raw selects and chips with Aurora form primitives.
- Keep package search, images, and presets compact; use tables only if record counts justify them.
- Add explicit imported-command review before build dispatch.
- Fix build polling lifecycle: abort/clear timers on unmount or tab switch, preserve cursor/offset polling, and bound log state.
- Render logs in fixed-height internally scrolling log chrome using existing primitives.
- Move limits, mount, snapshots, and sharing into Settings with separate pending/error states per mutation.
- Keep Settings dense and utilitarian.

### Phase 4: Security and runtime hardening

- Add or preserve server-side guards named in the authorization matrix.
- Add safe summary/redaction boundaries for any logs, errors, operation results, build output, or agent output surfaced by the redesigned UI.
- Verify build status/logs/images/presets are owner-filtered server-side.
- Preserve trusted proxy identity on every non-health route touched by the revamp.
- Ensure risky actions use visible labels, confirmation where needed, pending states, and clear status feedback.

### Phase 5: Verification

- Run `npm --prefix apps/web run lint`.
- Run `npm --prefix apps/web run test`.
- Run `npm --prefix apps/web run build`.
- Run bundle-size evidence such as `ANALYZE=true npm --prefix apps/web run build` when supported, or document the closest available evidence.
- Capture Playwright/Webwright screenshots for desktop and mobile.
- Verify `.light` mode does not break contrast or layout.
- Inspect for non-Aurora controls and raw color usage before closeout.
- Review every visible panel and ask: "What can the user do or decide here?" Remove or collapse the panel if the answer is weak.
- Confirm primary screen actions are visible without page scroll at 1440x900 and 390x844.
- Test long logs/history with synthetic 5k-line data or an equivalent fixture and verify no page-level scroll jank.
- Verify inactive tabs do not keep polling and poll timers/fetches clean up on unmount.

## Acceptance criteria

- The first viewport clearly answers: workspace state, terminal readiness, setup readiness, and next recommended action.
- Opening a terminal and dispatching an agent are visible, distinct flows.
- Builder and settings are not competing with daily workspace operation.
- Mobile starts with workspace status and primary action, not repeated navigation.
- Important controls for the active screen are reachable without page scroll on common desktop and mobile viewports.
- Space usage correlates with utility: passive explanatory content never gets card-sized treatment.
- Buttons are icon-only by default, with text kept only where it materially improves comprehension or reduces risk.
- All controls use Aurora components where available.
- All colors, surfaces, shadows, focus, and status styling use Aurora tokens.
- No raw `select`, label-as-button upload controls, ad hoc status pills, or raw colored cards remain in primary surfaces.
- Errors and empty states give direction using Aurora feedback components.
- Screenshots show no overlapping text, clipped controls, or incoherent stacking at desktop or mobile sizes.
- Inspector remains read-only. All configuration mutations live in Settings or explicit dialogs.
- No hidden inactive tab keeps polling, appending logs, or rendering large histories.
- Builder polling is cancellable and cleans up timers/fetches on unmount or tab switch.
- Agent/build logs and operation errors are redacted, bounded, and rendered from safe summaries.
- Build status/logs/images/presets are owner-filtered server-side.
- Every non-health route touched by the revamp preserves trusted identity and workspace authorization checks.
- No deleted Aurora feature block is rebuilt locally as part of this epic.
- Overview first-load does not eagerly import heavy Builder, full-log/session, DataTable-heavy, or Aurora AI surfaces.

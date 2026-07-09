# UI/UX revamp work-it closeout

Date: 2026-07-09
Branch: `codex/ui-ux-revamp`
PR: https://github.com/jmagar/incus-web/pull/28

## Scope

- Reworked the workspace dashboard into a task-oriented control plane using Aurora tokens and components.
- Removed passive card space from the primary flow and moved low-frequency configuration into tabs.
- Added a compact overview with workspace state, primary actions, readiness, live telemetry, access status, and read-only inspector.
- Split Agents, Builder, and Settings into task tabs so important workflow surfaces are available without scrolling through non-actionable text.
- Preserved icon-dominant controls where the action is recognizable, with text retained for destructive or high-risk actions.

## Plan and review

- Captured the starting UI with Webwright screenshots in `.codex-ui-audit/`.
- Wrote and revised `docs/sessions/ui-ux-revamp-plan.md`.
- Ran Lavra engineering review against the plan as an epic bead and folded in architecture, simplicity, security, and performance findings before implementation.
- Ran post-implementation review waves:
  - Architecture: fixed workspace-scoped state by keying Agents and Settings panes.
  - Design: removed the passive setup-complete panel, tightened mobile shell space, fixed Builder import icons, and replaced ad hoc preset buttons with Aurora list/action primitives.
  - Performance: split Settings into its own lazy module, bounded snapshots before storing, bounded Builder log appends without large transient concatenation, and confirmed hidden tabs do not poll.
  - Security: no introduced actionable findings; pre-existing server-side error redaction risk noted outside this PR.
  - Simplifier: extracted tone helpers and consolidated Builder polling cancellation while preserving tab click behavior.
  - PR toolkit: added Settings mutation/resync coverage, Builder polling/log/import-command coverage, an imported-command review gate, visible log truncation disclosure, save/import error handling, and mounted Builder monitoring so active builds are not silently abandoned when switching tabs.

## Evidence

- Desktop screenshot: `.codex-ui-audit/active-desktop-v3.png`
- Mobile screenshot: `.codex-ui-audit/active-mobile-v3.png`
- `npm --prefix apps/web run lint`
  - Passes with 9 existing warnings in `apps/web/components/ui/aurora/component-card.tsx`.
- `npm --prefix apps/web run test`
  - 29 files, 222 tests passed.
- `npm --prefix apps/web run build`
  - Production build completed successfully.

## Notes

- Prototype-static dev screenshots log a local `node:sqlite` fallback warning for the activity route under Next dev. The UI falls back to memory activity and the production build/tests are unaffected.
- CodeRabbit and Codex review comments on the PR were usage-limit notices only, not actionable review findings.

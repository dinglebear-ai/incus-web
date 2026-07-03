# Agent Run Dispatch V1

## Goal

Let an authenticated user dispatch a Codex or Claude task from the web UI into a fresh Incus container cloned from a ZFS-backed golden workspace. The UI must show run progress so the user can see whether the system is cloning the container, cloning the repo, attaching the agent controller, running, completed, or failed.

This is a prototype slice, but it must establish the right shape for the production system:

- container creation uses a prebuilt golden container/snapshot, not package install or dotfile bootstrap;
- the hot path should usually be ZFS clone + repo clone + agent CLI startup;
- each agent run gets its own container;
- each agent run is explicitly associated with the container it owns;
- run state is persisted by the host provisioner, not only React state;
- the dashboard exposes a real dispatch form and a real run list.

## Non-goals

- No multi-tenant database schema yet.
- No long-lived streaming transport yet; polling is acceptable for v1.
- No automatic GitHub app installation flow.
- No terminal attach into the run container yet.
- No production-grade queue scheduler yet.
- No secrets UI beyond documenting/env boundaries for this slice.

## Product Behavior

The dashboard gets an `Agent runs` surface with:

- agent selector: `codex` or `claude`;
- repo URL input;
- task prompt textarea;
- optional branch/ref input;
- submit button;
- recent runs table/list showing:
  - agent;
  - repo;
  - phase;
  - container;
  - created/updated time;
  - last log excerpt;
  - final status.

The form copy must make the trust boundary clear:

- run containers are fresh clones of the golden workspace;
- repo/task content executes inside that run container;
- Codex/Claude credentials must already be available in the golden image or injected by a later secrets system.

## Runtime Architecture

### Golden Container Strategy

The host provisioner should expect a prepared golden source:

- env: `INCUS_WEB_AGENT_GOLDEN_CONTAINER`
- default: `incus-web-agent-golden`
- env: `INCUS_WEB_AGENT_GOLDEN_PROJECT`
- default: current `INCUS_WEB_INCUS_PROJECT` or `default`
- env: `INCUS_WEB_AGENT_RUN_PROJECT`
- default: current `INCUS_WEB_INCUS_PROJECT` or `default`

Invariant:

- one `AgentRun` owns exactly one run container;
- the agent CLI process runs only in that run container;
- the regular interactive workspace container is not reused for dispatched agent tasks;
- any future terminal/log/artifact view resolves through `AgentRun.container`.

Dispatch flow:

1. Generate a run id, for example `run_YYYYMMDDHHMMSS_<short>`.
2. Generate a run container name, for example `agent-run-<short>`.
3. Copy/clone from the golden source:
   - preferred: `incus copy <golden> <run-container> --project <project>` when source and target project match;
   - if snapshots are needed, use the golden snapshot configured by env in a follow-up.
4. Start the run container.
5. Clone the repo into `/workspace/repo`.
6. Attach the chosen agent controller in `/workspace/repo`:
   - Codex must be controlled through app-server, not treated as an opaque long-running shell command.
   - Claude can initially use an env-configurable CLI command template until an equivalent controller exists.
   - controller settings should be env-configurable in v1 so we can adjust without rebuilding:
     - `INCUS_WEB_CODEX_APP_SERVER_URL`
     - `INCUS_WEB_CODEX_APP_SERVER_TOKEN`
     - `INCUS_WEB_CLAUDE_COMMAND_TEMPLATE`
7. Persist phase/log updates as the run advances.

For v1, using `incus exec` and a shell script inside the run container is acceptable. Keep command execution bounded with timeouts and output caps similar to the existing provisioner.

### Run Store

Add a host-local JSON store for prototype runs:

- env: `INCUS_WEB_AGENT_RUN_STORE_PATH`
- default: `/var/lib/incus-web/agent-runs.json` for the host provisioner;
- tests should override it to a temp path.

The store records:

```ts
type AgentRun = {
  id: string
  workspaceId: string
  ownerUserId: string
  container: {
    name: string
    project: string
    sourceContainer: string
    sourceProject: string
    createdFrom: "golden"
    state: "planned" | "cloning" | "stopped" | "starting" | "running" | "failed" | "deleted"
  }
  agent: "codex" | "claude"
  repoUrl: string
  ref?: string
  task: string
  phase:
    | "queued"
    | "cloning_container"
    | "starting_container"
    | "cloning_repo"
    | "attaching_agent"
    | "running"
    | "succeeded"
    | "failed"
  status: "queued" | "running" | "succeeded" | "failed"
  createdAt: string
  updatedAt: string
  completedAt?: string
  controller?: {
    kind: "codex-app-server" | "claude-cli"
    sessionId?: string
    url?: string
  }
  lastLogExcerpt?: string
  error?: string
}
```

The `container` object is mandatory from run creation time. Before the Incus clone exists, it still records the intended container name/project with `state: "planned"`. This lets the UI, cleanup jobs, logs, and future terminal attach all refer to the same durable container identity.

### Provisioner Contract

Extend the existing provisioner contract with two commands:

- `DispatchAgentRun`
- `ListAgentRuns`

Payloads/results:

```ts
type DispatchAgentRunPayload = {
  agent: "codex" | "claude"
  repoUrl: string
  ref?: string
  task: string
}

type DispatchAgentRunResult = {
  run: AgentRun
}

type ListAgentRunsPayload = {
  limit: number
}

type ListAgentRunsResult = {
  runs: AgentRun[]
}
```

Validation requirements:

- repo URL must be `https://`, `ssh://`, or `git@host:path` style;
- task cannot be blank and must have a sane max length;
- ref is optional but must be a simple branch/ref-ish string if present;
- agent must be `codex` or `claude`;
- list limit must be clamped.

### Web API

Add routes:

- `POST /api/workspaces/[workspaceId]/agent-runs`
- `GET /api/workspaces/[workspaceId]/agent-runs`

Both routes must:

- authenticate via existing reverse-proxy identity;
- authorize against `getWorkspaceRefForActor`;
- reject mismatched workspace ids;
- call the provisioner command;
- return structured errors matching existing action route conventions.

### Dashboard UI

Add a client component:

- `components/agent-run-dispatch.tsx`

Responsibilities:

- render the dispatch form;
- POST a new run;
- poll GET after submission and periodically while any run is active;
- display recent runs;
- show phase and last log excerpt;
- refresh without page reload when possible.

Keep the visual style utilitarian:

- squared 4px panels;
- no large decorative hero/cards;
- no fake actions;
- disabled/copy-only indicators where backend functionality is not implemented.

Recommended layout:

- one `Agent runs` surface inside the existing workspace dashboard;
- desktop: `Dispatch` form on the left and `Recent runs` on the right;
- mobile: form first, then recent run cards;
- no standalone hero, no oversized status cards.

The primary row relationship is:

```text
AgentRun ID -> owned container -> controller/session
```

Dispatch form fields:

- agent segmented control: `Codex` or `Claude`;
- repository URL;
- optional branch/ref;
- task textarea;
- submit button labeled `Dispatch run`.

Codex helper copy:

```text
Controlled through app-server. A controller session will be attached inside the run container.
```

Claude helper copy:

```text
Uses the configured Claude command template for this v1 run path.
```

Recent runs must show:

- run id and repo/ref;
- agent;
- controller kind and session/config state;
- owned container name/project/source;
- phase;
- updated timestamp;
- status;
- last log excerpt/error when present.

Do not add terminal/session action buttons for v1 unless the matching route is real.

### Tests

Add/extend tests for:

- contract validation for new commands and run shape;
- host/static provisioner behavior for unsupported commands, if applicable;
- agent run store validation/persistence;
- API route invalid body/auth/workspace mismatch/success;
- dashboard component renders form, submits a run, and displays returned run progress.

Use temp files for stores. Do not depend on real Incus in unit tests.

### Host Provisioner Implementation Notes

The first implementation can run the long job in-process and return immediately after the run is queued/started. If that is too large for this slice, it may implement the durable store + queued run creation + command skeleton, with clear tests and UI showing queued state. But the preferred v1 should at least start an async background execution path in the host provisioner process.

Codex controller boundary:

- do not hardcode `codex exec` as the Codex execution path;
- introduce an internal controller abstraction such as `startAgentController(run, repoPath, task)`;
- for `agent: "codex"`, the controller implementation talks to app-server and records the returned session id/url on `AgentRun.controller`;
- if app-server API details are not yet available, implement a typed `codex-app-server` adapter seam and fail with a clear `missing_controller_config`/`not_implemented` state rather than silently falling back to shelling out;
- for `agent: "claude"`, the v1 controller may use `INCUS_WEB_CLAUDE_COMMAND_TEMPLATE`.

Pseudo-flow:

```js
async function dispatchAgentRun(command, options) {
  const run = createRun(...)
  await save(run)
  void executeRun(run, command, options).catch(...)
  return { run }
}
```

`executeRun` updates phases:

1. `cloning_container`
2. `starting_container`
3. `cloning_repo`
4. `attaching_agent`
5. `running`
6. terminal phase

### Verification

Run:

```bash
npm test -- --run
npm run build
npm run lint
bash tests/deploy_static_tests.sh
```

Manual/dev smoke:

1. Start or restart the host provisioner.
2. Open the dashboard as an authenticated actor.
3. Submit a benign repo/task using a fake/safe command template if needed.
4. Confirm a run appears and phase changes are visible.

## Open Questions For Follow-up

- Exact app-server API shape for controlling Codex sessions needs to be wired into the `codex-app-server` adapter.
- Exact noninteractive command syntax for Claude should be validated against the installed CLI in the golden image.
- Secrets injection for agent CLIs needs a dedicated encrypted secret store, not env sprawl.
- Later streaming should use SSE/WebSocket instead of polling.
- Later cleanup should expire run containers and preserve logs/artifacts.

## Addendum (2026-07-03)

The golden container and credential handling described above (line 47, "Codex/Claude credentials must already be available in the golden image or injected by a later secrets system") are now implemented, differently than the "dedicated encrypted secret store" originally envisioned above:

- `scripts/build-agent-golden.sh` provisions `incus-web-agent-golden` on the `labby-zfs` storage pool (not the default `dir` pool -- COW clones are near-instant, `dir` copies took 10+ minutes for this image size).
- Credentials are NOT baked into the golden image. `scripts/agent-runs.mjs`'s `executeAgentRun` reads the owner's already-authenticated Claude/Codex credential from the `incus-web` container at dispatch time and injects it into the freshly-cloned run container via `incus file push`, then deletes it after the run completes.
- A full encrypted secret store (per this doc's original "Open Questions") was scoped and explicitly deferred (bead `incus-web-6ai.3`) -- no evidence the primary host-sourced path fails for a reason a fallback store would fix.
- A real operational finding from live testing: the source credential can go stale (no interactive `claude`/`codex` session refreshing it) -- `executeAgentRun` now detects an expired Claude credential proactively and fails with an actionable message rather than surfacing the CLI's generic "Not logged in" error.

See PRs #11 and #12, and bead `incus-web-6ai` (children `.1`, `.2` closed; `.3` deferred).

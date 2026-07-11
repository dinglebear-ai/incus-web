"use client";

import {
  ActivityIcon,
  BotIcon,
  BoxesIcon,
  CircleGaugeIcon,
  CpuIcon,
  DatabaseIcon,
  GitBranchIcon,
  HammerIcon,
  HardDriveIcon,
  InfoIcon,
  MemoryStickIcon,
  NetworkIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  ShieldCheckIcon,
  TerminalIcon,
  UserRoundIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { LucideIcon } from "lucide-react";
import { Suspense, lazy, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/aurora/badge";
import { Card } from "@/components/ui/aurora/card";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/ui/aurora/description-list";
import { Button } from "@/components/ui/aurora/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/aurora/tooltip";
import { StatusIndicator } from "@/components/ui/aurora/status-indicator";
import { WorkspaceDetailsPanel } from "@/components/workspace-details-panel";
import { WorkspaceActions } from "@/components/workspace-actions";
import {
  isLiveState,
  MetricBar,
  Sparkline,
  TelemetryFreshness,
  useWorkspaceTelemetry,
  type Sample,
} from "@/components/workspace-telemetry";
import type {
  CheckStatus,
  SetupPhase,
  Workspace,
  WorkspaceInventory,
  WorkspaceState,
} from "@/lib/workspaces/types";

const BuilderPanel = dynamic(
  () => import("@/components/builder-panel").then((mod) => mod.BuilderPanel),
  { ssr: false },
);
const AgentRunDispatch = lazy(
  () =>
    import("@/components/agent-run-dispatch").then(
      (mod) => ({ default: mod.AgentRunDispatch }),
    ),
);
const WorkspaceSettingsPanel = dynamic(
  () =>
    import("@/components/workspace-settings-panel").then(
      (mod) => mod.WorkspaceSettingsPanel,
    ),
  { ssr: false },
);

const WORKSPACE_TOOLS = ["agents", "builder", "settings", "inspect"] as const;
type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];

function stateTone(state: WorkspaceState) {
  if (state === "running") return "success";
  if (state === "degraded" || state === "setting_up") return "warn";
  if (state === "failed" || state === "deleted") return "error";
  return "neutral";
}

function stateStatusTone(state: WorkspaceState) {
  if (state === "running") return "online";
  if (state === "degraded" || state === "setting_up") return "degraded";
  if (state === "failed" || state === "deleted") return "error";
  if (state === "creating" || state === "starting" || state === "restarting") {
    return "syncing";
  }
  return "queued";
}

function checkTone(status: CheckStatus) {
  if (status === "ok") return "success";
  if (status === "warn" || status === "unknown") return "warn";
  if (status === "missing") return "error";
  return "neutral";
}

function setupPhaseTone(phase: SetupPhase) {
  if (phase === "ready") return "success";
  if (phase === "failed") return "error";
  if (phase === "not_configured" || phase === "queued") return "neutral";
  return "warn";
}

function setupStatusTone(phase: SetupPhase) {
  if (phase === "ready") return "online";
  if (phase === "failed") return "error";
  return "syncing";
}

function setupPhaseLabel(phase: SetupPhase) {
  if (phase === "ready") return "complete";
  return phase.replaceAll("_", " ");
}

function SetupCheck({ label, status }: { label: string; status: CheckStatus }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--aurora-border-default)] px-3 py-2 last:border-b-0">
      <span className="aurora-text-ui text-[var(--aurora-text-muted)]">
        {label}
      </span>
      <Badge tone={checkTone(status)} shape="tag">
        {status}
      </Badge>
    </div>
  );
}

function SetupProgressPanel({ workspace }: { workspace: Workspace }) {
  if (workspace.setup.phase === "ready") {
    return null;
  }

  return (
    <section className="overflow-hidden rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--aurora-border-default)] px-4 py-3">
        <SectionLabel icon={DatabaseIcon} tone="rose">
          Setup
        </SectionLabel>
        <Badge tone={setupPhaseTone(workspace.setup.phase)} shape="tag">
          {setupPhaseLabel(workspace.setup.phase)}
        </Badge>
      </div>
      <div>
        <SetupCheck label="Commands" status={workspace.setup.commandStatus} />
        <SetupCheck label="Packages" status={workspace.setup.packageStatus} />
        <SetupCheck label="mise" status={workspace.setup.miseStatus} />
      </div>
      {workspace.setup.lastLogExcerpt ? (
        <div className="border-t border-[var(--aurora-border-default)] px-3 py-2">
          <p className="aurora-text-meta">{workspace.setup.lastLogExcerpt}</p>
        </div>
      ) : null}
    </section>
  );
}

function SectionLabel({
  icon: Icon,
  children,
  tone = "cyan",
}: {
  icon: LucideIcon;
  children: ReactNode;
  tone?: "cyan" | "rose" | "success";
}) {
  const color = sectionToneColor(tone);

  return (
    <div className="flex items-center gap-2">
      <Icon aria-hidden="true" className="size-4" style={{ color }} />
      <h2 className="aurora-text-label text-[var(--aurora-text-primary)]">
        {children}
      </h2>
    </div>
  );
}

function sectionToneColor(tone: "cyan" | "rose" | "success") {
  switch (tone) {
    case "rose":
      return "var(--aurora-accent-pink)";
    case "success":
      return "var(--aurora-success)";
    case "cyan":
      return "var(--aurora-accent-primary)";
  }
}

function WorkspacePane({
  workspace: seed,
  activeTool,
  setActiveTool,
}: {
  workspace: Workspace;
  activeTool: WorkspaceTool;
  setActiveTool: (tool: WorkspaceTool) => void;
}) {
  const { workspace, history, lastUpdated, polling, error } =
    useWorkspaceTelemetry(seed);
  const live = isLiveState(workspace.state);

  return (
    <WorkspaceCockpit
      workspace={workspace}
      history={history}
      lastUpdated={lastUpdated}
      polling={polling}
      error={error}
      live={live}
      activeTool={activeTool}
      setActiveTool={setActiveTool}
    />
  );
}

function WorkspaceCockpit({
  workspace,
  history,
  lastUpdated,
  polling,
  error,
  live,
  activeTool,
  setActiveTool,
}: {
  workspace: Workspace;
  history: Sample[];
  lastUpdated: number;
  polling: boolean;
  error?: string;
  live: boolean;
  activeTool: WorkspaceTool;
  setActiveTool: (tool: WorkspaceTool) => void;
}) {
  return (
    <section className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(360px,430px)]">
      <article className="min-w-0 overflow-hidden rounded-[var(--aurora-radius-3)] border border-[var(--aurora-border-strong)] bg-[var(--aurora-panel-strong)] shadow-[var(--aurora-shadow-strong),var(--aurora-highlight-strong)]">
        <div className="grid gap-3 border-b border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[1.35rem] font-semibold leading-tight text-[var(--aurora-text-primary)]">
                {workspace.name}
              </h1>
              <Badge
                tone={stateTone(workspace.state)}
                dot
                pulse={workspace.state === "running"}
              >
                {workspace.state}
              </Badge>
            </div>
            <p className="mt-1 aurora-text-code text-[var(--aurora-text-muted)]">
              {workspace.incusProject} / {workspace.incusContainer}
            </p>
          </div>
          <WorkspaceActions workspace={workspace} />
        </div>

        <div className="grid gap-3 p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1fr)]">
            <LaunchPanel workspace={workspace} />
            <SignalMatrix workspace={workspace} />
          </div>
          <WorkspaceTelemetryPanel
            workspace={workspace}
            history={history}
            lastUpdated={lastUpdated}
            polling={polling}
            error={error}
            live={live}
          />
          <WorkspaceMetaBar workspace={workspace} />
          <SetupProgressPanel workspace={workspace} />
        </div>
      </article>

      <ToolDeck
        workspace={workspace}
        activeTool={activeTool}
        setActiveTool={setActiveTool}
      />
    </section>
  );
}

function LaunchPanel({ workspace }: { workspace: Workspace }) {
  return (
    <section className="grid min-h-[178px] content-between gap-4 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-strong)] bg-[color-mix(in_srgb,var(--aurora-control-surface)_82%,transparent)] p-4 shadow-[var(--aurora-highlight-medium)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="aurora-text-meta">Primary route</p>
          <h2 className="mt-1 truncate text-[1.1rem] font-semibold text-[var(--aurora-text-primary)]">
            Terminal
          </h2>
          <p className="mt-1 truncate aurora-text-code text-[var(--aurora-text-muted)]">
            {workspace.terminalUrl ?? "route pending"}
          </p>
        </div>
        <StatusIndicator
          tone={workspace.terminalUrl ? "online" : "queued"}
          label={workspace.terminalUrl ? "ready" : "pending"}
        />
      </div>
      <Button
        asChild={Boolean(workspace.terminalUrl)}
        size="default"
        variant={workspace.terminalUrl ? "aurora" : "neutral"}
        disabled={!workspace.terminalUrl}
        aria-label="Open terminal"
        className="h-12 justify-start gap-3"
      >
        {workspace.terminalUrl ? (
          <a href={workspace.terminalUrl}>
            <TerminalIcon aria-hidden="true" className="size-5" />
            <span>Open terminal</span>
          </a>
        ) : (
          <>
            <TerminalIcon aria-hidden="true" className="size-5" />
            <span>Terminal pending</span>
          </>
        )}
      </Button>
    </section>
  );
}

function SignalMatrix({ workspace }: { workspace: Workspace }) {
  const signals = [
    {
      icon: ActivityIcon,
      label: "Workspace",
      value: workspace.state,
      tone: stateStatusTone(workspace.state),
    },
    {
      icon: DatabaseIcon,
      label: "Setup",
      value: setupPhaseLabel(workspace.setup.phase),
      tone: setupStatusTone(workspace.setup.phase),
    },
    {
      icon: GitBranchIcon,
      label: "Dotfiles",
      value: workspace.setup.dotfilesStatus,
      tone: workspace.setup.dotfilesStatus === "ok" ? "online" : "degraded",
    },
    {
      icon: NetworkIcon,
      label: "Bridge",
      value: workspace.networkBridge ?? "unknown",
      tone: workspace.networkBridge ? "online" : "queued",
    },
  ] satisfies Array<{
    icon: LucideIcon;
    label: string;
    value: string;
    tone: React.ComponentProps<typeof StatusIndicator>["tone"];
  }>;

  return (
    <section className="grid gap-2 sm:grid-cols-2">
      {signals.map(({ icon: Icon, label, value, tone }) => (
        <div
          key={label}
          className="grid min-h-[84px] grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] px-3 py-2"
        >
          <span className="flex size-9 items-center justify-center rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)]">
            <Icon aria-hidden="true" className="size-4 text-[var(--aurora-accent-primary)]" />
          </span>
          <div className="min-w-0">
            <p className="aurora-text-meta">{label}</p>
            <StatusIndicator
              className="mt-1 max-w-full"
              tone={tone}
              label={<span className="truncate">{value}</span>}
            />
          </div>
        </div>
      ))}
    </section>
  );
}

function WorkspaceMetaBar({ workspace }: { workspace: Workspace }) {
  const items = [
    { icon: BoxesIcon, label: "Image", value: workspace.image ?? workspace.templateVersion },
    { icon: SlidersHorizontalIcon, label: "Profile", value: workspace.resourceProfileId },
    { icon: HardDriveIcon, label: "Storage", value: workspace.resources.storage },
  ];

  return (
    <dl className="grid gap-2 lg:grid-cols-3">
      {items.map(({ icon: Icon, label, value }) => (
        <div
          key={label}
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] px-3 py-2"
          title={`${label}: ${value}`}
        >
          <Icon
            aria-hidden="true"
            className="size-4 text-[var(--aurora-text-muted)]"
          />
          <div className="min-w-0">
            <dt className="aurora-text-meta">{label}</dt>
            <dd className="truncate aurora-text-code text-[var(--aurora-text-primary)]">
              {value}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

function WorkspaceTelemetryPanel({
  workspace,
  history,
  lastUpdated,
  polling,
  error,
  live,
}: {
  workspace: Workspace;
  history: Sample[];
  lastUpdated: number;
  polling: boolean;
  error?: string;
  live: boolean;
}) {
  const cpuPercent = history.at(-1)?.cpuPercent;
  const memoryPercent = history.at(-1)?.memoryPercent;

  return (
    <section className="space-y-3 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] p-3">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel icon={CircleGaugeIcon}>Live telemetry</SectionLabel>
        <TelemetryFreshness
          lastUpdated={lastUpdated}
          polling={polling}
          live={live}
        />
      </div>
      {error ? (
        <p className="aurora-text-meta text-[var(--aurora-error)]">{error}</p>
      ) : null}
      <div className="grid gap-2 lg:grid-cols-3">
        <MetricTile
          icon={CpuIcon}
          label="CPU"
          usedLabel={workspace.resources.cpu}
          percentValue={cpuPercent}
          tone="info"
        >
          <Sparkline
            history={history}
            metric="cpuPercent"
            tone="var(--aurora-accent-primary)"
          />
        </MetricTile>
        <MetricTile
          icon={MemoryStickIcon}
          label="Memory"
          usedLabel={workspace.resources.memory}
          percentValue={memoryPercent}
          tone="success"
        >
          <Sparkline
            history={history}
            metric="memoryPercent"
            tone="var(--aurora-success)"
          />
        </MetricTile>
        <MetricTile
          icon={HardDriveIcon}
          label="Storage"
          usedLabel={workspace.resources.storage}
          percentValue={undefined}
          tone="warn"
        />
      </div>
    </section>
  );
}

function MetricTile({
  icon: Icon,
  label,
  usedLabel,
  percentValue,
  tone,
  children,
}: {
  icon: LucideIcon;
  label: string;
  usedLabel: string;
  percentValue: number | undefined;
  tone: "info" | "success" | "warn";
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-[var(--aurora-accent-primary)]" />
        <div className="min-w-0 flex-1">
          <MetricBar
            label={label}
            usedLabel={usedLabel}
            percentValue={percentValue}
            tone={tone}
          />
        </div>
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function ToolDeck({
  workspace,
  activeTool,
  setActiveTool,
}: {
  workspace: Workspace;
  activeTool: WorkspaceTool;
  setActiveTool: (tool: WorkspaceTool) => void;
}) {
  return (
    <aside className="min-w-0 overflow-hidden rounded-[var(--aurora-radius-3)] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] shadow-[var(--aurora-shadow-medium),var(--aurora-highlight-medium)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--aurora-border-default)] p-3">
        <div className="flex min-w-0 items-center gap-2">
          <SlidersHorizontalIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-[var(--aurora-accent-primary)]"
          />
          <p className="aurora-text-label text-[var(--aurora-text-primary)]">Command rail</p>
        </div>
        <div className="flex items-center gap-1.5">
          {WORKSPACE_TOOLS.map((tool) => (
            <Tooltip key={tool}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant={activeTool === tool ? "aurora" : "neutral"}
                  aria-label={toolLabel(tool)}
                  onClick={() => setActiveTool(tool)}
                >
                  {toolIcon(tool)}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{toolLabel(tool)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="max-h-[calc(100vh-8rem)] min-w-0 overflow-auto p-3">
        <ActiveToolPanel workspace={workspace} activeTool={activeTool} />
      </div>
    </aside>
  );
}

function ActiveToolPanel({
  workspace,
  activeTool,
}: {
  workspace: Workspace;
  activeTool: WorkspaceTool;
}) {
  if (activeTool === "agents") {
    return (
      <Suspense fallback={<p className="aurora-text-meta">Loading agent runs...</p>}>
        <AgentRunDispatch workspace={workspace} />
      </Suspense>
    );
  }

  if (activeTool === "builder") return <BuilderPanel />;
  if (activeTool === "settings") return <WorkspaceSettingsPanel workspace={workspace} />;
  return <WorkspaceDetailsPanel workspace={workspace} />;
}

function DetailChip({
  icon: Icon,
  label,
  value,
  tone = "cyan",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: "cyan" | "rose" | "success" | "warn";
}) {
  const color = detailToneColor(tone);

  return (
    <span
      title={`${label}: ${value}`}
      className="inline-flex size-7 items-center justify-center rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)]"
    >
      <Icon aria-hidden="true" className="size-4" style={{ color }} />
      <span className="sr-only">
        {label}: {value}
      </span>
    </span>
  );
}

function detailToneColor(tone: "cyan" | "rose" | "success" | "warn") {
  switch (tone) {
    case "rose":
      return "var(--aurora-accent-pink)";
    case "success":
      return "var(--aurora-success)";
    case "warn":
      return "var(--aurora-warn)";
    case "cyan":
      return "var(--aurora-accent-primary)";
  }
}

function EmptyAccessState({ inventory }: { inventory: WorkspaceInventory }) {
  if (inventory.provisionerError) {
    return (
      <Card accent="rose" className="p-6">
        <p className="aurora-text-section">Workspace provisioner failed</p>
        <p className="aurora-text-body mt-2 text-[var(--aurora-text-muted)]">
          {inventory.provisionerError.message}
        </p>
        <DescriptionList className="mt-4 bg-transparent">
          <DescriptionItem
            label="Code"
            value={inventory.provisionerError.code}
            active
          />
          <DescriptionItem
            label="Request"
            value={inventory.provisionerError.requestId}
          />
          {inventory.provisionerError.workspaceId ? (
            <DescriptionItem
              label="Workspace"
              value={inventory.provisionerError.workspaceId}
            />
          ) : null}
        </DescriptionList>
      </Card>
    );
  }

  return (
    <Card accent="rose" className="p-6">
      <p className="aurora-text-section">No workspace access</p>
      <p className="aurora-text-body mt-2 text-[var(--aurora-text-muted)]">
        This authenticated account is not assigned to the current prototype
        workspace.
      </p>
    </Card>
  );
}

export function WorkspaceDashboard({
  inventory,
}: {
  inventory: WorkspaceInventory;
}) {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(
    inventory.workspaces[0]?.id,
  );
  const [activeTool, setActiveTool] = useState<WorkspaceTool>("inspect");
  const primaryWorkspace = activeWorkspace(inventory.workspaces, activeWorkspaceId);
  const hasMultipleWorkspaces = inventory.workspaces.length > 1;

  return (
    <main className="aurora-page-shell min-h-screen overflow-x-hidden text-[var(--aurora-text-primary)]">
      <TooltipProvider>
      <div className="mx-auto flex min-h-screen w-full min-w-0 max-w-[1600px] flex-col gap-3 px-3 py-3 md:px-5">
        <header className="flex flex-col gap-3 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] px-4 py-3 shadow-[var(--aurora-shadow-medium),var(--aurora-highlight-medium)] md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-[4px] border border-[var(--aurora-border-strong)] bg-[var(--aurora-control-surface)]">
              <BoxesIcon
                aria-hidden="true"
                className="size-4 text-[var(--aurora-accent-primary)]"
              />
            </div>
            <div>
              <p className="aurora-text-section leading-none">incus-web</p>
              <p className="aurora-text-meta mt-1">Workspace control plane</p>
            </div>
          </div>

          <div className="hidden min-w-0 flex-wrap items-center gap-2 sm:flex md:justify-end">
            <DetailChip
              icon={CircleGaugeIcon}
              label="Workspaces"
              value={`${inventory.workspaces.length}`}
            />
            <DetailChip
              icon={TerminalIcon}
              label="Terminal route"
              value={primaryWorkspace?.terminalUrl ?? "pending"}
              tone="rose"
            />
            <DetailChip
              icon={ShieldCheckIcon}
              label="Auth gate"
              value="Authelia"
              tone="success"
            />
            <div className="min-w-0 md:text-right">
              <p className="aurora-text-ui truncate">
                {inventory.actor.displayName}
              </p>
              <p className="aurora-text-meta truncate">{inventory.actor.email}</p>
            </div>
            <UserRoundIcon
              aria-hidden="true"
              className="size-5 text-[var(--aurora-accent-primary)] md:hidden"
            />
          </div>
        </header>

        <section className="grid min-w-0 gap-4">
          {inventory.workspaces.length > 0 ? (
            primaryWorkspace ? (
              <div
                className={
                  hasMultipleWorkspaces
                    ? "grid min-w-0 items-start gap-3 xl:grid-cols-[220px_minmax(0,1fr)]"
                    : "grid min-w-0 items-start gap-3"
                }
              >
                {hasMultipleWorkspaces ? (
                  <nav className="aurora-nav-shell hidden space-y-2 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] p-3 shadow-[var(--aurora-shadow-medium),var(--aurora-highlight-medium)] xl:block">
                    <p className="aurora-text-label px-1 text-[var(--aurora-text-muted)]">
                      Workspaces
                    </p>
                    {inventory.workspaces.map((workspace) => (
                      <div
                        key={workspace.id}
                        className={`grid gap-1 rounded-[8px] border px-3 py-2 transition ${
                          workspace.id === primaryWorkspace?.id
                            ? "border-[var(--aurora-accent-primary)] bg-[var(--aurora-control-surface)] shadow-[var(--aurora-active-glow)]"
                            : "border-[var(--aurora-border-default)] hover:border-[var(--aurora-border-strong)] hover:bg-[var(--aurora-hover-bg)]"
                        }`}
                      >
                        <button
                          type="button"
                          className="min-w-0 text-left aurora-text-ui"
                          onClick={() => setActiveWorkspaceId(workspace.id)}
                        >
                          <span className="block truncate">{workspace.name}</span>
                        </button>
                        <span className="flex items-center justify-between gap-2">
                          <Badge tone={stateTone(workspace.state)} shape="tag">
                            {workspace.state}
                          </Badge>
                          {workspace.terminalUrl ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  asChild
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Open terminal for ${workspace.name}`}
                                >
                                  <a href={workspace.terminalUrl}>
                                    <TerminalIcon aria-hidden="true" className="size-4" />
                                  </a>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Open terminal</TooltipContent>
                            </Tooltip>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </nav>
                ) : null}
                <div className="grid min-w-0 gap-3">
                  <WorkspacePane
                    key={`${primaryWorkspace.id}:${primaryWorkspace.createdAt}`}
                    workspace={primaryWorkspace}
                    activeTool={activeTool}
                    setActiveTool={setActiveTool}
                  />
                </div>
              </div>
            ) : null
          ) : (
            <EmptyAccessState inventory={inventory} />
          )}
        </section>

      </div>
      </TooltipProvider>
    </main>
  );
}

function activeWorkspace(workspaces: Workspace[], activeWorkspaceId: string | undefined) {
  return workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
}

function toolLabel(tool: WorkspaceTool) {
  switch (tool) {
    case "agents":
      return "Agent runs";
    case "builder":
      return "Image builder";
    case "settings":
      return "Workspace settings";
    case "inspect":
      return "Inspector";
  }
}

function toolIcon(tool: WorkspaceTool) {
  const className = "size-4";
  switch (tool) {
    case "agents":
      return <BotIcon aria-hidden="true" className={className} />;
    case "builder":
      return <HammerIcon aria-hidden="true" className={className} />;
    case "settings":
      return <SettingsIcon aria-hidden="true" className={className} />;
    case "inspect":
      return <InfoIcon aria-hidden="true" className={className} />;
  }
}

"use client";

import {
  BotIcon,
  BoxesIcon,
  CircleGaugeIcon,
  DatabaseIcon,
  GitBranchIcon,
  HammerIcon,
  InfoIcon,
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/aurora/card";
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
import { StatCard, StatGrid } from "@/components/ui/aurora/stat-card";
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

const ICON_STORAGE =
  '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>';
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

function metricValue(value: string) {
  if (value === "unknown" || value.includes("pending")) {
    return (
      <span className="aurora-text-section leading-tight text-[var(--aurora-text-muted)]">
        {value}
      </span>
    );
  }
  return value;
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

function WorkspaceFeature({
  icon: Icon,
  label,
  value,
  detail,
  tone = "cyan",
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone?: "cyan" | "success" | "warn";
  href?: string;
}) {
  const color = featureToneColor(tone);
  const className =
    "grid min-h-[82px] grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3 text-left";
  const content = (
    <>
      <Icon aria-hidden="true" className="mt-0.5 size-4" style={{ color }} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="aurora-text-ui truncate text-[var(--aurora-text-primary)]">
            {label}
          </p>
          <Badge tone={tone === "cyan" ? "info" : tone} shape="tag">
            {value}
          </Badge>
        </div>
        <p className="aurora-text-meta mt-2">{detail}</p>
      </div>
    </>
  );

  if (href) {
    return (
      <a className={className} href={href}>
        {content}
      </a>
    );
  }

  return <div className={className}>{content}</div>;
}

function featureToneColor(tone: "cyan" | "success" | "warn") {
  switch (tone) {
    case "success":
      return "var(--aurora-success)";
    case "warn":
      return "var(--aurora-warn)";
    case "cyan":
      return "var(--aurora-accent-primary)";
  }
}

function WorkspaceFeatures({ workspace }: { workspace: Workspace }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <SectionLabel icon={SlidersHorizontalIcon}>Workspace access</SectionLabel>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <WorkspaceFeature
          icon={TerminalIcon}
          label="Terminal"
          value={workspace.terminalUrl ? "live" : "pending"}
          detail={workspace.terminalUrl ?? "Route not exposed yet"}
          href={workspace.terminalUrl}
          tone={workspace.terminalUrl ? "success" : "warn"}
        />
        <WorkspaceFeature
          icon={GitBranchIcon}
          label="Dotfiles"
          value={workspace.setup.dotfilesStatus}
          detail="Installed during setup; drift is user state"
          tone={workspace.setup.dotfilesStatus === "ok" ? "success" : "warn"}
        />
      </div>
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

function WorkspacePane({ workspace: seed }: { workspace: Workspace }) {
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
}: {
  workspace: Workspace;
  history: Sample[];
  lastUpdated: number;
  polling: boolean;
  error?: string;
  live: boolean;
}) {
  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-[var(--aurora-radius-3)] border border-[var(--aurora-border-strong)] bg-[var(--aurora-panel-strong)] shadow-[var(--aurora-shadow-strong),var(--aurora-highlight-strong)]">
      <div className="grid gap-4 border-b border-[var(--aurora-border-default)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--aurora-accent-primary)_9%,var(--aurora-panel-strong)),var(--aurora-panel-strong)_42%,var(--aurora-panel-medium))] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate aurora-text-section text-[var(--aurora-text-primary)]">
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

        <div className="flex flex-col items-start gap-3 lg:items-end">
          <StatusIndicator
            tone={stateStatusTone(workspace.state)}
            label={workspace.state}
          />
          <WorkspaceActions workspace={workspace} />
        </div>
      </div>

      <div className="grid gap-4 p-4">
        <ReadinessRunway workspace={workspace} />
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_260px]">
          <WorkspaceTelemetryPanel
            workspace={workspace}
            history={history}
            lastUpdated={lastUpdated}
            polling={polling}
            error={error}
            live={live}
          />
          <WorkspaceFacts workspace={workspace} />
        </div>
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]">
          <WorkspaceFeatures workspace={workspace} />
          <SetupProgressPanel workspace={workspace} />
        </div>
      </div>
    </section>
  );
}

function ReadinessRunway({ workspace }: { workspace: Workspace }) {
  const stops = [
    {
      label: "Terminal route",
      value: workspace.terminalUrl ? "ready" : "pending",
      tone: workspace.terminalUrl ? "online" : "queued",
    },
    {
      label: "Setup",
      value: setupPhaseLabel(workspace.setup.phase),
      tone: setupStatusTone(workspace.setup.phase),
    },
    {
      label: "Dotfiles",
      value: workspace.setup.dotfilesStatus,
      tone: workspace.setup.dotfilesStatus === "ok" ? "online" : "degraded",
    },
    {
      label: "Workspace",
      value: workspace.state,
      tone: stateStatusTone(workspace.state),
    },
  ] satisfies Array<{
    label: string;
    value: string;
    tone: React.ComponentProps<typeof StatusIndicator>["tone"];
  }>;

  return (
    <section className="grid gap-2 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-strong)] bg-[var(--aurora-control-surface)] p-3 shadow-[var(--aurora-highlight-medium)] sm:grid-cols-2 xl:grid-cols-4">
      {stops.map((stop) => (
        <div
          key={stop.label}
          className="min-w-0 border-b border-[var(--aurora-border-default)] pb-2 last:border-b-0 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3 sm:last:border-r-0"
        >
          <p className="aurora-text-meta">{stop.label}</p>
          <StatusIndicator
            className="mt-1 max-w-full"
            tone={stop.tone}
            label={<span className="truncate">{stop.value}</span>}
          />
        </div>
      ))}
    </section>
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
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
          <MetricBar
            label="CPU (load avg)"
            usedLabel={workspace.resources.cpu}
            percentValue={cpuPercent}
            tone="info"
          />
          <Sparkline
            history={history}
            metric="cpuPercent"
            tone="var(--aurora-accent-primary)"
          />
        </div>
        <div className="space-y-2 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
          <MetricBar
            label="Memory"
            usedLabel={workspace.resources.memory}
            percentValue={memoryPercent}
            tone="success"
          />
          <Sparkline
            history={history}
            metric="memoryPercent"
            tone="var(--aurora-success)"
          />
        </div>
      </div>
      <StatGrid>
        <StatCard
          compact
          icon={ICON_STORAGE}
          label="Storage"
          value={metricValue(workspace.resources.storage)}
          tone="warn"
          style={{ borderRadius: 4, boxShadow: "none" }}
        />
      </StatGrid>
    </section>
  );
}

function WorkspaceFacts({ workspace }: { workspace: Workspace }) {
  const facts = [
    ["Image", workspace.image ?? workspace.templateVersion],
    ["Storage", workspace.storagePool ?? "unknown"],
    ["Bridge", workspace.networkBridge ?? "unknown"],
    ["Profile", workspace.resourceProfileId],
    ["Path", workspace.workspaceHostPath ?? "profile default"],
    ["Processes", workspace.resources.effectiveProcesses ?? "profile default"],
  ];

  return (
    <aside className="rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
      <SectionLabel icon={InfoIcon}>Workspace facts</SectionLabel>
      <dl className="mt-3 grid gap-2">
        {facts.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-b border-[var(--aurora-border-default)] pb-2 last:border-b-0 last:pb-0">
            <dt className="aurora-text-meta">{label}</dt>
            <dd className="truncate aurora-text-ui text-[var(--aurora-text-primary)]" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
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
    <aside className="min-w-0 rounded-[var(--aurora-radius-3)] border border-[var(--aurora-border-strong)] bg-[var(--aurora-panel-strong)] shadow-[var(--aurora-shadow-strong),var(--aurora-highlight-strong)] lg:sticky lg:top-3 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-auto">
      <div className="border-b border-[var(--aurora-border-default)] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="aurora-text-label text-[var(--aurora-text-muted)]">Command dock</p>
            <p className="aurora-text-ui text-[var(--aurora-text-primary)]">Run, build, tune, inspect</p>
          </div>
          <Badge tone="info" shape="tag">{activeTool}</Badge>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1.5">
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
      <div className="min-w-0 p-3">
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
  const [activeTool, setActiveTool] = useState<WorkspaceTool>("agents");
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
                    ? "grid min-w-0 items-start gap-3 xl:grid-cols-[220px_minmax(0,1fr)_minmax(340px,420px)]"
                    : "grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]"
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
                <WorkspacePane
                  key={`${primaryWorkspace.id}:${primaryWorkspace.createdAt}`}
                  workspace={primaryWorkspace}
                />
                <ToolDeck
                  key={`${primaryWorkspace.id}:${primaryWorkspace.createdAt}:tools`}
                  workspace={primaryWorkspace}
                  activeTool={activeTool}
                  setActiveTool={setActiveTool}
                />
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

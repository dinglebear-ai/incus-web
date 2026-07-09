"use client";

import {
  BoxesIcon,
  CheckCircle2Icon,
  CircleGaugeIcon,
  DatabaseIcon,
  FingerprintIcon,
  FolderGit2Icon,
  GitBranchIcon,
  SlidersHorizontalIcon,
  ShieldCheckIcon,
  SignalIcon,
  TerminalIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

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
import { StatCard, StatGrid } from "@/components/ui/aurora/stat-card";
import { StatusIndicator } from "@/components/ui/aurora/status-indicator";
import { AgentRunDispatch } from "@/components/agent-run-dispatch";
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

function SetupCompleteNotice({ workspace }: { workspace: Workspace }) {
  const storageKey = `incus-web:setup-complete-dismissed:${workspace.id}:${workspace.createdAt}`;
  // Start at `false` on both server and client so hydration always matches,
  // then read the real value from localStorage post-mount. Reading
  // localStorage inside the useState initializer would run it a second time
  // during hydration (window defined) after SSR already rendered with a
  // default of `false`, producing a client/server tree mismatch whenever a
  // dismissal was previously stored.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(storageKey) === "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(true);
    }
  }, [storageKey]);

  if (workspace.setup.phase !== "ready" || dismissed) {
    return null;
  }

  return (
    <section className="flex items-center justify-between gap-3 rounded-[var(--aurora-radius-2)] border border-[color-mix(in_srgb,var(--aurora-success)_36%,var(--aurora-border-default))] bg-[color-mix(in_srgb,var(--aurora-success)_8%,var(--aurora-control-surface))] px-4 py-3 shadow-[var(--aurora-highlight-medium)]">
      <div className="flex min-w-0 items-center gap-3">
        <CheckCircle2Icon
          aria-hidden="true"
          className="size-4 shrink-0 text-[var(--aurora-success)]"
        />
        <div className="min-w-0">
          <p className="aurora-text-ui text-[var(--aurora-text-primary)]">
            Setup: complete
          </p>
          <p className="aurora-text-meta">
            Baseline provisioning finished for this container.
          </p>
        </div>
      </div>
      <button
        type="button"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--aurora-radius-1)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] text-[var(--aurora-text-muted)] transition-colors hover:border-[var(--aurora-border-strong)] hover:text-[var(--aurora-text-primary)]"
        aria-label="Dismiss setup complete"
        onClick={() => {
          window.localStorage.setItem(storageKey, "true");
          setDismissed(true);
        }}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    </section>
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
  const color =
    tone === "success"
      ? "var(--aurora-success)"
      : tone === "warn"
        ? "var(--aurora-warn)"
        : "var(--aurora-accent-primary)";
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
  const color =
    tone === "rose"
      ? "var(--aurora-accent-pink)"
      : tone === "success"
        ? "var(--aurora-success)"
        : "var(--aurora-accent-primary)";

  return (
    <div className="flex items-center gap-2">
      <Icon aria-hidden="true" className="size-4" style={{ color }} />
      <h2 className="aurora-text-label text-[var(--aurora-text-primary)]">
        {children}
      </h2>
    </div>
  );
}

function WorkspacePane({ workspace: seed }: { workspace: Workspace }) {
  const { workspace, history, lastUpdated, polling, error } =
    useWorkspaceTelemetry(seed);
  const live = isLiveState(workspace.state);

  return (
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
      <WorkspaceCard
        workspace={workspace}
        history={history}
        lastUpdated={lastUpdated}
        polling={polling}
        error={error}
        live={live}
      />
      <WorkspaceInspector workspace={workspace} />
    </div>
  );
}

function WorkspaceCard({
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
    <Card
      accent={false}
      elevated={false}
      className="overflow-hidden"
      style={{
        background: "var(--aurora-panel-medium)",
        borderRadius: 4,
        boxShadow: "none",
      }}
    >
      <CardHeader className="grid gap-4 border-b-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h1" className="truncate">
              {workspace.name}
            </CardTitle>
            <Badge
              tone={stateTone(workspace.state)}
              dot
              pulse={workspace.state === "running"}
            >
              {workspace.state}
            </Badge>
          </div>
          <CardDescription className="aurora-text-code">
            {workspace.incusProject} / {workspace.incusContainer}
          </CardDescription>
        </div>

        <div className="flex flex-col items-start gap-3 lg:items-end">
          <StatusIndicator
            tone={stateStatusTone(workspace.state)}
            label={workspace.state}
          />
          <WorkspaceActions workspace={workspace} />
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-4">
        <WorkspaceTelemetryPanel
          workspace={workspace}
          history={history}
          lastUpdated={lastUpdated}
          polling={polling}
          error={error}
          live={live}
        />

        <WorkspaceFeatures workspace={workspace} />
        <AgentRunDispatch workspace={workspace} />
        <SetupCompleteNotice workspace={workspace} />
        <SetupProgressPanel workspace={workspace} />
      </CardContent>
    </Card>
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
    <section className="space-y-3">
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
  const color =
    tone === "rose"
      ? "var(--aurora-accent-pink)"
      : tone === "success"
        ? "var(--aurora-success)"
        : tone === "warn"
          ? "var(--aurora-warn)"
          : "var(--aurora-accent-primary)";

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

function formatLoadAverage(loadAverage: Workspace["metrics"]["loadAverage"]) {
  if (!loadAverage) return "unknown";
  return loadAverage.map((value) => value.toFixed(2)).join(" / ");
}

function WorkspaceInspector({ workspace }: { workspace: Workspace }) {
  const terminalRoute = workspace.terminalUrl ?? "Not exposed";

  return (
    <aside className="rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] p-4">
      <div className="flex items-start justify-between gap-3">
        <SectionLabel icon={FolderGit2Icon} tone="rose">
          Details
        </SectionLabel>
        <div className="flex flex-wrap justify-end gap-2">
          <DetailChip
            icon={ShieldCheckIcon}
            label="Gate"
            value="Authelia"
            tone="success"
          />
          <DetailChip
            icon={FingerprintIcon}
            label="Privilege"
            value="unprivileged"
          />
          <DetailChip
            icon={SignalIcon}
            label="Signal rule"
            value="enabled"
            tone="success"
          />
          <DetailChip
            icon={DatabaseIcon}
            label="Setup"
            value={setupPhaseLabel(workspace.setup.phase)}
            tone={workspace.setup.phase === "ready" ? "success" : "warn"}
          />
        </div>
      </div>

      <DescriptionList className="mt-3 bg-transparent">
        <DescriptionItem
          label="Image"
          value={workspace.templateVersion}
          active
        />
        <DescriptionItem label="Profile" value={workspace.resourceProfileId} />
        <DescriptionItem
          label="Load average"
          value={formatLoadAverage(workspace.metrics.loadAverage)}
        />
        <DescriptionItem
          label="Terminal"
          value={
            <span className="aurora-text-code text-[var(--aurora-accent-pink-strong)]">
              {terminalRoute}
            </span>
          }
        />
        <DescriptionItem
          label="Dotfiles"
          value={workspace.setup.dotfilesStatus}
          active={workspace.setup.dotfilesStatus === "ok"}
        />
      </DescriptionList>

      <div className="mt-3 border-t border-[var(--aurora-border-default)] pt-3">
        {workspace.accessNote ? (
          <p className="aurora-text-body-sm text-[var(--aurora-text-muted)]">
            {workspace.accessNote}
          </p>
        ) : (
          <p className="aurora-text-meta">Shared access is off by default.</p>
        )}
      </div>
    </aside>
  );
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
  const primaryWorkspace = inventory.workspaces[0];

  return (
    <main className="aurora-page-shell min-h-screen text-[var(--aurora-text-primary)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-3 px-4 py-4 md:px-6 lg:px-8">
        <header className="flex flex-col gap-3 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] px-4 py-3 md:flex-row md:items-center md:justify-between">
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

          <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
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

        <section className="grid gap-4">
          {inventory.workspaces.length > 0 ? (
            inventory.workspaces.map((workspace) => (
              <WorkspacePane
                key={`${workspace.id}:${workspace.createdAt}`}
                workspace={workspace}
              />
            ))
          ) : (
            <EmptyAccessState inventory={inventory} />
          )}
        </section>

      </div>
    </main>
  );
}

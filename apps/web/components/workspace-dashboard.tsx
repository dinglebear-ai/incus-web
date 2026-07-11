"use client";

import {
  BotIcon,
  BoxIcon,
  ChevronRightIcon,
  CircleGaugeIcon,
  CpuIcon,
  DatabaseIcon,
  GitBranchIcon,
  HammerIcon,
  HardDriveIcon,
  InfoIcon,
  LayersIcon,
  MemoryStickIcon,
  NetworkIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { LucideIcon } from "lucide-react";
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";

import {
  CommandPalette,
  type CommandPaletteItem,
} from "@/components/command-palette";
import { WorkspaceActivityRail } from "@/components/workspace-activity-rail";

import { Badge } from "@/components/ui/aurora/badge";
import { Card } from "@/components/ui/aurora/card";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/ui/aurora/description-list";
import { TooltipProvider } from "@/components/ui/aurora/tooltip";
import { GlowDot, PANEL, SUBPANEL } from "@/components/ui/aurora/panel-chrome";
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

type WorkspaceTool = "agents" | "builder" | "settings" | "inspect";
type WorkspaceTab = "overview" | WorkspaceTool;

function stateColor(state: WorkspaceState) {
  if (state === "running") return "var(--aurora-success)";
  if (state === "degraded" || state === "setting_up") return "var(--aurora-warn)";
  if (state === "failed" || state === "deleted") return "var(--aurora-error)";
  if (state === "creating" || state === "starting" || state === "restarting") {
    return "var(--aurora-accent-primary)";
  }
  return "var(--aurora-neutral)";
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

/* ── Shared atoms ──────────────────────────────────────────────────────── */

function StatePill({ state }: { state: WorkspaceState }) {
  const color = stateColor(state);
  return (
    <span
      className="inline-flex items-center gap-2 rounded-[4px] border px-2.5 py-1 text-[12px] font-semibold"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 34%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <GlowDot color={color} size={7} />
      {state.replaceAll("_", " ")}
    </span>
  );
}

function IconTile({
  icon: Icon,
  size = 52,
  accent = "var(--aurora-accent-primary)",
}: {
  icon: LucideIcon;
  size?: number;
  accent?: string;
}) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[6px] border"
      style={{
        width: size,
        height: size,
        color: accent,
        background: `color-mix(in srgb, ${accent} 14%, var(--aurora-control-surface))`,
        borderColor: `color-mix(in srgb, ${accent} 30%, transparent)`,
      }}
    >
      <Icon aria-hidden="true" style={{ width: size * 0.46, height: size * 0.46 }} />
    </span>
  );
}

function HeroChip({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <span
      title={`${label}: ${value}`}
      className={`inline-flex max-w-full items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-[var(--aurora-text-muted)] ${SUBPANEL} rounded-[4px]`}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-85" />
      <span className="shrink-0">{label}</span>
      <span className="truncate font-[family-name:var(--aurora-font-mono)] text-[10.5px] text-[var(--aurora-text-primary)]">
        {value}
      </span>
    </span>
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

/* ── App shell: sidebar ────────────────────────────────────────────────── */

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 26" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M12 1 L20 6 L12 11 L4 6 Z" fill="var(--aurora-accent-primary)" />
      <path d="M12 8 L20 13 L12 18 L4 13 Z" fill="var(--aurora-accent-deep)" />
      <path
        d="M12 15 L20 20 L12 25 L4 20 Z"
        fill="var(--aurora-panel-strong)"
        stroke="var(--aurora-border-strong)"
        strokeWidth="0.5"
      />
    </svg>
  );
}

function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  onSelect,
}: {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  onSelect: (id: string) => void;
}) {
  const running = workspaces.filter((w) => w.state === "running").length;

  return (
    <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-[var(--soft-edge)] bg-[var(--aurora-nav-bg)] lg:flex">
      <div className="flex items-center gap-3 border-b border-[var(--soft-edge)] px-4 py-4">
        <BrandMark />
        <div className="leading-tight">
          <div className="font-[family-name:var(--aurora-font-display)] text-[15px] font-extrabold tracking-[-0.01em] text-[var(--aurora-text-primary)]">
            incus-web
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--aurora-text-muted)]">
            Control plane
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <p className="px-2 pb-2 text-[10.5px] font-bold uppercase tracking-[0.18em] text-[var(--aurora-text-muted)]">
          Workspaces
        </p>
        <div className="space-y-0.5">
          {workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspaceId;
            return (
              <div
                key={workspace.id}
                className="group relative flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 transition-colors"
                style={{
                  background: active
                    ? "color-mix(in srgb, var(--aurora-accent-primary) 13%, transparent)"
                    : undefined,
                }}
              >
                <GlowDot color={stateColor(workspace.state)} />
                <button
                  type="button"
                  onClick={() => onSelect(workspace.id)}
                  className={`min-w-0 flex-1 truncate text-left text-[13px] ${
                    active
                      ? "font-semibold text-[var(--aurora-text-primary)]"
                      : "font-medium text-[var(--aurora-text-muted)] hover:text-[var(--aurora-text-primary)]"
                  }`}
                >
                  {/* stretch the hit target across the row */}
                  <span aria-hidden="true" className="absolute inset-0" />
                  {workspace.name}
                </button>
                {workspace.terminalUrl ? (
                  <a
                    href={workspace.terminalUrl}
                    aria-label={`Open terminal for ${workspace.name}`}
                    className="relative flex size-6 items-center justify-center rounded-[4px] text-[var(--aurora-text-muted)] opacity-0 transition-opacity hover:bg-[var(--aurora-hover-bg)] hover:text-[var(--aurora-accent-strong)] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <TerminalIcon aria-hidden="true" className="size-3.5" />
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-[var(--soft-edge)] px-4 py-3 text-[12px] text-[var(--aurora-text-muted)]">
        <CircleGaugeIcon aria-hidden="true" className="size-3.5" />
        <span>
          {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"} · {running} up
        </span>
      </div>
    </aside>
  );
}

/* ── App shell: header ─────────────────────────────────────────────────── */

function TopBar({
  inventory,
  workspaceName,
  onOpenPalette,
}: {
  inventory: WorkspaceInventory;
  workspaceName?: string;
  onOpenPalette: () => void;
}) {
  const initial = (inventory.actor.displayName ?? inventory.actor.email)
    .charAt(0)
    .toUpperCase();

  return (
    <header className="flex h-[58px] shrink-0 items-center gap-3.5 border-b border-[var(--soft-edge)] bg-[linear-gradient(180deg,rgba(23,50,69,0.32),rgba(16,35,48,0))] px-5 md:px-7">
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--aurora-text-muted)]">
        <span className="flex items-center gap-2 lg:hidden">
          <BrandMark />
        </span>
        <span className="hidden sm:inline">Workspaces</span>
        {workspaceName ? (
          <>
            <ChevronRightIcon aria-hidden="true" className="hidden size-3.5 opacity-60 sm:inline" />
            <span className="truncate font-semibold text-[var(--aurora-text-primary)]">
              {workspaceName}
            </span>
          </>
        ) : null}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Search workspaces, tools, and actions"
        className={`hidden h-[34px] min-w-[230px] items-center gap-2.5 px-3 text-[12.5px] text-[var(--aurora-text-muted)] transition-colors hover:border-[var(--aurora-border-strong)] md:flex ${SUBPANEL} rounded-[5px]`}
      >
        <SearchIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>Search workspace…</span>
        <kbd className="ml-auto rounded-[3px] border border-[var(--soft-edge)] bg-[var(--aurora-nav-bg)] px-1.5 py-0.5 font-sans text-[10.5px]">
          ⌘K
        </kbd>
      </button>

      <span
        className={`hidden items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-[var(--aurora-success)] sm:inline-flex ${SUBPANEL} rounded-[4px]`}
        title="Auth gate: Authelia"
      >
        <ShieldCheckIcon aria-hidden="true" className="size-3.5" />
        Authelia
      </span>

      <div className="flex min-w-0 items-center gap-2.5">
        <div className="min-w-0 text-right leading-tight">
          <p className="truncate text-[12.5px] font-semibold text-[var(--aurora-text-primary)]">
            {inventory.actor.displayName}
          </p>
          <p className="truncate text-[11px] text-[var(--aurora-text-muted)]">
            {inventory.actor.email}
          </p>
        </div>
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--soft-edge)] bg-[var(--aurora-control-surface)] font-[family-name:var(--aurora-font-display)] text-[13px] font-bold text-[var(--aurora-accent-strong)]"
        >
          {initial}
        </span>
      </div>
    </header>
  );
}

/* ── Workspace hero ────────────────────────────────────────────────────── */

function WorkspaceHero({ workspace }: { workspace: Workspace }) {
  const chips: Array<[LucideIcon, string, string]> = [
    [LayersIcon, "Image", workspace.image ?? workspace.templateVersion],
    [CpuIcon, "Profile", workspace.resourceProfileId],
    [NetworkIcon, "Bridge", workspace.networkBridge ?? "unknown"],
  ];

  return (
    <section
      className={`${PANEL} flex flex-col gap-4 p-5 shadow-[var(--aurora-shadow-strong),var(--aurora-highlight-strong)] lg:flex-row lg:items-start`}
    >
      <IconTile icon={BoxIcon} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate font-[family-name:var(--aurora-font-display)] text-[23px] font-extrabold leading-tight tracking-[-0.01em] text-[var(--aurora-text-primary)]">
            {workspace.name}
          </h1>
          <StatePill state={workspace.state} />
        </div>
        <p className="mt-1.5 font-[family-name:var(--aurora-font-mono)] text-[11.5px] text-[var(--aurora-text-muted)]">
          {workspace.incusProject} / {workspace.incusContainer}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {chips.map(([Icon, label, value]) => (
            <HeroChip key={label} icon={Icon} label={label} value={value} />
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-start gap-2.5 lg:items-end">
        <WorkspaceActions workspace={workspace} />
      </div>
    </section>
  );
}

/* ── Tab bar ───────────────────────────────────────────────────────────── */

const TABS: Array<{ id: WorkspaceTab; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: CircleGaugeIcon },
  { id: "agents", label: "Agent runs", icon: BotIcon },
  { id: "builder", label: "Image builder", icon: HammerIcon },
  { id: "settings", label: "Workspace settings", icon: SettingsIcon },
  { id: "inspect", label: "Inspector", icon: InfoIcon },
];

function WorkspaceTabBar({
  activeTab,
  setActiveTab,
}: {
  activeTab: WorkspaceTab;
  setActiveTab: (tab: WorkspaceTab) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-[var(--soft-edge)]">
      {TABS.map(({ id, label, icon: Icon }) => {
        const active = id === activeTab;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => setActiveTab(id)}
            className="-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13px] font-semibold transition-colors"
            style={{
              borderBottomColor: active ? "var(--aurora-accent-primary)" : "transparent",
              color: active
                ? "var(--aurora-text-primary)"
                : "var(--aurora-text-muted)",
            }}
          >
            <Icon
              aria-hidden="true"
              className="size-3.5"
              style={{ color: active ? "var(--aurora-accent-primary)" : undefined }}
            />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Overview panels ───────────────────────────────────────────────────── */

function SetupCheck({ label, status }: { label: string; status: CheckStatus }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--soft-edge)] px-4 py-2.5 last:border-b-0">
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
    <section className={`${PANEL} overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--soft-edge)] px-4 py-3">
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
        <div className="border-t border-[var(--soft-edge)] px-4 py-2.5">
          <p className="aurora-text-meta font-[family-name:var(--aurora-font-mono)]">
            {workspace.setup.lastLogExcerpt}
          </p>
        </div>
      ) : null}
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
    <section className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
      {stops.map((stop) => (
        <div key={stop.label} className={`${PANEL} min-w-0 px-4 py-3`}>
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--aurora-text-muted)]">
            {stop.label}
          </p>
          <StatusIndicator
            className="mt-2 max-w-full"
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
  const { rootDiskUsedBytes, rootDiskLimitBytes } = workspace.metrics;
  const storagePercent =
    rootDiskUsedBytes !== undefined && rootDiskLimitBytes
      ? (rootDiskUsedBytes / rootDiskLimitBytes) * 100
      : undefined;

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
      <div className="grid gap-2.5 lg:grid-cols-3">
        <MetricTile icon={CpuIcon} label="CPU" usedLabel={workspace.resources.cpu} percentValue={cpuPercent} tone="info">
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
          percentValue={storagePercent}
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
    <div className={`${PANEL} min-w-0 p-4`}>
      <div className="mb-2.5 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--aurora-text-muted)]">
        <Icon aria-hidden="true" className="size-3.5" />
        {label}
      </div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-[family-name:var(--aurora-font-display)] text-[23px] font-bold leading-none tracking-[-0.02em] text-[var(--aurora-text-primary)] [font-variant-numeric:tabular-nums]">
          {percentValue !== undefined ? `${Math.round(percentValue)}%` : "—"}
        </span>
      </div>
      <MetricBar
        label={label}
        usedLabel={usedLabel}
        percentValue={percentValue}
        tone={tone}
      />
      {children ? <div className="mt-2.5">{children}</div> : null}
    </div>
  );
}

function CompactSignal({
  icon: Icon,
  label,
  value,
  badge,
  tone,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  badge: string;
  tone: "success" | "warn";
  href?: string;
}) {
  const color = tone === "success" ? "var(--aurora-success)" : "var(--aurora-warn)";
  const content = (
    <>
      <IconTile icon={Icon} size={36} accent={color} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className="aurora-text-ui text-[var(--aurora-text-primary)]">
            {label}
          </p>
          <Badge tone={tone} shape="tag">
            {badge}
          </Badge>
        </div>
        <p className="mt-0.5 truncate aurora-text-meta">{value}</p>
      </div>
    </>
  );

  const className = `${PANEL} grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 p-3.5 ${
    href
      ? "transition-colors hover:border-[color-mix(in_srgb,var(--aurora-accent-primary)_38%,var(--aurora-border-strong))]"
      : ""
  }`;

  if (href) {
    return (
      <a className={className} href={href}>
        {content}
      </a>
    );
  }

  return <div className={className}>{content}</div>;
}

function WorkspaceAccessStrip({ workspace }: { workspace: Workspace }) {
  return (
    <section className="grid gap-2.5 md:grid-cols-2">
      <CompactSignal
        icon={TerminalIcon}
        label="Terminal"
        value={workspace.terminalUrl ? workspace.terminalUrl : "Route pending"}
        badge={workspace.terminalUrl ? "live" : "pending"}
        tone={workspace.terminalUrl ? "success" : "warn"}
        href={workspace.terminalUrl}
      />
      <CompactSignal
        icon={GitBranchIcon}
        label="Dotfiles"
        value="Setup-managed user state"
        badge={workspace.setup.dotfilesStatus}
        tone={workspace.setup.dotfilesStatus === "ok" ? "success" : "warn"}
      />
    </section>
  );
}

/* ── Tab content ───────────────────────────────────────────────────────── */

function WorkspaceOverview({
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
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid min-w-0 gap-4">
        <ReadinessRunway workspace={workspace} />
        <WorkspaceTelemetryPanel
          workspace={workspace}
          history={history}
          lastUpdated={lastUpdated}
          polling={polling}
          error={error}
          live={live}
        />
        <WorkspaceAccessStrip workspace={workspace} />
        <SetupProgressPanel workspace={workspace} />
      </div>
      <WorkspaceActivityRail workspace={workspace} />
    </div>
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

function WorkspacePane({
  workspace: seed,
  activeTab,
  setActiveTab,
}: {
  workspace: Workspace;
  activeTab: WorkspaceTab;
  setActiveTab: (tab: WorkspaceTab) => void;
}) {
  const { workspace, history, lastUpdated, polling, error } =
    useWorkspaceTelemetry(seed);
  const live = isLiveState(workspace.state);

  return (
    <div className="grid min-w-0 gap-4">
      <WorkspaceHero workspace={workspace} />
      <WorkspaceTabBar activeTab={activeTab} setActiveTab={setActiveTab} />
      {activeTab === "overview" ? (
        <WorkspaceOverview
          workspace={workspace}
          history={history}
          lastUpdated={lastUpdated}
          polling={polling}
          error={error}
          live={live}
        />
      ) : (
        <div className="min-w-0">
          <ActiveToolPanel workspace={workspace} activeTool={activeTab} />
        </div>
      )}
    </div>
  );
}

/* ── Empty / error states ──────────────────────────────────────────────── */

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

/* ── Dashboard shell ───────────────────────────────────────────────────── */

export function WorkspaceDashboard({
  inventory,
}: {
  inventory: WorkspaceInventory;
}) {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(
    inventory.workspaces[0]?.id,
  );
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const primaryWorkspace = activeWorkspace(inventory.workspaces, activeWorkspaceId);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const paletteItems: CommandPaletteItem[] = [
    ...inventory.workspaces.map((workspace) => ({
      id: `workspace:${workspace.id}`,
      title: workspace.name,
      sub: `${workspace.incusProject} / ${workspace.incusContainer} · ${workspace.state.replaceAll("_", " ")}`,
      kind: "workspace",
      icon: BoxIcon,
      accent: stateColor(workspace.state),
      run: () => {
        setActiveWorkspaceId(workspace.id);
        setActiveTab("overview");
      },
    })),
    ...(primaryWorkspace
      ? TABS.map((tab) => ({
          id: `tab:${tab.id}`,
          title: tab.label,
          sub: `Jump to ${tab.label.toLowerCase()} for ${primaryWorkspace.name}`,
          kind: "view",
          icon: tab.icon,
          accent: "var(--aurora-accent-primary)",
          run: () => setActiveTab(tab.id),
        }))
      : []),
    ...(primaryWorkspace?.terminalUrl
      ? [
          {
            id: "action:terminal",
            title: "Open terminal",
            sub: primaryWorkspace.terminalUrl,
            kind: "action",
            icon: TerminalIcon,
            accent: "var(--aurora-success)",
            run: () => window.location.assign(primaryWorkspace.terminalUrl!),
          },
        ]
      : []),
  ];

  return (
    <main className="aurora-page-shell flex min-h-screen text-[var(--aurora-text-primary)]">
      <TooltipProvider>
        <WorkspaceSidebar
          workspaces={inventory.workspaces}
          activeWorkspaceId={primaryWorkspace?.id}
          onSelect={(id) => {
            setActiveWorkspaceId(id);
            setActiveTab("overview");
          }}
        />

        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <TopBar
            inventory={inventory}
            workspaceName={primaryWorkspace?.name}
            onOpenPalette={() => setPaletteOpen(true)}
          />

          <div className="min-w-0 flex-1 overflow-x-hidden">
            <div className="mx-auto w-full max-w-[1240px] px-4 py-5 md:px-7 md:py-6">
              {inventory.workspaces.length > 0 ? (
                primaryWorkspace ? (
                  <WorkspacePane
                    key={`${primaryWorkspace.id}:${primaryWorkspace.createdAt}`}
                    workspace={primaryWorkspace}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                  />
                ) : null
              ) : (
                <EmptyAccessState inventory={inventory} />
              )}
            </div>
          </div>
        </div>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          items={paletteItems}
        />
      </TooltipProvider>
    </main>
  );
}

function activeWorkspace(workspaces: Workspace[], activeWorkspaceId: string | undefined) {
  return workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
}

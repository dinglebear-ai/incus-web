"use client";

import { ActivityIcon } from "lucide-react";
import * as React from "react";

import { Progress } from "@/components/ui/aurora/progress";
import type { Workspace, WorkspaceMetrics } from "@/lib/workspaces/types";

const POLL_INTERVAL_MS = 4000;
const HISTORY_LENGTH = 30;

type Sample = {
  at: number;
  cpuPercent?: number;
  memoryPercent?: number;
};

type TelemetryState = {
  workspace: Workspace;
  history: Sample[];
  lastUpdated: number;
  polling: boolean;
  error?: string;
};

function percent(used: number | undefined, limit: number | undefined) {
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return Math.min(100, Math.round((used / limit) * 100));
}

// Load average is unbounded, but for a small `cpuCount`-relative bar we treat
// "one full core busy per logical CPU" as 100% — a load average of cpuCount
// means the box is fully loaded, matching how `uptime`/`top` are normally read.
function loadPercent(metrics: WorkspaceMetrics) {
  const load1 = metrics.loadAverage?.[0];
  if (load1 === undefined || !metrics.cpuCount) return undefined;
  return Math.min(100, Math.round((load1 / metrics.cpuCount) * 100));
}

function isLiveState(state: Workspace["state"]) {
  return (
    state === "running" ||
    state === "starting" ||
    state === "restarting" ||
    state === "setting_up" ||
    state === "degraded"
  );
}

// Polls `GetWorkspaceStatus` on an interval and keeps a short in-session
// history of CPU/memory samples so the dashboard can show a live trend
// instead of a single static snapshot. History resets on page reload by
// design for this slice — server-persisted history (PORTING_PLAN.md §3.1)
// is a larger, separate change (a ring-buffer table + Map-keyed status
// cache in provisioner-server.mjs) left for a later pass.
export function useWorkspaceTelemetry(initial: Workspace): TelemetryState {
  const [workspace, setWorkspace] = React.useState(initial);
  const [history, setHistory] = React.useState<Sample[]>(() => [
    sampleFrom(initial, Date.now()),
  ]);
  const [lastUpdated, setLastUpdated] = React.useState(() => Date.now());
  const [polling, setPolling] = React.useState(false);
  const [error, setError] = React.useState<string>();

  // Re-seed local state when the identity of the workspace we're tracking
  // changes (e.g. switching panes), without a setState-in-effect cascade:
  // adjust state directly during render per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  // `lastUpdated` is intentionally left alone here (render must stay pure —
  // no `Date.now()`) and instead re-anchors itself off the next poll tick,
  // which fires within POLL_INTERVAL_MS of the reset.
  const [trackedWorkspaceId, setTrackedWorkspaceId] = React.useState(
    initial.id,
  );
  if (initial.id !== trackedWorkspaceId) {
    setTrackedWorkspaceId(initial.id);
    setWorkspace(initial);
    setHistory([sampleFrom(initial, 0)]);
  }

  const poll = React.useCallback(async () => {
    setPolling(true);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/status`, {
        headers: { "Cache-Control": "no-store" },
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true || !body.workspace) {
        throw new Error(
          body?.error?.message ?? "failed to refresh workspace telemetry",
        );
      }
      const next = body.workspace as Workspace;
      const polledAt = Date.now();
      setWorkspace(next);
      setHistory((current) =>
        [...current, sampleFrom(next, polledAt)].slice(-HISTORY_LENGTH),
      );
      setLastUpdated(polledAt);
      setError(undefined);
    } catch (pollError) {
      setError(
        pollError instanceof Error
          ? pollError.message
          : "failed to refresh workspace telemetry",
      );
    } finally {
      setPolling(false);
    }
  }, [workspace.id]);

  React.useEffect(() => {
    if (!isLiveState(workspace.state)) return;
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [poll, workspace.state]);

  return { workspace, history, lastUpdated, polling, error };
}

function sampleFrom(workspace: Workspace, at: number): Sample {
  return {
    at,
    cpuPercent: loadPercent(workspace.metrics),
    memoryPercent: percent(
      workspace.metrics.memoryUsedBytes,
      workspace.metrics.memoryLimitBytes,
    ),
  };
}

export function TelemetryFreshness({
  lastUpdated,
  polling,
  live,
}: {
  lastUpdated: number;
  polling: boolean;
  live: boolean;
}) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const secondsAgo = Math.max(0, Math.round((now - lastUpdated) / 1000));
  const label = !live
    ? "not polling"
    : polling
      ? "refreshing…"
      : secondsAgo <= 1
        ? "updated just now"
        : `updated ${secondsAgo}s ago`;

  return (
    <span className="inline-flex items-center gap-1.5 aurora-text-meta">
      <ActivityIcon
        aria-hidden="true"
        className={`size-3 ${live ? "text-[var(--aurora-success)]" : "text-[var(--aurora-text-muted)]"}`}
      />
      {label}
    </span>
  );
}

export function Sparkline({
  history,
  metric,
  tone = "var(--aurora-accent-primary)",
}: {
  history: Sample[];
  metric: "cpuPercent" | "memoryPercent";
  tone?: string;
}) {
  const points = history
    .map((sample) => sample[metric])
    .filter((value): value is number => value !== undefined);

  if (points.length < 2) {
    return (
      <div className="flex h-8 items-center">
        <span className="aurora-text-caption text-[var(--aurora-text-muted)]">
          collecting samples…
        </span>
      </div>
    );
  }

  const width = 100;
  const height = 28;
  const max = Math.max(100, ...points);
  const coords = points
    .map((value, index) => {
      const x = points.length === 1 ? 0 : (index / (points.length - 1)) * width;
      const y = height - (value / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-8 w-full"
      role="img"
      aria-label={`${metric === "cpuPercent" ? "CPU" : "Memory"} trend, last ${points.length} samples`}
    >
      <polyline
        points={coords}
        fill="none"
        stroke={tone}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MetricBar({
  label,
  usedLabel,
  percentValue,
  tone,
}: {
  label: string;
  usedLabel: string;
  percentValue: number | undefined;
  tone: "info" | "success" | "warn";
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="aurora-text-ui text-[var(--aurora-text-muted)]">
          {label}
        </span>
        <span className="aurora-text-code text-[var(--aurora-text-primary)]">
          {usedLabel}
        </span>
      </div>
      <Progress
        value={percentValue}
        indeterminate={percentValue === undefined}
        variant={
          percentValue !== undefined && percentValue >= 90
            ? "error"
            : percentValue !== undefined && percentValue >= 75
              ? "warn"
              : tone === "success"
                ? "default"
                : tone === "warn"
                  ? "warn"
                  : "default"
        }
        size="sm"
      />
    </div>
  );
}

"use client";

import { ActivityIcon } from "lucide-react";
import * as React from "react";

import { Progress } from "@/components/ui/aurora/progress";
import type { Workspace, WorkspaceMetrics } from "@/lib/workspaces/types";

const POLL_INTERVAL_MS = 4000;
const HISTORY_LENGTH = 30;

export type Sample = {
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

export function isLiveState(state: Workspace["state"]) {
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
    sampleFrom(initial),
  ]);
  const [lastUpdated, setLastUpdated] = React.useState(() => Date.now());
  const [polling, setPolling] = React.useState(false);
  const [error, setError] = React.useState<string>();

  // No re-seed-on-identity-change logic here: the caller mounts one
  // `WorkspacePane` per workspace keyed by `${workspace.id}:${createdAt}`
  // (see workspace-dashboard.tsx), so a change in tracked workspace always
  // remounts this hook from scratch rather than reusing the instance. A
  // separate re-seed branch would be unreachable dead code that could only
  // race an in-flight poll response against a reset it can never trigger.

  // Guards against overlapping ticks: if a request outlives POLL_INTERVAL_MS
  // (slow provisioner, network hiccup), the next interval fire is skipped
  // rather than racing a second in-flight fetch for the same workspace.
  const inFlightRef = React.useRef(false);

  const poll = React.useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
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
      setHistory(Array.isArray(body.history) ? body.history : (current) =>
        [...current, sampleFrom(next)].slice(-HISTORY_LENGTH),
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
      inFlightRef.current = false;
      setPolling(false);
    }
  }, [workspace.id]);

  React.useEffect(() => {
    if (!isLiveState(workspace.state)) return;

    // Pause polling while the tab is hidden — modern browsers throttle but
    // don't stop background `setInterval` timers, so a backgrounded
    // dashboard tab would otherwise keep polling the backend indefinitely
    // for a view nobody is looking at.
    let timer: number | undefined;
    const start = () => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        void poll();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [poll, workspace.state]);

  return { workspace, history, lastUpdated, polling, error };
}

function sampleFrom(workspace: Workspace): Sample {
  return {
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
  const label = freshnessLabel({ live, polling, secondsAgo });

  return (
    <span className="hidden items-center gap-1.5 aurora-text-meta sm:inline-flex">
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
      <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <span className="min-w-0 truncate aurora-text-ui text-[var(--aurora-text-muted)]">
          {label}
        </span>
        <span className="min-w-0 break-words aurora-text-code text-[var(--aurora-text-primary)] sm:text-right">
          {usedLabel}
        </span>
      </div>
      <Progress
        value={percentValue}
        indeterminate={percentValue === undefined}
        variant={progressVariant(percentValue, tone)}
        size="sm"
      />
    </div>
  );
}

function freshnessLabel({
  live,
  polling,
  secondsAgo,
}: {
  live: boolean;
  polling: boolean;
  secondsAgo: number;
}) {
  if (!live) return "not polling";
  if (polling) return "refreshing…";
  if (secondsAgo <= 1) return "updated just now";
  return `updated ${secondsAgo}s ago`;
}

function progressVariant(
  percentValue: number | undefined,
  tone: "info" | "success" | "warn",
) {
  if (percentValue !== undefined && percentValue >= 90) return "error";
  if (percentValue !== undefined && percentValue >= 75) return "warn";
  return tone === "warn" ? "warn" : "default";
}

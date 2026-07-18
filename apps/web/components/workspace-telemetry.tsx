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
  // Prefer the push stream; fall back to interval polling where EventSource
  // is unavailable (jsdom, very old browsers) or once the stream errors.
  const [transport, setTransport] = React.useState<"sse" | "poll">(() =>
    typeof window !== "undefined" && typeof window.EventSource !== "undefined"
      ? "sse"
      : "poll",
  );

  // Guards against overlapping ticks: if a request outlives POLL_INTERVAL_MS
  // (slow provisioner, network hiccup), the next interval fire is skipped
  // rather than racing a second in-flight fetch for the same workspace.
  const inFlightRef = React.useRef(false);
  const pollControllerRef = React.useRef<AbortController | undefined>(
    undefined,
  );
  const requestGenerationRef = React.useRef(0);
  const initialSignature = JSON.stringify(initial);
  const workspaceSignature = JSON.stringify(workspace);
  const previousInitialSignatureRef = React.useRef(initialSignature);
  const trackedWorkspaceIdRef = React.useRef(initial.id);

  const abortPoll = React.useCallback(() => {
    pollControllerRef.current?.abort();
    pollControllerRef.current = undefined;
    inFlightRef.current = false;
  }, []);

  // `router.refresh()` can deliver a newer server snapshot without remounting
  // WorkspacePane. Reconcile genuinely changed snapshots, including stopped
  // -> live transitions, and invalidate any response started from the older
  // snapshot so it cannot overwrite the refreshed state.
  React.useEffect(() => {
    if (previousInitialSignatureRef.current === initialSignature) return;

    previousInitialSignatureRef.current = initialSignature;
    // The parent shell mirrors live telemetry so its sidebar and palette stay
    // current. When that same snapshot comes back as `initial`, it is an echo,
    // not a new server refresh; avoid duplicating the sample in history.
    if (workspaceSignature === initialSignature) return;

    requestGenerationRef.current += 1;
    abortPoll();

    const identityChanged = trackedWorkspaceIdRef.current !== initial.id;
    const timer = window.setTimeout(() => {
      trackedWorkspaceIdRef.current = initial.id;
      setWorkspace(initial);
      setHistory((current) =>
        identityChanged
          ? [sampleFrom(initial)]
          : [...current, sampleFrom(initial)].slice(-HISTORY_LENGTH),
      );
      setLastUpdated(Date.now());
      setPolling(false);
      setError(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [abortPoll, initial, initialSignature, workspaceSignature]);

  const poll = React.useCallback(async () => {
    if (inFlightRef.current) return;

    const controller = new AbortController();
    const generation = requestGenerationRef.current;
    inFlightRef.current = true;
    pollControllerRef.current = controller;
    setPolling(true);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/status`, {
        headers: { "Cache-Control": "no-store" },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (
        controller.signal.aborted ||
        requestGenerationRef.current !== generation
      ) {
        return;
      }
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
      if (
        controller.signal.aborted ||
        requestGenerationRef.current !== generation
      ) {
        return;
      }
      setError(
        pollError instanceof Error
          ? pollError.message
          : "failed to refresh workspace telemetry",
      );
    } finally {
      if (pollControllerRef.current === controller) {
        pollControllerRef.current = undefined;
        inFlightRef.current = false;
        setPolling(false);
      }
    }
  }, [workspace.id]);

  // Live push transport: the status/events SSE route emits a `status` frame
  // every few seconds server-side, so the dashboard reflects lifecycle
  // changes without client-side polling. Application-level `error` frames
  // (provisioner op failures) surface as telemetry errors; a transport-level
  // failure downgrades to the polling path below for the rest of the session.
  React.useEffect(() => {
    if (transport !== "sse") return;
    if (!isLiveState(workspace.state)) return;

    let source: EventSource | undefined;
    const onStatus = (event: MessageEvent) => {
      try {
        const next = JSON.parse(event.data) as Workspace;
        setWorkspace(next);
        setHistory((current) =>
          [...current, sampleFrom(next)].slice(-HISTORY_LENGTH),
        );
        setLastUpdated(Date.now());
        setError(undefined);
      } catch {
        // Malformed frame — keep the stream, wait for the next one.
      }
    };
    const onErrorFrame = (event: Event) => {
      const data = (event as MessageEvent).data;
      if (typeof data === "string") {
        // Server-sent application error frame (provisioner op failed).
        try {
          setError(
            JSON.parse(data)?.message ?? "failed to refresh workspace telemetry",
          );
        } catch {
          setError("failed to refresh workspace telemetry");
        }
        return;
      }
      // Transport failure — close and downgrade to polling.
      disconnect();
      setTransport("poll");
    };
    const disconnect = () => {
      if (!source) return;
      source.removeEventListener("status", onStatus);
      source.removeEventListener("error", onErrorFrame);
      source.close();
      source = undefined;
    };
    const connect = () => {
      if (source || document.hidden) return;
      source = new EventSource(`/api/workspaces/${workspace.id}/status/events`);
      source.addEventListener("status", onStatus);
      source.addEventListener("error", onErrorFrame);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) disconnect();
      else connect();
    };

    connect();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      disconnect();
    };
  }, [transport, workspace.id, workspace.state]);

  React.useEffect(() => {
    if (transport !== "poll") return;
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
      abortPoll();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [abortPoll, poll, transport, workspace.state]);

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
  const gradientId = React.useId();
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
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.26" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,${height} ${coords} ${width},${height}`}
        fill={`url(#${gradientId})`}
      />
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

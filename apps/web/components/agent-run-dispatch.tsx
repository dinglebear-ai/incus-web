"use client";

import {
  BotIcon,
  ClockIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { Badge } from "@/components/ui/aurora/badge";
import { Button } from "@/components/ui/aurora/button";
import { Field } from "@/components/ui/aurora/field";
import { Input } from "@/components/ui/aurora/input";
import { NativeSelect } from "@/components/ui/aurora/native-select";
import { Textarea } from "@/components/ui/aurora/textarea";
import {
  normalizeAgentRepoInput,
  type AgentRun,
  type AgentRunAgent,
} from "@/lib/provisioner/contracts";
import type { Workspace } from "@/lib/workspaces/types";

type FormState = {
  agent: AgentRunAgent;
  repoUrl: string;
  ref: string;
  task: string;
};

type RunLogEntry = NonNullable<AgentRun["logs"]>[number];

const emptyForm: FormState = {
  agent: "codex",
  repoUrl: "",
  ref: "",
  task: "",
};

export function AgentRunDispatch({ workspace }: { workspace: Workspace }) {
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [runs, setRuns] = React.useState<AgentRun[]>([]);
  const [loadingRuns, setLoadingRuns] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [selectedRunId, setSelectedRunId] = React.useState<string>();
  const sessionPanelRef = React.useRef<HTMLDivElement>(null);

  const active = runs.some(isRunLive);
  const selectedRun = selectedRunId
    ? runs.find((run) => run.id === selectedRunId)
    : undefined;
  const displayRun = selectedRun ?? runs[0];

  const refreshRuns = React.useCallback(async () => {
    setLoadingRuns(true);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/agent-runs`, {
        headers: { "Cache-Control": "no-store" },
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(
          body?.operation?.error?.message ??
            body?.error?.message ??
            "failed to load agent runs",
        );
      }
      setRuns(Array.isArray(body.runs) ? body.runs : []);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "failed to load agent runs",
      );
    } finally {
      setLoadingRuns(false);
    }
  }, [workspace.id]);

  React.useEffect(() => {
    void Promise.resolve().then(refreshRuns);
  }, [refreshRuns]);

  React.useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void refreshRuns();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [active, refreshRuns]);

  React.useEffect(() => {
    if (!selectedRunId) return;
    const frame = window.requestAnimationFrame(() => {
      sessionPanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedRunId]);

  async function submitRun(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const repoUrl = normalizeAgentRepoInput(form.repoUrl);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/agent-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: form.agent,
          repoUrl,
          task: form.task,
          ...(form.ref.trim() ? { ref: form.ref } : {}),
        }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(
          body?.operation?.error?.message ??
            body?.error?.message ??
            "failed to dispatch agent run",
        );
      }
      if (!body.run || typeof body.run.id !== "string") {
        throw new Error("agent run response was invalid");
      }
      setRuns((current) => [
        body.run,
        ...current.filter((run) => run.id !== body.run.id),
      ]);
      setSelectedRunId(body.run.id);
      setForm(emptyForm);
      void refreshRuns();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "failed to dispatch agent run",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--aurora-border-default)] px-4 py-3">
        <div className="flex items-center gap-2">
          <BotIcon
            aria-hidden="true"
            className="size-4 text-[var(--aurora-accent-primary)]"
          />
          <h2 className="aurora-text-label text-[var(--aurora-text-primary)]">
            Agent runs
          </h2>
        </div>
        <Button
          type="button"
          size="sm"
          variant="neutral"
          iconLeft={<RefreshCwIcon aria-hidden="true" className="size-3.5" />}
          loading={loadingRuns}
          onClick={() => void refreshRuns()}
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <p className="border-b border-[var(--aurora-border-default)] px-4 py-2 aurora-text-body text-[var(--aurora-error)]">
          {error}
        </p>
      ) : null}

      <div className="grid gap-0 2xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <form
          className="space-y-3 border-b border-[var(--aurora-border-default)] p-4 2xl:border-b-0 2xl:border-r"
          onSubmit={submitRun}
        >
          <Field htmlFor="agent-run-agent" label="Agent">
            <NativeSelect
              id="agent-run-agent"
              value={form.agent}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  agent: event.target.value as AgentRunAgent,
                }))
              }
            >
              <option value="codex">Codex app-server</option>
              <option value="claude">Claude CLI-template</option>
            </NativeSelect>
          </Field>
          <Field htmlFor="agent-run-repo" label="Repo URL" required>
            <Input
              id="agent-run-repo"
              value={form.repoUrl}
              placeholder="jmagar/incus-web or https://github.com/org/repo"
              onChange={(event) =>
                setForm((current) => ({ ...current, repoUrl: event.target.value }))
              }
              required
            />
          </Field>
          <Field htmlFor="agent-run-ref" label="Branch/ref">
            <Input
              id="agent-run-ref"
              value={form.ref}
              placeholder="optional"
              onChange={(event) =>
                setForm((current) => ({ ...current, ref: event.target.value }))
              }
            />
          </Field>
          <Field htmlFor="agent-run-task" label="Task" required>
            <Textarea
              id="agent-run-task"
              autoGrow
              value={form.task}
              onChange={(event) =>
                setForm((current) => ({ ...current, task: event.target.value }))
              }
              required
            />
          </Field>
          <Button
            type="submit"
            iconLeft={<SendIcon aria-hidden="true" className="size-3.5" />}
            loading={submitting}
            disabled={submitting}
          >
            Dispatch run
          </Button>
        </form>

        <div className="grid min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <div ref={sessionPanelRef}>
            <AgentRunSessionViewer run={displayRun} />
          </div>

          <div className="min-w-0 border-t border-[var(--aurora-border-default)]">
            <div className="flex items-center justify-between border-b border-[var(--aurora-border-default)] px-4 py-3">
              <p className="aurora-text-label text-[var(--aurora-text-primary)]">
                Queue
              </p>
              <span className="aurora-text-meta">{runs.length} runs</span>
            </div>
            {runs.length === 0 ? (
              <div className="m-4 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-4">
                <p className="aurora-text-ui">No agent runs yet</p>
              </div>
            ) : (
              <div className="max-h-96 overflow-auto">
                {runs.map((run) => (
                  <AgentRunRow
                    key={run.id}
                    run={run}
                    workspaceId={workspace.id}
                    selected={run.id === displayRun?.id}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function AgentRunRow({
  run,
  workspaceId,
  selected,
}: {
  run: AgentRun;
  workspaceId: string;
  selected: boolean;
}) {
  const outputEntry = runOutputEntries(run).at(-1);

  return (
    <Link
      aria-current={selected ? "page" : undefined}
      aria-label={`Open full session viewer for ${run.id}`}
      className={`grid cursor-pointer gap-2 border-b border-l-[3px] border-b-[var(--aurora-border-default)] p-3 text-left transition-colors hover:bg-[var(--aurora-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aurora-accent-primary)] ${
        selected
          ? "border-l-[var(--aurora-accent-primary)] bg-[color-mix(in_srgb,var(--aurora-accent-primary)_9%,var(--aurora-control-surface))]"
          : "border-l-transparent bg-[var(--aurora-control-surface)]"
      }`}
      href={`/workspaces/${workspaceId}/agent-runs/${run.id}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="aurora-text-code truncate text-[var(--aurora-text-primary)]">
            {run.id}
          </p>
          <p className="mt-1 line-clamp-2 aurora-text-body text-[var(--aurora-text-primary)]">
            {run.task}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={toneForStatus(run.status)} shape="tag">
            {run.status}
          </Badge>
          <ExternalLinkIcon
            aria-hidden="true"
            className="size-3.5 text-[var(--aurora-text-muted)]"
          />
        </div>
      </div>

      <div className="grid gap-1 aurora-text-body text-[var(--aurora-text-muted)]">
        <span className="truncate">
          {run.agent} / {run.phase} / {run.repoUrl}
        </span>
        <span className="truncate">
          {run.container.project}/{run.container.name}
        </span>
      </div>

      {outputEntry ? (
        <p className="truncate aurora-text-caption text-[var(--aurora-text-muted)]">
          {formatTime(outputEntry.at)} {outputEntry.level}: {outputEntry.message}
        </p>
      ) : null}
    </Link>
  );
}

export function AgentRunSessionViewer({ run }: { run?: AgentRun }) {
  if (!run) {
    return (
      <div className="grid min-h-36 place-items-center p-4">
        <div className="rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-4 text-center">
          <p className="aurora-text-ui">No session selected</p>
        </div>
      </div>
    );
  }

  const outputEntries = runOutputEntries(run);
  const live = isRunLive(run);

  return (
    <div className="flex min-h-0 flex-col bg-[color-mix(in_srgb,var(--aurora-page-bg)_68%,var(--aurora-panel-medium))]">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--aurora-border-default)] px-4 py-3">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone={live ? "warn" : toneForStatus(run.status)} shape="tag">
              {live ? "live" : run.status}
            </Badge>
            <h3 className="aurora-text-label text-[var(--aurora-text-primary)]">
              Session viewer
            </h3>
            <span className="aurora-text-code break-all text-[var(--aurora-text-muted)]">
              {run.id}
            </span>
          </div>
          <p className="break-words aurora-text-body text-[var(--aurora-text-muted)]">
            {run.agent} / {run.phase} / {run.repoUrl}
          </p>
        </div>
        <div className="flex items-start gap-2">
          <GitBranchIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--aurora-accent-pink)]"
          />
          <div className="text-right">
            <p className="aurora-text-meta">{run.ref || "default ref"}</p>
            <p className="aurora-text-meta">{formatDate(run.updatedAt)}</p>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 overflow-auto p-4">
        <div className="min-w-0 space-y-3">
          <div className="rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
            <p className="aurora-text-meta mb-1">Task</p>
            <p className="whitespace-pre-wrap break-words aurora-text-body text-[var(--aurora-text-primary)]">
              {run.task}
            </p>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-1.5 text-[var(--aurora-text-muted)]">
              <ClockIcon aria-hidden="true" className="size-3.5" />
              <span className="aurora-text-meta">Run log</span>
            </div>
            <RunLogList
              entries={outputEntries}
              className="max-h-80 min-h-56"
              rowClassName="md:grid-cols-[9rem_4.5rem_minmax(0,1fr)]"
            />
          </div>
        </div>

        <RunDetailsList run={run} className="md:grid-cols-2" />
      </div>
    </div>
  );
}

export function AgentRunFullSessionViewer({
  run,
  autoTail = true,
}: {
  run: AgentRun;
  autoTail?: boolean;
}) {
  const outputEntries = runOutputEntries(run);
  const live = isRunLive(run);
  const tailRef = React.useRef<HTMLLIElement>(null);

  React.useEffect(() => {
    if (!autoTail) return;
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [autoTail, outputEntries.length, run.updatedAt]);

  return (
    <section className="flex min-h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)]">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--aurora-border-default)] px-5 py-4">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone={live ? "warn" : toneForStatus(run.status)} shape="tag">
              {live ? "live" : run.status}
            </Badge>
            <h1 className="aurora-text-section text-[var(--aurora-text-primary)]">
              Session viewer
            </h1>
          </div>
          <p className="aurora-text-code break-all text-[var(--aurora-text-muted)]">
            {run.id}
          </p>
          <p className="break-words aurora-text-body text-[var(--aurora-text-muted)]">
            {run.agent} / {run.phase} / {run.repoUrl}
          </p>
        </div>
        <div className="text-right">
          <p className="aurora-text-meta">{run.ref || "default ref"}</p>
          <p className="aurora-text-meta">{formatDate(run.updatedAt)}</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-h-0 flex-col gap-3">
          <div className="rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
            <p className="aurora-text-meta mb-1">Task</p>
            <p className="whitespace-pre-wrap break-words aurora-text-body text-[var(--aurora-text-primary)]">
              {run.task}
            </p>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--aurora-border-default)] pb-2">
              <div className="flex items-center gap-1.5 text-[var(--aurora-text-muted)]">
                <ClockIcon aria-hidden="true" className="size-3.5" />
                <span className="aurora-text-meta">Full run log</span>
              </div>
              <span className="aurora-text-meta">
                {outputEntries.length} entries
              </span>
            </div>
            <ol className="min-h-0 flex-1 overflow-auto rounded-b-[4px] border-x border-b border-[var(--aurora-border-default)] bg-[color-mix(in_srgb,var(--aurora-page-bg)_88%,black)] p-3 text-xs leading-5">
              <RunLogEntries
                entries={outputEntries}
                rowClassName="gap-2 lg:grid-cols-[9rem_5rem_minmax(0,1fr)]"
              />
              <li ref={tailRef} aria-hidden="true" className="h-px" />
            </ol>
          </div>
        </div>

        <RunDetailsList run={run} className="sm:grid-cols-2 xl:grid-cols-1" />
      </div>
    </section>
  );
}

function RunLogList({
  entries,
  className,
  rowClassName,
}: {
  entries: RunLogEntry[];
  className: string;
  rowClassName: string;
}) {
  return (
    <ol className={`${className} overflow-auto rounded-[4px] border border-[var(--aurora-border-default)] bg-[color-mix(in_srgb,var(--aurora-page-bg)_88%,black)] p-3 text-xs leading-5`}>
      <RunLogEntries entries={entries} rowClassName={`gap-1 ${rowClassName}`} />
    </ol>
  );
}

function RunLogEntries({
  entries,
  rowClassName,
}: {
  entries: RunLogEntry[];
  rowClassName: string;
}) {
  if (entries.length === 0) {
    return <li className="text-[var(--aurora-text-muted)]">No run log yet</li>;
  }

  return entries.map((entry, index) => (
    <li
      key={`${entry.at}-${index}`}
      className={`grid border-b border-[var(--aurora-border-default)] py-2 last:border-b-0 first:pt-0 last:pb-0 ${rowClassName}`}
    >
      <span className="aurora-text-code text-[var(--aurora-text-muted)]">
        {formatTime(entry.at)}
      </span>
      <span className="aurora-text-code text-[var(--aurora-text-muted)]">
        {entry.level}
      </span>
      <span className="whitespace-pre-wrap break-words text-[var(--aurora-text-primary)]">
        {entry.message}
      </span>
    </li>
  ));
}

function RunDetailsList({
  run,
  className,
}: {
  run: AgentRun;
  className: string;
}) {
  return (
    <dl className={`grid content-start gap-3 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3 aurora-text-body ${className}`}>
      <RunDetail label="Status" value={`${run.status} / ${run.phase}`} />
      <RunDetail
        label="Container"
        value={`${run.container.project}/${run.container.name}`}
      />
      <RunDetail
        label="Source"
        value={`${run.container.sourceProject}/${run.container.sourceContainer}`}
      />
      <RunDetail label="Container state" value={run.container.state} />
      <RunDetail label="Controller" value={controllerLabel(run)} />
      {run.controller?.url ? (
        <RunDetail label="Controller URL" value={run.controller.url} />
      ) : null}
      {run.controller?.turnId ? (
        <RunDetail label="Turn" value={run.controller.turnId} />
      ) : null}
      <RunDetail label="Created" value={formatDate(run.createdAt)} />
      <RunDetail label="Updated" value={formatDate(run.updatedAt)} />
      {run.completedAt ? (
        <RunDetail label="Completed" value={formatDate(run.completedAt)} />
      ) : null}
    </dl>
  );
}

export function runOutputEntries(run: AgentRun) {
  return run.logs && run.logs.length > 0
    ? coalesceRunLogEntries(run.logs)
    : run.error || run.lastLogExcerpt
      ? [
          {
            at: run.updatedAt,
            level: run.error ? ("error" as const) : ("info" as const),
            message: run.error || run.lastLogExcerpt || "",
          },
        ]
      : [];
}

function coalesceRunLogEntries(entries: RunLogEntry[]) {
  const output: RunLogEntry[] = [];
  for (const entry of entries) {
    const previous = output.at(-1);
    if (previous && shouldMergeLogEntries(previous, entry)) {
      previous.message = joinLogFragments(previous.message, entry.message);
      previous.at = entry.at;
      continue;
    }
    output.push({ ...entry });
  }
  return output;
}

function shouldMergeLogEntries(previous: RunLogEntry, next: RunLogEntry) {
  if (previous.level !== next.level) return false;
  if (isOperationalLog(previous.message) || isOperationalLog(next.message)) {
    return false;
  }
  if (timeDistanceMs(previous.at, next.at) > 1500) return false;
  return isFragmentLog(previous.message) || isFragmentLog(next.message);
}

function isFragmentLog(message: string) {
  const text = message.trim();
  if (!text) return false;
  if (text.includes("\n")) return false;
  if (text.length <= 28) return true;
  return !/[.!?]$/.test(text) && text.split(/\s+/).length <= 5;
}

function isOperationalLog(message: string) {
  return /^(Attaching|Cloning|Codex app-server|Claude CLI|Injecting|Launching|Starting)\b/.test(
    message.trim(),
  );
}

function joinLogFragments(left: string, right: string) {
  const next = right.trim();
  if (!next) return left;
  const current = left.trimEnd();
  if (!current) return next;
  if (/^[,.;:!?%)\]}/_-]/.test(next)) return `${current}${next}`;
  if (next === "`") return `${current}${next}`;
  if (/[([{`/@#_-]$/.test(current)) return `${current}${next}`;
  if (/\.$/.test(current) && /^[a-z0-9]{1,8}\b/.test(next)) {
    return `${current}${next}`;
  }
  return `${current} ${next}`;
}

function timeDistanceMs(left: string, right: string) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return 0;
  return Math.abs(rightTime - leftTime);
}

function RunDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="aurora-text-meta">{label}</dt>
      <dd className="break-words aurora-text-body text-[var(--aurora-text-primary)]">
        {value}
      </dd>
    </div>
  );
}

function controllerLabel(run: AgentRun) {
  if (run.controller?.sessionId) {
    return `${run.controller.kind}:${run.controller.sessionId}`;
  }
  if (run.controller?.kind) {
    return run.controller.kind;
  }
  return run.agent === "codex" ? "codex-app-server:pending" : "claude-cli:pending";
}

function toneForStatus(status: AgentRun["status"]) {
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "warn";
  return "neutral";
}

function isRunLive(run: AgentRun) {
  return run.status === "queued" || run.status === "running";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

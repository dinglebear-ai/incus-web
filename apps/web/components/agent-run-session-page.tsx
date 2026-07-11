"use client";

import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { AgentRunFullSessionViewer } from "@/components/agent-run-dispatch";
import { Button } from "@/components/ui/aurora/button";
import type { AgentRun } from "@/lib/provisioner/contracts";

export function AgentRunSessionPage({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const [run, setRun] = React.useState<AgentRun>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();

  const refreshRun = React.useCallback(async () => {
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/agent-runs/${runId}`,
        {
          headers: { "Cache-Control": "no-store" },
        },
      );
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(
          body?.operation?.error?.message ??
            body?.error?.message ??
            "failed to load agent run",
        );
      }
      setRun(body.run);
      setError(undefined);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "failed to load agent run",
      );
    } finally {
      setLoading(false);
    }
  }, [runId, workspaceId]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshRun();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshRun]);

  React.useEffect(() => {
    if (run && run.status !== "queued" && run.status !== "running") return;
    const timer = window.setInterval(() => {
      void refreshRun();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshRun, run]);

  return (
    <main className="aurora-page-shell min-h-screen text-[var(--aurora-text-primary)]">
      <div className="flex h-[58px] items-center gap-3.5 border-b border-[var(--soft-edge)] bg-[linear-gradient(180deg,rgba(23,50,69,0.32),rgba(16,35,48,0))] px-5 md:px-7">
        <div className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--aurora-text-muted)]">
          <Link
            href="/"
            className="flex items-center gap-1.5 transition-colors hover:text-[var(--aurora-text-primary)]"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            Workspaces
          </Link>
          <span className="opacity-60">/</span>
          <span className="truncate font-[family-name:var(--aurora-font-mono)] text-[12px] font-semibold text-[var(--aurora-text-primary)]">
            {runId}
          </span>
        </div>
        <div className="flex-1" />
        <Button
          type="button"
          variant="neutral"
          size="sm"
          iconLeft={<RefreshCwIcon aria-hidden="true" className="size-3.5" />}
          loading={loading}
          onClick={() => void refreshRun()}
        >
          Refresh
        </Button>
      </div>

      <div className="mx-auto flex max-w-[96rem] flex-col gap-4 px-4 py-5 md:px-6">
        {error ? (
          <div className="rounded-[6px] border border-[color-mix(in_srgb,var(--aurora-error)_34%,transparent)] bg-[color-mix(in_srgb,var(--aurora-error)_12%,transparent)] p-4 aurora-text-body text-[var(--aurora-error)]">
            {error}
          </div>
        ) : null}

        {run ? (
          <AgentRunFullSessionViewer run={run} />
        ) : (
          <div className="grid min-h-[32rem] place-items-center rounded-[8px] border border-[var(--soft-edge)] bg-[linear-gradient(180deg,var(--aurora-panel-strong-top),var(--aurora-panel-strong))]">
            <p className="aurora-text-ui text-[var(--aurora-text-muted)]">
              Loading session
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

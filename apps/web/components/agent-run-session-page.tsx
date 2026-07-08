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
    <main className="min-h-screen bg-[var(--aurora-page-bg)] px-4 py-4 text-[var(--aurora-text-primary)] md:px-6">
      <div className="mx-auto flex max-w-[96rem] flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            asChild
            variant="neutral"
          >
            <Link href="/">
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
              Dashboard
            </Link>
          </Button>
          <Button
            type="button"
            variant="neutral"
            iconLeft={<RefreshCwIcon aria-hidden="true" className="size-3.5" />}
            loading={loading}
            onClick={() => void refreshRun()}
          >
            Refresh
          </Button>
        </div>

        {error ? (
          <div className="rounded-[4px] border border-[var(--aurora-error)] bg-[color-mix(in_srgb,var(--aurora-error)_12%,var(--aurora-control-surface))] p-4 text-sm text-[var(--aurora-text-primary)]">
            {error}
          </div>
        ) : null}

        {run ? (
          <AgentRunFullSessionViewer run={run} />
        ) : (
          <div className="grid min-h-[32rem] place-items-center rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)]">
            <p className="aurora-text-ui text-[var(--aurora-text-muted)]">
              Loading session
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

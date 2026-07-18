"use client";

import { useEffect, useState } from "react";
import { InfoIcon } from "lucide-react";

import { Banner } from "@/components/ui/aurora/banner";
import { Callout } from "@/components/ui/aurora/callout";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/ui/aurora/description-list";
import { Timeline, TimelineItem } from "@/components/ui/aurora/timeline";
import {
  PANEL,
  PANEL_HEADER,
  SUBPANEL,
} from "@/components/ui/aurora/panel-chrome";
import { useWorkspaceActivity } from "@/components/use-workspace-activity";
import { apiErrorMessage } from "@/lib/api-error-message";
import type { Workspace } from "@/lib/workspaces/types";

export function WorkspaceDetailsPanel({ workspace }: { workspace: Workspace }) {
  const [loadError, setLoadError] = useState<string>();
  const { entries: activity, error: activityError } = useWorkspaceActivity(workspace.id, 8);
  const [snapshots, setSnapshots] = useState<Array<{ name: string; createdAt?: string }>>([]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchNoStore(`/api/workspaces/${workspace.id}/snapshots`, controller.signal).then((body) => {
        if (Array.isArray(body?.snapshots)) setSnapshots(body.snapshots.slice(0, 8));
      }).catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : "failed to load snapshots");
        }
      });
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [workspace.id]);

  return (
    <aside className={`${PANEL} overflow-hidden`}>
      <div className={PANEL_HEADER}>
        <InfoIcon className="size-4 text-[var(--aurora-accent-primary)]" />
        <h2 className="font-[family-name:var(--aurora-font-display)] text-[13.5px] font-bold text-[var(--aurora-text-primary)]">
          Inspector
        </h2>
      </div>

      <div className="space-y-3 p-4">
      <DescriptionList className="bg-transparent">
        <DescriptionItem label="Image" value={workspace.image ?? workspace.templateVersion} active />
        <DescriptionItem label="Storage pool" value={workspace.storagePool ?? "unknown"} />
        <DescriptionItem label="Network bridge" value={workspace.networkBridge ?? "unknown"} />
        <DescriptionItem label="Resource profile" value={workspace.resourceProfileId} />
        <DescriptionItem label="Workspace path" value={workspace.workspaceHostPath ?? "profile default"} />
        <DescriptionItem label="Container path" value={workspace.workspaceMountPath ?? "/workspace"} />
        <DescriptionItem label="Processes" value={workspace.resources.effectiveProcesses ?? "profile default"} />
        <DescriptionItem label="Dotfiles" value={workspace.setup.dotfilesStatus} active={workspace.setup.dotfilesStatus === "ok"} />
      </DescriptionList>
      {workspace.accessNote ? (
        <Callout variant="info" title="Access">
          {workspace.accessNote}
        </Callout>
      ) : null}

      <section className="space-y-2 border-t border-[var(--soft-edge)] pt-3">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--aurora-text-muted)]">
          Recent activity
        </p>
        {activity.length > 0 ? (
          <Timeline>
            {activity.map((entry) => (
              <TimelineItem
                key={`${entry.at}:${entry.action}`}
                title={`${entry.action} · ${entry.status}`}
                meta={formatDate(entry.at)}
              >
                {entry.actorEmail}
              </TimelineItem>
            ))}
          </Timeline>
        ) : (
          <p className="aurora-text-meta">No recorded actions yet.</p>
        )}
      </section>

      <section className="space-y-2 border-t border-[var(--soft-edge)] pt-3">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[var(--aurora-text-muted)]">
          Snapshots
        </p>
        {snapshots.length > 0 ? (
          <div className="space-y-2">
            {snapshots.map((snapshot) => (
              <div
                key={snapshot.name}
                className={`${SUBPANEL} flex items-center justify-between gap-3 px-3 py-2`}
              >
                <span className="truncate aurora-text-code text-[var(--aurora-text-primary)]">
                  {snapshot.name}
                </span>
                <span className="shrink-0 aurora-text-meta">
                  {snapshot.createdAt ? formatDate(snapshot.createdAt) : "unknown"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="aurora-text-meta">No snapshots yet.</p>
        )}
      </section>

      {loadError || activityError ? (
        <Banner tone="error" kind="tag" title="Inspector data failed" description={loadError ?? activityError} />
      ) : null}
      </div>
    </aside>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function fetchNoStore(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-store" },
    signal,
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || body?.ok !== true) {
    throw new Error(apiErrorMessage(body, `failed to load ${url}`));
  }
  return body;
}

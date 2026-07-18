"use client";

import { ActivityIcon } from "lucide-react";

import { GlowDot, PANEL, PANEL_HEADER } from "@/components/ui/aurora/panel-chrome";
import { useWorkspaceActivity } from "@/components/use-workspace-activity";
import type { Workspace } from "@/lib/workspaces/types";

export function WorkspaceActivityRail({ workspace }: { workspace: Workspace }) {
  const { entries, error } = useWorkspaceActivity(workspace.id, 10);

  return (
    <aside className={`${PANEL} overflow-hidden xl:sticky xl:top-4`}>
      <div className={PANEL_HEADER}>
        <ActivityIcon
          aria-hidden="true"
          className="size-4 text-[var(--aurora-text-muted)]"
        />
        <p className="font-[family-name:var(--aurora-font-display)] text-[13.5px] font-bold text-[var(--aurora-text-primary)]">
          Recent activity
        </p>
        {entries.length > 0 ? (
          <span className="ml-auto aurora-text-meta [font-variant-numeric:tabular-nums]">
            {entries.length}
          </span>
        ) : null}
      </div>

      <div className="p-2.5">
        {entries.length > 0 ? (
          entries.map((entry) => (
            <div
              key={`${entry.at}:${entry.action}`}
              className="flex gap-3 rounded-[6px] px-2.5 py-2.5 transition-colors hover:bg-[color-mix(in_srgb,var(--aurora-accent-primary)_6%,transparent)]"
            >
              <GlowDot
                color={
                  entry.status === "failed"
                    ? "var(--aurora-error)"
                    : "var(--aurora-success)"
                }
                size={7}
                style={{ marginTop: 5 }}
              />
              <div className="min-w-0">
                <p className="text-[12px] leading-[1.45] text-[var(--aurora-text-primary)]">
                  {entry.action.replaceAll("_", " ")} · {entry.status}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-[var(--aurora-text-muted)]">
                  {entry.actorEmail} · {formatTime(entry.at)}
                </p>
              </div>
            </div>
          ))
        ) : (
          <p className="px-2.5 py-3 text-[12px] text-[var(--aurora-text-muted)]">
            {error ?? "No recorded actions yet. Lifecycle actions land here."}
          </p>
        )}
      </div>
    </aside>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

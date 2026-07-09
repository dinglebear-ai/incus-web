"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArchiveIcon,
  DatabaseIcon,
  FolderIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { Button } from "@/components/ui/aurora/button";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/ui/aurora/description-list";
import { Input } from "@/components/ui/aurora/input";
import { apiErrorMessage } from "@/lib/api-error-message";
import type { Workspace } from "@/lib/workspaces/types";

export function WorkspaceDetailsPanel({ workspace }: { workspace: Workspace }) {
  const router = useRouter();
  const [cpu, setCpu] = useState(workspace.resources.effectiveCpu ?? "");
  const [memory, setMemory] = useState(workspace.resources.effectiveMemory ?? "");
  const [hostPath, setHostPath] = useState(workspace.workspaceHostPath ?? "");
  const [snapshotName, setSnapshotName] = useState("");
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [activity, setActivity] = useState<Array<{ at: string; action: string; actorEmail: string; status: string }>>([]);
  const [snapshots, setSnapshots] = useState<Array<{ name: string; createdAt?: string }>>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchNoStore(`/api/workspaces/${workspace.id}/activity`).then((body) => {
        if (Array.isArray(body?.activity)) setActivity(body.activity);
      }).catch((error) => setLoadError(error instanceof Error ? error.message : "failed to load activity"));
      void fetchNoStore(`/api/workspaces/${workspace.id}/snapshots`).then((body) => {
        if (Array.isArray(body?.snapshots)) setSnapshots(body.snapshots);
      }).catch((error) => setLoadError(error instanceof Error ? error.message : "failed to load snapshots"));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [workspace.id]);

  async function mutate(action: string, payload: Record<string, unknown>) {
    setPending(action);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "configuration update failed"));
      }
      setMessage("Saved");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "configuration update failed");
    } finally {
      setPending(undefined);
    }
  }

  async function createSnapshot() {
    setPending("createSnapshot");
    setMessage(undefined);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: snapshotName.trim() || undefined }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "snapshot failed"));
      }
      setMessage("Snapshot created");
      setSnapshotName("");
      if (body.snapshot) setSnapshots((current) => [body.snapshot, ...current].slice(0, 8));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "snapshot failed");
    } finally {
      setPending(undefined);
    }
  }

  return (
    <aside className="space-y-3 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] p-4">
      <div className="flex items-center gap-2">
        <SlidersHorizontalIcon className="size-4 text-[var(--aurora-accent-primary)]" />
        <h2 className="aurora-text-label text-[var(--aurora-text-primary)]">Details</h2>
      </div>

      <DescriptionList className="bg-transparent">
        <DescriptionItem label="Image" value={workspace.image ?? workspace.templateVersion} active />
        <DescriptionItem label="Storage pool" value={workspace.storagePool ?? "unknown"} />
        <DescriptionItem label="Network bridge" value={workspace.networkBridge ?? "unknown"} />
        <DescriptionItem label="Workspace path" value={workspace.workspaceHostPath ?? "profile default"} />
        <DescriptionItem label="Container path" value={workspace.workspaceMountPath ?? "/workspace"} />
        <DescriptionItem label="Processes" value={workspace.resources.effectiveProcesses ?? "profile default"} />
        <DescriptionItem label="Dotfiles" value={workspace.setup.dotfilesStatus} active={workspace.setup.dotfilesStatus === "ok"} />
      </DescriptionList>
      {workspace.accessNote ? (
        <p className="aurora-text-body-sm text-[var(--aurora-text-muted)]">
          {workspace.accessNote}
        </p>
      ) : null}

      <section className="space-y-2 border-t border-[var(--aurora-border-default)] pt-3">
        <div className="flex items-center gap-2">
          <DatabaseIcon className="size-4 text-[var(--aurora-accent-pink)]" />
          <p className="aurora-text-ui">Limits</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="CPU limit" value={cpu} onChange={(event) => setCpu(event.target.value)} placeholder="2" />
          <Input aria-label="Memory limit" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="4GiB" />
        </div>
        <Button
          variant="aurora"
          loading={pending === "setLimits"}
          onClick={() => void mutate("setLimits", { cpu, memory })}
        >
          Save limits
        </Button>
      </section>

      <section className="space-y-2 border-t border-[var(--aurora-border-default)] pt-3">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-[var(--aurora-success)]" />
          <p className="aurora-text-ui">Mount</p>
        </div>
        <Input aria-label="Workspace host path" value={hostPath} onChange={(event) => setHostPath(event.target.value)} />
        <div className="flex gap-2">
          <Button
            variant="aurora"
            loading={pending === "setMount"}
            onClick={() => void mutate("setMount", { hostPath })}
          >
            Save mount
          </Button>
          <Button
            variant="neutral"
            loading={pending === "clearMount"}
            onClick={() => void mutate("clearMount", {})}
          >
            Reset
          </Button>
        </div>
      </section>

      <section className="space-y-2 border-t border-[var(--aurora-border-default)] pt-3">
        <div className="flex items-center gap-2">
          <ArchiveIcon className="size-4 text-[var(--aurora-accent-primary)]" />
          <p className="aurora-text-ui">Snapshots</p>
        </div>
        <Input
          aria-label="Snapshot name"
          value={snapshotName}
          onChange={(event) => setSnapshotName(event.target.value)}
          placeholder="manual-20260709"
        />
        <Button
          variant="aurora"
          loading={pending === "createSnapshot"}
          onClick={() => void createSnapshot()}
        >
          Create snapshot
        </Button>
        <div className="space-y-2">
          {snapshots.length > 0 ? snapshots.slice(0, 8).map((snapshot) => (
            <div key={snapshot.name} className="rounded-[4px] border border-[var(--aurora-border-default)] p-2 aurora-text-meta">
              {snapshot.name}{snapshot.createdAt ? ` · ${new Date(snapshot.createdAt).toLocaleString()}` : ""}
            </div>
          )) : (
            <p className="aurora-text-meta">No snapshots yet.</p>
          )}
        </div>
      </section>

      {message ? <p className="aurora-text-meta text-[var(--aurora-text-muted)]">{message}</p> : null}
      {loadError ? <p className="aurora-text-meta text-[var(--aurora-error)]">{loadError}</p> : null}
      <section className="space-y-2 border-t border-[var(--aurora-border-default)] pt-3">
        <p className="aurora-text-ui">Activity</p>
        <div className="space-y-2">
          {activity.length > 0 ? activity.slice(0, 8).map((entry) => (
            <div key={`${entry.at}:${entry.action}`} className="rounded-[4px] border border-[var(--aurora-border-default)] p-2 aurora-text-meta">
              {entry.action} · {entry.status} · {entry.actorEmail}
            </div>
          )) : (
            <p className="aurora-text-meta">No recorded actions yet.</p>
          )}
        </div>
      </section>
    </aside>
  );
}

async function fetchNoStore(url: string) {
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-store" },
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || body?.ok !== true) {
    throw new Error(apiErrorMessage(body, `failed to load ${url}`));
  }
  return body;
}

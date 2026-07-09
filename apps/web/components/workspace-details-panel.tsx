"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArchiveIcon,
  DatabaseIcon,
  FolderIcon,
  InfoIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { Banner } from "@/components/ui/aurora/banner";
import { Button } from "@/components/ui/aurora/button";
import { Callout } from "@/components/ui/aurora/callout";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/ui/aurora/description-list";
import { Field } from "@/components/ui/aurora/field";
import { Input } from "@/components/ui/aurora/input";
import { Timeline, TimelineItem } from "@/components/ui/aurora/timeline";
import { GoldenConfigImport } from "@/components/golden-config-import";
import { apiErrorMessage } from "@/lib/api-error-message";
import type { Workspace } from "@/lib/workspaces/types";

export function WorkspaceDetailsPanel({ workspace }: { workspace: Workspace }) {
  const [loadError, setLoadError] = useState<string>();
  const [activity, setActivity] = useState<Array<{ at: string; action: string; actorEmail: string; status: string }>>([]);
  const [snapshots, setSnapshots] = useState<Array<{ name: string; createdAt?: string }>>([]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchNoStore(`/api/workspaces/${workspace.id}/activity`, controller.signal).then((body) => {
        if (Array.isArray(body?.activity)) setActivity(body.activity.slice(0, 8));
      }).catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : "failed to load activity");
        }
      });
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
    <aside className="space-y-3 rounded-[var(--aurora-radius-3)] border border-[var(--aurora-border-strong)] bg-[var(--aurora-panel-strong)] p-4 shadow-[var(--aurora-shadow-strong),var(--aurora-highlight-strong)]">
      <div className="flex items-center gap-2">
        <InfoIcon className="size-4 text-[var(--aurora-accent-primary)]" />
        <h2 className="aurora-text-label text-[var(--aurora-text-primary)]">Inspector</h2>
      </div>

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

      <section className="space-y-2 border-t border-[var(--aurora-border-default)] pt-3">
        <p className="aurora-text-ui">Recent activity</p>
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

      <section className="space-y-2 border-t border-[var(--aurora-border-default)] pt-3">
        <p className="aurora-text-ui">Snapshots</p>
        {snapshots.length > 0 ? (
          <div className="space-y-2">
            {snapshots.map((snapshot) => (
              <div
                key={snapshot.name}
                className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] px-3 py-2"
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

      {loadError ? (
        <Banner tone="error" kind="tag" title="Inspector data failed" description={loadError} />
      ) : null}
    </aside>
  );
}

export function WorkspaceSettingsPanel({ workspace }: { workspace: Workspace }) {
  const router = useRouter();
  const [cpu, setCpu] = useState(workspace.resources.effectiveCpu ?? "");
  const [memory, setMemory] = useState(workspace.resources.effectiveMemory ?? "");
  const [hostPath, setHostPath] = useState(workspace.workspaceHostPath ?? "");
  const [snapshotName, setSnapshotName] = useState("");
  const [pending, setPending] = useState<string>();
  const [status, setStatus] = useState<Record<string, string | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [snapshots, setSnapshots] = useState<Array<{ name: string; createdAt?: string }>>([]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchNoStore(`/api/workspaces/${workspace.id}/snapshots`, controller.signal).then((body) => {
        if (Array.isArray(body?.snapshots)) setSnapshots(body.snapshots);
      }).catch((error) => {
        if (!controller.signal.aborted) {
          setErrors((current) => ({
            ...current,
            snapshots: error instanceof Error ? error.message : "failed to load snapshots",
          }));
        }
      });
    }, 1000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [workspace.id]);

  async function mutate(action: string, payload: Record<string, unknown>) {
    setPending(action);
    setStatus((current) => ({ ...current, [action]: undefined }));
    setErrors((current) => ({ ...current, [action]: undefined }));
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
      setStatus((current) => ({ ...current, [action]: "Saved" }));
      router.refresh();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [action]: error instanceof Error ? error.message : "configuration update failed",
      }));
    } finally {
      setPending(undefined);
    }
  }

  async function createSnapshot() {
    setPending("createSnapshot");
    setStatus((current) => ({ ...current, createSnapshot: undefined }));
    setErrors((current) => ({ ...current, createSnapshot: undefined }));
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
      setStatus((current) => ({ ...current, createSnapshot: "Snapshot created" }));
      setSnapshotName("");
      if (body.snapshot) setSnapshots((current) => [body.snapshot, ...current].slice(0, 8));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        createSnapshot: error instanceof Error ? error.message : "snapshot failed",
      }));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="space-y-4 rounded-[var(--aurora-radius-3)] border border-[var(--aurora-border-strong)] bg-[var(--aurora-panel-strong)] p-4 shadow-[var(--aurora-shadow-strong),var(--aurora-highlight-strong)]">
      <div className="flex items-center gap-2">
        <SlidersHorizontalIcon className="size-4 text-[var(--aurora-accent-primary)]" />
        <h2 className="aurora-text-section text-[var(--aurora-text-primary)]">Settings</h2>
      </div>

      <section className="space-y-3 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
        <div className="flex items-center gap-2">
          <DatabaseIcon className="size-4 text-[var(--aurora-accent-pink)]" />
          <p className="aurora-text-ui">Limits</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field htmlFor="workspace-cpu-limit" label="CPU limit">
            <Input id="workspace-cpu-limit" value={cpu} onChange={(event) => setCpu(event.target.value)} placeholder="2" />
          </Field>
          <Field htmlFor="workspace-memory-limit" label="Memory limit">
            <Input id="workspace-memory-limit" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="4GiB" />
          </Field>
        </div>
        <Button
          variant="aurora"
          loading={pending === "setLimits"}
          onClick={() => void mutate("setLimits", { cpu, memory })}
        >
          Save limits
        </Button>
        <StatusLine success={status.setLimits} error={errors.setLimits} />
      </section>

      <section className="space-y-3 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
        <div className="flex items-center gap-2">
          <FolderIcon className="size-4 text-[var(--aurora-success)]" />
          <p className="aurora-text-ui">Mount</p>
        </div>
        <Field htmlFor="workspace-host-path" label="Workspace host path">
          <Input id="workspace-host-path" value={hostPath} onChange={(event) => setHostPath(event.target.value)} />
        </Field>
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
        <StatusLine success={status.setMount ?? status.clearMount} error={errors.setMount ?? errors.clearMount} />
      </section>

      <section className="space-y-3 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
        <div className="flex items-center gap-2">
          <ArchiveIcon className="size-4 text-[var(--aurora-accent-primary)]" />
          <p className="aurora-text-ui">Snapshots</p>
        </div>
        <Field htmlFor="snapshot-name" label="Snapshot name">
          <Input
            id="snapshot-name"
            value={snapshotName}
            onChange={(event) => setSnapshotName(event.target.value)}
            placeholder="manual-20260709"
          />
        </Field>
        <Button
          variant="aurora"
          loading={pending === "createSnapshot"}
          onClick={() => void createSnapshot()}
        >
          Create snapshot
        </Button>
        <StatusLine success={status.createSnapshot} error={errors.createSnapshot ?? errors.snapshots} />
        <div className="space-y-2">
          {snapshots.length > 0 ? snapshots.slice(0, 8).map((snapshot) => (
            <div key={snapshot.name} className="rounded-[8px] border border-[var(--aurora-border-default)] p-2 aurora-text-meta">
              {snapshot.name}{snapshot.createdAt ? ` · ${new Date(snapshot.createdAt).toLocaleString()}` : ""}
            </div>
          )) : (
            <p className="aurora-text-meta">No snapshots yet.</p>
          )}
        </div>
      </section>

      <section className="space-y-3 rounded-[var(--aurora-radius-2)] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
        <GoldenConfigImport workspace={workspace} />
      </section>

      <Callout variant="info" title="Sharing">
        Private workspace state is read-only in this pass. Sharing must keep the same workspace authorization checks server-side.
      </Callout>
    </section>
  );
}

function StatusLine({ success, error }: { success?: string; error?: string }) {
  if (error) return <Banner tone="error" kind="tag" title="Update failed" description={error} />;
  if (success) return <Banner tone="success" kind="tag" title={success} />;
  return null;
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

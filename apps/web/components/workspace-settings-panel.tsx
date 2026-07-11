"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArchiveIcon,
  DatabaseIcon,
  FolderIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { Banner } from "@/components/ui/aurora/banner";
import { Button } from "@/components/ui/aurora/button";
import { Callout } from "@/components/ui/aurora/callout";
import { Field } from "@/components/ui/aurora/field";
import { Input } from "@/components/ui/aurora/input";
import {
  PANEL,
  PANEL_HEADER,
  SUBPANEL,
} from "@/components/ui/aurora/panel-chrome";
import { GoldenConfigImport } from "@/components/golden-config-import";
import { apiErrorMessage } from "@/lib/api-error-message";
import type { Workspace } from "@/lib/workspaces/types";

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
    setCpu(workspace.resources.effectiveCpu ?? "");
    setMemory(workspace.resources.effectiveMemory ?? "");
    setHostPath(workspace.workspaceHostPath ?? "");
  }, [
    workspace.resources.effectiveCpu,
    workspace.resources.effectiveMemory,
    workspace.workspaceHostPath,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchNoStore(`/api/workspaces/${workspace.id}/snapshots`, controller.signal).then((body) => {
        if (Array.isArray(body?.snapshots)) setSnapshots(body.snapshots.slice(0, 8));
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

  function resetActionState(action: string) {
    setStatus((current) => ({ ...current, [action]: undefined }));
    setErrors((current) => ({ ...current, [action]: undefined }));
  }

  async function mutate(action: string, payload: Record<string, unknown>) {
    setPending(action);
    resetActionState(action);
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
      if (action === "clearMount") setHostPath("");
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
    resetActionState("createSnapshot");
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
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <SlidersHorizontalIcon className="size-4 text-[var(--aurora-accent-primary)]" />
        <h2 className="font-[family-name:var(--aurora-font-display)] text-[16px] font-bold text-[var(--aurora-text-primary)]">
          Settings
        </h2>
        <div className="h-px flex-1 bg-[var(--soft-edge)]" />
      </div>

      <section className={`${PANEL} overflow-hidden`}>
        <div className={PANEL_HEADER}>
          <DatabaseIcon className="size-4 text-[var(--aurora-accent-pink)]" />
          <p className="font-[family-name:var(--aurora-font-display)] text-[13.5px] font-bold text-[var(--aurora-text-primary)]">
            Limits
          </p>
        </div>
        <div className="space-y-3 p-4">
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
        </div>
      </section>

      <section className={`${PANEL} overflow-hidden`}>
        <div className={PANEL_HEADER}>
          <FolderIcon className="size-4 text-[var(--aurora-success)]" />
          <p className="font-[family-name:var(--aurora-font-display)] text-[13.5px] font-bold text-[var(--aurora-text-primary)]">
            Mount
          </p>
        </div>
        <div className="space-y-3 p-4">
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
        </div>
      </section>

      <section className={`${PANEL} overflow-hidden`}>
        <div className={PANEL_HEADER}>
          <ArchiveIcon className="size-4 text-[var(--aurora-accent-primary)]" />
          <p className="font-[family-name:var(--aurora-font-display)] text-[13.5px] font-bold text-[var(--aurora-text-primary)]">
            Snapshots
          </p>
        </div>
        <div className="space-y-3 p-4">
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
          {snapshots.length > 0 ? snapshots.map((snapshot) => (
            <div
              key={snapshot.name}
              className={`${SUBPANEL} flex items-center justify-between gap-3 px-3 py-2`}
            >
              <span className="truncate font-[family-name:var(--aurora-font-mono)] text-[11.5px] text-[var(--aurora-text-primary)]">
                {snapshot.name}
              </span>
              <span className="shrink-0 aurora-text-meta">
                {snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : ""}
              </span>
            </div>
          )) : (
            <p className="aurora-text-meta">No snapshots yet.</p>
          )}
        </div>
        </div>
      </section>

      <section className={`${PANEL} p-4`}>
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

"use client";

import { CheckCircle2Icon, FileArchiveIcon, UploadCloudIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/aurora/button";
import type { ImportGoldenConfigResult } from "@/lib/provisioner/contracts";
import type { Workspace } from "@/lib/workspaces/types";

export function GoldenConfigImport({ workspace }: { workspace: Workspace }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = React.useState<string>();
  const [dragging, setDragging] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [result, setResult] = React.useState<ImportGoldenConfigResult>();

  async function importFile(file: File) {
    setFileName(file.name);
    setSubmitting(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await fetch(`/api/workspaces/${workspace.id}/golden-config`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(
          body?.operation?.error?.message ??
            body?.error?.message ??
            "golden config import failed",
        );
      }
      setResult(body.operation.result as ImportGoldenConfigResult);
    } catch (importError) {
      setResult(undefined);
      setError(
        importError instanceof Error
          ? importError.message
          : "golden config import failed",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    void importFile(file);
  }

  return (
    <section className="overflow-hidden rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--aurora-border-default)] px-4 py-3">
        <div className="flex items-center gap-2">
          <FileArchiveIcon
            aria-hidden="true"
            className="size-4 text-[var(--aurora-accent-pink)]"
          />
          <h2 className="aurora-text-label text-[var(--aurora-text-primary)]">
            Golden config import
          </h2>
        </div>
        <span className="aurora-text-meta">~/.claude + ~/.codex seed</span>
      </div>

      <div className="p-4">
        <label
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleFiles(event.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[4px] border border-dashed p-6 text-center transition-colors ${
            dragging
              ? "border-[var(--aurora-accent-primary)] bg-[color-mix(in_srgb,var(--aurora-accent-primary)_9%,var(--aurora-control-surface))]"
              : "border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)]"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            onChange={(event) => handleFiles(event.target.files)}
          />
          <UploadCloudIcon
            aria-hidden="true"
            className="size-6 text-[var(--aurora-text-muted)]"
          />
          <p className="aurora-text-ui text-[var(--aurora-text-primary)]">
            Drop a golden-config zip here, or click to choose one
          </p>
          <p className="aurora-text-meta">
            Exported with scripts/export-onboarding.mjs on your own machine
          </p>
        </label>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="aurora-text-meta truncate">
            {fileName ?? "No file selected"}
          </p>
          <Button
            type="button"
            size="sm"
            variant="rose"
            iconLeft={<UploadCloudIcon aria-hidden="true" className="size-3.5" />}
            loading={submitting}
            disabled={submitting}
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </Button>
        </div>

        {error ? (
          <p className="mt-3 aurora-text-body text-[var(--aurora-error)]">{error}</p>
        ) : null}

        {result ? (
          <div className="mt-3 flex items-start gap-2 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] p-3">
            <CheckCircle2Icon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--aurora-success)]"
            />
            <div className="min-w-0 space-y-1">
              <p className="aurora-text-body text-[var(--aurora-text-primary)]">
                Imported {result.fileCount} file{result.fileCount === 1 ? "" : "s"}{" "}
                at {formatDate(result.extractedAt)}
              </p>
              {result.warnings.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-4 aurora-text-meta">
                  {result.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

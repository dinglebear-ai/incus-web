"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HammerIcon, PackagePlusIcon, RefreshCwIcon, SaveIcon, UploadIcon } from "lucide-react";

import { Banner } from "@/components/ui/aurora/banner";
import { Button } from "@/components/ui/aurora/button";
import { ButtonGroup } from "@/components/ui/aurora/button-group";
import { Badge } from "@/components/ui/aurora/badge";
import { Field } from "@/components/ui/aurora/field";
import { Input } from "@/components/ui/aurora/input";
import { Item } from "@/components/ui/aurora/item";
import { NativeSelect } from "@/components/ui/aurora/native-select";
import { TagInput } from "@/components/ui/aurora/tag-input";
import { Textarea } from "@/components/ui/aurora/textarea";
import {
  CONSOLE,
  PANEL,
  PANEL_HEADER,
} from "@/components/ui/aurora/panel-chrome";
import { apiErrorMessage } from "@/lib/api-error-message";
import { BUILDER_DISTROS } from "@/lib/builder/distros";
import type {
  BuilderPreset,
  BuiltImageRecord,
  BuildStatus,
  GetBuildStatusResult,
} from "@/lib/build-worker/contracts";
import { parseDevcontainerJson } from "@/lib/import/devcontainer";
import { importMiseToml, importToolVersionsFile } from "@/lib/import/mise";

type SearchResult = {
  manager: string;
  name: string;
  description?: string;
};

const MAX_LOG_CHARS = 80_000;

export function BuilderPanel() {
  const [distro, setDistro] = useState("debian");
  const [release, setRelease] = useState("trixie");
  const [packages, setPackages] = useState<string[]>(["git", "curl", "ca-certificates"]);
  const [packageInput, setPackageInput] = useState("");
  const [postInstall, setPostInstall] = useState("");
  const [imageAlias, setImageAlias] = useState("incus-web-custom");
  const [presetName, setPresetName] = useState("default");
  const [build, setBuild] = useState<GetBuildStatusResult>();
  const [log, setLog] = useState("");
  const [logTruncated, setLogTruncated] = useState(false);
  const [message, setMessage] = useState<string>();
  const [importedCommandsNeedReview, setImportedCommandsNeedReview] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [images, setImages] = useState<BuiltImageRecord[]>([]);
  const [presets, setPresets] = useState<BuilderPreset[]>([]);
  const pollTimerRef = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const logLengthRef = useRef(0);
  const releases = useMemo(
    () => BUILDER_DISTROS.find((entry) => entry.id === distro)?.releases ?? [],
    [distro],
  );
  const cancelBuildPolling = useCallback(() => {
    if (pollTimerRef.current !== undefined) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    void refreshRegistry();
    return cancelBuildPolling;
  }, [cancelBuildPolling]);

  function addPackage(name = packageInput) {
    const normalized = name.trim();
    if (!normalized) return;
    setPackages((current) => [...new Set([...current, normalized])]);
    setPackageInput("");
  }

  async function dispatchBuild() {
    setMessage(undefined);
    if (importedCommandsNeedReview) {
      setMessage("Review imported post-install commands before building");
      return;
    }
    setLog("");
    logLengthRef.current = 0;
    setLogTruncated(false);
    cancelBuildPolling();
    try {
      const response = await fetch("/api/builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "dispatch",
          distro,
          release,
          packages,
          postInstallCommands: postInstallCommands(postInstall),
          imageAlias,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "build dispatch failed"));
      }
      const buildId = body.operation.result.buildId as string;
      void pollBuild(buildId, 0);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "build dispatch failed");
    }
  }

  async function pollBuild(buildId: string, offset: number) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/builds/${buildId}?offset=${offset}`, {
        headers: { "Cache-Control": "no-store" },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "build status failed"));
      }
      const result = body.operation.result as GetBuildStatusResult;
      setBuild(result);
      const chunk = result.logChunk || "";
      if (logLengthRef.current + chunk.length > MAX_LOG_CHARS) {
        setLogTruncated(true);
      }
      setLog((current) => {
        const next = appendBoundedLog(current, chunk);
        logLengthRef.current = next.length;
        return next;
      });
      if (result.status === "queued" || result.status === "running") {
        pollTimerRef.current = window.setTimeout(
          () => void pollBuild(buildId, result.logOffset),
          2500,
        );
      } else {
        void refreshRegistry();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : "build status failed");
      }
    }
  }

  async function savePreset() {
    setMessage(undefined);
    try {
      const response = await fetch("/api/builds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "savePreset",
          name: presetName,
          distro,
          release,
          packages,
          postInstallCommands: postInstallCommands(postInstall),
        }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "preset save failed"));
      }
      setMessage("Preset saved");
      void refreshRegistry();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "preset save failed");
    }
  }

  async function refreshRegistry() {
    try {
      const response = await fetch("/api/builds", { headers: { "Cache-Control": "no-store" } });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "failed to load build registry"));
      }
      setImages(Array.isArray(body.images?.result?.images) ? body.images.result.images : []);
      setPresets(Array.isArray(body.presets?.result?.presets) ? body.presets.result.presets : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "failed to load build registry");
    }
  }

  async function searchPackage() {
    try {
      const response = await fetch(`/api/builder/package-search?q=${encodeURIComponent(packageInput)}`);
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(apiErrorMessage(body, "package search failed"));
      }
      setSearchResults(Array.isArray(body?.results) ? body.results : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "package search failed");
    }
  }

  async function importFile(kind: "devcontainer" | "tool-versions" | "mise", file: File) {
    setMessage(undefined);
    try {
      const text = await file.text();
      if (kind === "devcontainer") {
        const imported = parseDevcontainerJson(text, { externalSource: true });
        if (imported.distroRelease) {
          setDistro(imported.distroRelease.distro);
          setRelease(imported.distroRelease.release);
        }
        setPackages((current) => [...new Set([...current, ...imported.packages])]);
        const commands = imported.postInstallCommands.map((entry) => entry.command);
        setPostInstall((current) => [current, ...commands].filter(Boolean).join("\n"));
        if (commands.length > 0) setImportedCommandsNeedReview(true);
        setMessage(`${imported.skipped.length} devcontainer field(s) skipped`);
        return;
      }
      const imported = kind === "mise" ? importMiseToml(text, "build-time") : importToolVersionsFile(text, "build-time");
      if (imported.postInstallCommand) {
        setPostInstall((current) => [current, imported.postInstallCommand].filter(Boolean).join("\n"));
        setImportedCommandsNeedReview(true);
      }
      setMessage(`${imported.tools.length} mise tool pin(s) imported`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Import failed for ${file.name}: ${error.message}`
          : `Import failed for ${file.name}`,
      );
    }
  }

  function handleDistroChange(next: string) {
    setDistro(next);
    setRelease(BUILDER_DISTROS.find((entry) => entry.id === next)?.releases[0]?.id ?? "trixie");
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <HammerIcon className="size-4 text-[var(--aurora-accent-primary)]" />
        <h2 className="font-[family-name:var(--aurora-font-display)] text-[16px] font-bold text-[var(--aurora-text-primary)]">
          Builder
        </h2>
        {build ? <Badge tone={buildStatusTone(build.status)}>{build.status}</Badge> : null}
        <div className="h-px flex-1 bg-[var(--soft-edge)]" />
      </div>

      <div className={`${PANEL} space-y-4 p-4`}>

      <div className="grid gap-3 md:grid-cols-4">
        <Field htmlFor="builder-distro" label="Distro">
          <NativeSelect id="builder-distro" value={distro} onChange={(event) => handleDistroChange(event.target.value)}>
            {BUILDER_DISTROS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect>
        </Field>
        <Field htmlFor="builder-release" label="Release">
          <NativeSelect id="builder-release" value={release} onChange={(event) => setRelease(event.target.value)}>
            {releases.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect>
        </Field>
        <Field htmlFor="builder-image-alias" label="Image alias">
          <Input id="builder-image-alias" value={imageAlias} onChange={(event) => setImageAlias(event.target.value)} />
        </Field>
        <Field htmlFor="builder-preset-name" label="Preset name">
          <Input id="builder-preset-name" value={presetName} onChange={(event) => setPresetName(event.target.value)} />
        </Field>
      </div>

      <Field htmlFor="builder-packages" label="Packages">
        <TagInput
          id="builder-packages"
          value={packages}
          onValueChange={setPackages}
          placeholder="Add package…"
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Input value={packageInput} onChange={(event) => setPackageInput(event.target.value)} aria-label="Package name" placeholder="package search" />
        <Button iconLeft={<PackagePlusIcon />} onClick={() => addPackage()}>Add package</Button>
        <Button variant="neutral" onClick={() => void searchPackage()}>Search</Button>
        <Button variant="neutral" iconLeft={<RefreshCwIcon />} onClick={() => void refreshRegistry()}>Refresh</Button>
        <Button iconLeft={<SaveIcon />} variant="neutral" onClick={() => void savePreset()}>Save preset</Button>
      </div>

      <ButtonGroup>
        <Button asChild variant="neutral">
          <label className="inline-flex items-center gap-2">
            <UploadIcon aria-hidden="true" className="size-4" />
            Import devcontainer
            <input className="sr-only" type="file" accept=".json" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile("devcontainer", file);
            }} />
          </label>
        </Button>
        <Button asChild variant="neutral">
          <label className="inline-flex items-center gap-2">
            <UploadIcon aria-hidden="true" className="size-4" />
            Import mise
            <input className="sr-only" type="file" accept=".toml,.tool-versions" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file.name.endsWith(".toml") ? "mise" : "tool-versions", file);
            }} />
          </label>
        </Button>
      </ButtonGroup>

      {searchResults.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {searchResults.map((result) => (
            <Item
              key={`${result.manager}:${result.name}`}
              title={result.name}
              description={result.description ?? result.manager}
              action={<Button size="sm" variant="neutral" onClick={() => addPackage(result.name)}>Add</Button>}
            />
          ))}
        </div>
      ) : null}

      <Field htmlFor="builder-post-install" label="Post-install commands" description="Review imported commands before building.">
        <Textarea
          id="builder-post-install"
          value={postInstall}
          onChange={(event) => {
            setPostInstall(event.target.value);
            if (importedCommandsNeedReview) setImportedCommandsNeedReview(true);
          }}
          className="min-h-32"
        />
      </Field>
      {importedCommandsNeedReview ? (
        <Banner
          tone="warn"
          title="Review imported commands"
          description="Imported post-install commands can run during image builds. Confirm they are expected before dispatching."
          action={
            <Button size="sm" variant="neutral" onClick={() => setImportedCommandsNeedReview(false)}>
              Reviewed
            </Button>
          }
        />
      ) : null}
      <Button
        iconLeft={<HammerIcon />}
        variant="aurora"
        disabled={importedCommandsNeedReview}
        onClick={() => void dispatchBuild()}
      >
        Build image
      </Button>
      {message ? <Banner tone={message.toLowerCase().includes("failed") ? "error" : "info"} kind="tag" title={message} /> : null}
      {logTruncated ? (
        <Banner
          tone="warn"
          kind="tag"
          title="Log truncated"
          description="Only the latest build log output is shown in this panel."
        />
      ) : null}
      </div>

      {log ? (
        <div className={`${CONSOLE} overflow-hidden`}>
          <div className="flex items-center gap-2 border-b border-[var(--soft-edge)] bg-[rgba(7,17,26,0.7)] px-4 py-2.5">
            <span className="font-[family-name:var(--aurora-font-mono)] text-[11px] text-[var(--aurora-text-muted)]">
              build log{build ? ` · ${build.status}` : ""}
            </span>
          </div>
          <pre className="max-h-80 overflow-auto p-3 font-[family-name:var(--aurora-font-mono)] text-[12px] leading-[1.62] text-[#cfe2ec]">
            {log}
          </pre>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <section className={`${PANEL} overflow-hidden`}>
          <div className={PANEL_HEADER}>
            <p className="font-[family-name:var(--aurora-font-display)] text-[13.5px] font-bold text-[var(--aurora-text-primary)]">
              Images
            </p>
          </div>
          <div className="space-y-2 p-4">
            {images.map((image) => (
              <div key={image.imageAlias} className="flex items-center justify-between gap-2 aurora-text-meta">
                <span>{image.imageAlias} ({image.distro}/{image.release})</span>
                <Badge tone={image.isMaster ? "success" : "neutral"}>{image.isMaster ? "master" : image.basedOn ? "variant" : "image"}</Badge>
              </div>
            ))}
          </div>
        </section>
        <section className={`${PANEL} overflow-hidden`}>
          <div className={PANEL_HEADER}>
            <p className="font-[family-name:var(--aurora-font-display)] text-[13.5px] font-bold text-[var(--aurora-text-primary)]">
              Presets
            </p>
          </div>
          <div className="space-y-2 p-4">
            {presets.map((preset) => (
              <Item
                key={preset.id}
                title={preset.name}
                description={`${preset.distro}/${preset.release} · ${preset.packages.length} package(s)`}
                action={
                  <Button
                    size="sm"
                    variant="neutral"
                    onClick={() => {
                      setDistro(preset.distro);
                      setRelease(preset.release);
                      setPackages(preset.packages);
                      setPostInstall(preset.postInstallCommands.join("\n"));
                    }}
                  >
                    Load
                  </Button>
                }
              />
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function postInstallCommands(value: string) {
  return value.split("\n").map((entry) => entry.trim()).filter(Boolean);
}

function buildStatusTone(status: BuildStatus) {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  return "info";
}

function appendBoundedLog(current: string, chunk: string) {
  const safeChunk = chunk.length > MAX_LOG_CHARS ? chunk.slice(-MAX_LOG_CHARS) : chunk;
  const keepFromCurrent = Math.max(0, MAX_LOG_CHARS - safeChunk.length);
  return (keepFromCurrent > 0 ? current.slice(-keepFromCurrent) : "") + safeChunk;
}

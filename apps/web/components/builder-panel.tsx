"use client";

import { useEffect, useMemo, useState } from "react";
import { HammerIcon, PackagePlusIcon, SaveIcon, UploadIcon } from "lucide-react";

import { Button } from "@/components/ui/aurora/button";
import { Badge } from "@/components/ui/aurora/badge";
import { Input } from "@/components/ui/aurora/input";
import { Textarea } from "@/components/ui/aurora/textarea";
import { BUILDER_DISTROS } from "@/lib/builder/distros";
import { parseDevcontainerJson } from "@/lib/import/devcontainer";
import { importMiseToml, importToolVersionsFile } from "@/lib/import/mise";

type BuildStatus = {
  buildId: string;
  status: string;
  imageAlias: string;
  logOffset: number;
  logChunk: string;
  error?: string;
};

type SearchResult = {
  manager: string;
  name: string;
  description?: string;
};

type ImageRecord = {
  imageAlias: string;
  isMaster: boolean;
  distro: string;
  release: string;
  basedOn?: string;
};

type PresetRecord = {
  id: string;
  name: string;
  distro: string;
  release: string;
  packages: string[];
  postInstallCommands: string[];
};

export function BuilderPanel() {
  const [distro, setDistro] = useState("debian");
  const [release, setRelease] = useState("trixie");
  const [packages, setPackages] = useState<string[]>(["git", "curl", "ca-certificates"]);
  const [packageInput, setPackageInput] = useState("");
  const [postInstall, setPostInstall] = useState("");
  const [imageAlias, setImageAlias] = useState("incus-web-custom");
  const [presetName, setPresetName] = useState("default");
  const [build, setBuild] = useState<BuildStatus>();
  const [log, setLog] = useState("");
  const [message, setMessage] = useState<string>();
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [presets, setPresets] = useState<PresetRecord[]>([]);
  const releases = useMemo(
    () => BUILDER_DISTROS.find((entry) => entry.id === distro)?.releases ?? [],
    [distro],
  );

  useEffect(() => {
    void refreshRegistry();
  }, []);

  function addPackage(name = packageInput) {
    const normalized = name.trim();
    if (!normalized) return;
    setPackages((current) => [...new Set([...current, normalized])]);
    setPackageInput("");
  }

  async function dispatchBuild() {
    setMessage(undefined);
    setLog("");
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
    const body = await response.json();
    if (!response.ok || body?.ok !== true) {
      setMessage(apiErrorMessage(body, "build dispatch failed"));
      return;
    }
    const buildId = body.operation.result.buildId as string;
    void pollBuild(buildId, 0);
  }

  async function pollBuild(buildId: string, offset: number) {
    const response = await fetch(`/api/builds/${buildId}?offset=${offset}`, {
      headers: { "Cache-Control": "no-store" },
    });
    const body = await response.json();
    if (body?.ok !== true) {
      setMessage(body?.operation?.error?.message ?? "build status failed");
      return;
    }
    const result = body.operation.result as BuildStatus;
    setBuild(result);
    setLog((current) => current + (result.logChunk || ""));
    if (result.status === "queued" || result.status === "running") {
      window.setTimeout(() => void pollBuild(buildId, result.logOffset), 2500);
    } else {
      void refreshRegistry();
    }
  }

  async function savePreset() {
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
      setMessage(apiErrorMessage(body, "preset save failed"));
      return;
    }
    setMessage("Preset saved");
    void refreshRegistry();
  }

  async function refreshRegistry() {
    const response = await fetch("/api/builds", { headers: { "Cache-Control": "no-store" } });
    const body = await response.json().catch(() => undefined);
    if (body?.images?.result?.images) setImages(body.images.result.images);
    if (body?.presets?.result?.presets) setPresets(body.presets.result.presets);
  }

  async function searchPackage() {
    const response = await fetch(`/api/builder/package-search?q=${encodeURIComponent(packageInput)}`);
    const body = await response.json().catch(() => undefined);
    setSearchResults(Array.isArray(body?.results) ? body.results : []);
  }

  async function importFile(kind: "devcontainer" | "tool-versions" | "mise", file: File) {
    const text = await file.text();
    if (kind === "devcontainer") {
      const imported = parseDevcontainerJson(text, { externalSource: true });
      if (imported.distroRelease) {
        setDistro(imported.distroRelease.distro);
        setRelease(imported.distroRelease.release);
      }
      setPackages((current) => [...new Set([...current, ...imported.packages])]);
      setPostInstall((current) =>
        [current, ...imported.postInstallCommands.map((entry) => entry.command)].filter(Boolean).join("\n"),
      );
      setMessage(`${imported.skipped.length} devcontainer field(s) skipped`);
      return;
    }
    const imported = kind === "mise" ? importMiseToml(text, "build-time") : importToolVersionsFile(text, "build-time");
    if (imported.postInstallCommand) {
      setPostInstall((current) => [current, imported.postInstallCommand].filter(Boolean).join("\n"));
    }
    setMessage(`${imported.tools.length} mise tool pin(s) imported`);
  }

  function handleDistroChange(next: string) {
    setDistro(next);
    setRelease(BUILDER_DISTROS.find((entry) => entry.id === next)?.releases[0]?.id ?? "trixie");
  }

  return (
    <section className="space-y-4 rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-panel-medium)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HammerIcon className="size-4 text-[var(--aurora-accent-primary)]" />
          <h2 className="aurora-text-label">Builder</h2>
        </div>
        {build ? <Badge tone={build.status === "failed" ? "error" : build.status === "succeeded" ? "success" : "info"}>{build.status}</Badge> : null}
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <select className="rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] px-3 py-2" value={distro} onChange={(event) => handleDistroChange(event.target.value)}>
          {BUILDER_DISTROS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        <select className="rounded-[4px] border border-[var(--aurora-border-default)] bg-[var(--aurora-control-surface)] px-3 py-2" value={release} onChange={(event) => setRelease(event.target.value)}>
          {releases.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        <Input value={imageAlias} onChange={(event) => setImageAlias(event.target.value)} aria-label="Image alias" />
        <Input value={presetName} onChange={(event) => setPresetName(event.target.value)} aria-label="Preset name" />
      </div>

      <div className="flex flex-wrap gap-2">
        <Input value={packageInput} onChange={(event) => setPackageInput(event.target.value)} aria-label="Package name" placeholder="package" />
        <Button iconLeft={<PackagePlusIcon />} onClick={() => addPackage()}>Add</Button>
        <Button variant="neutral" onClick={() => void searchPackage()}>Search</Button>
        <Button variant="neutral" onClick={() => void refreshRegistry()}>Refresh</Button>
        <Button iconLeft={<SaveIcon />} variant="neutral" onClick={() => void savePreset()}>Preset</Button>
        <label className="inline-flex items-center gap-2 rounded-[4px] border border-[var(--aurora-border-default)] px-3 py-2 aurora-text-ui">
          <UploadIcon className="size-4" />
          devcontainer
          <input className="sr-only" type="file" accept=".json" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile("devcontainer", file);
          }} />
        </label>
        <label className="inline-flex items-center gap-2 rounded-[4px] border border-[var(--aurora-border-default)] px-3 py-2 aurora-text-ui">
          <UploadIcon className="size-4" />
          mise
          <input className="sr-only" type="file" accept=".toml,.tool-versions" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file.name.endsWith(".toml") ? "mise" : "tool-versions", file);
          }} />
        </label>
      </div>

      {searchResults.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-2">
          {searchResults.map((result) => (
            <button
              key={`${result.manager}:${result.name}`}
              type="button"
              className="rounded-[4px] border border-[var(--aurora-border-default)] p-2 text-left"
              onClick={() => addPackage(result.name)}
            >
              <span className="aurora-text-ui">{result.name}</span>
              <span className="aurora-text-meta ml-2">{result.manager}</span>
              {result.description ? <p className="aurora-text-meta mt-1">{result.description}</p> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {packages.map((pkg) => (
          <button key={pkg} className="rounded-[4px] border border-[var(--aurora-border-default)] px-2 py-1 aurora-text-meta" onClick={() => setPackages((current) => current.filter((entry) => entry !== pkg))}>
            {pkg}
          </button>
        ))}
      </div>

      <Textarea value={postInstall} onChange={(event) => setPostInstall(event.target.value)} aria-label="Post install commands" className="min-h-32" />
      <Button iconLeft={<HammerIcon />} variant="aurora" onClick={() => void dispatchBuild()}>Build image</Button>
      {message ? <p className="aurora-text-meta">{message}</p> : null}
      {log ? <pre className="max-h-80 overflow-auto rounded-[4px] border border-[var(--aurora-border-default)] bg-black/30 p-3 text-xs">{log}</pre> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-[4px] border border-[var(--aurora-border-default)] p-3">
          <p className="aurora-text-ui">Images</p>
          <div className="mt-2 space-y-2">
            {images.map((image) => (
              <div key={image.imageAlias} className="flex items-center justify-between gap-2 aurora-text-meta">
                <span>{image.imageAlias} ({image.distro}/{image.release})</span>
                <Badge tone={image.isMaster ? "success" : "neutral"}>{image.isMaster ? "master" : image.basedOn ? "variant" : "image"}</Badge>
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-[4px] border border-[var(--aurora-border-default)] p-3">
          <p className="aurora-text-ui">Presets</p>
          <div className="mt-2 space-y-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="block w-full rounded-[4px] border border-[var(--aurora-border-default)] p-2 text-left aurora-text-meta"
                onClick={() => {
                  setDistro(preset.distro);
                  setRelease(preset.release);
                  setPackages(preset.packages);
                  setPostInstall(preset.postInstallCommands.join("\n"));
                }}
              >
                {preset.name}
              </button>
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

function apiErrorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const payload = body as {
    operation?: { error?: { message?: unknown } };
    error?: { message?: unknown };
  };
  return stringMessage(payload.operation?.error?.message)
    ?? stringMessage(payload.error?.message)
    ?? fallback;
}

function stringMessage(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

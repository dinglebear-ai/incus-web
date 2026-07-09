export type PackageSearchManager = "apt" | "npm" | "pypi" | "homebrew";

export type PackageSearchResult = {
  manager: PackageSearchManager;
  name: string;
  description?: string;
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; results: PackageSearchResult[] }>();

export async function searchPackages(query: string): Promise<PackageSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9+._-]{0,63}$/.test(normalized)) return [];
  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const settled = await Promise.allSettled([
    searchNpm(normalized),
    searchPypi(normalized),
    searchHomebrew(normalized),
    searchApt(normalized),
  ]);
  const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []));
  cache.set(normalized, { expiresAt: Date.now() + CACHE_TTL_MS, results });
  return results;
}

async function searchNpm(query: string): Promise<PackageSearchResult[]> {
  const response = await fetch(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`,
    { signal: AbortSignal.timeout(2500) },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as {
    objects?: Array<{ package?: { name?: string; description?: string } }>;
  };
  return (body.objects ?? [])
    .map((entry) => entry.package)
    .filter((pkg): pkg is { name: string; description?: string } => typeof pkg?.name === "string")
    .map((pkg) => ({ manager: "npm" as const, name: pkg.name, description: pkg.description }));
}

async function searchPypi(query: string): Promise<PackageSearchResult[]> {
  const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(query)}/json`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { info?: { name?: string; summary?: string } };
  return typeof body.info?.name === "string"
    ? [{ manager: "pypi", name: body.info.name, description: body.info.summary }]
    : [];
}

async function searchHomebrew(query: string): Promise<PackageSearchResult[]> {
  const response = await fetch("https://formulae.brew.sh/api/formula.json", {
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as Array<{ name?: string; desc?: string }>;
  return body
    .filter((entry) => typeof entry.name === "string" && entry.name.includes(query))
    .slice(0, 5)
    .map((entry) => ({ manager: "homebrew" as const, name: entry.name!, description: entry.desc }));
}

async function searchApt(query: string): Promise<PackageSearchResult[]> {
  const common = [
    "git",
    "curl",
    "ca-certificates",
    "sudo",
    "nodejs",
    "python3",
    "golang",
    "rustc",
    "cargo",
    "build-essential",
    "pkg-config",
  ];
  return common
    .filter((name) => name.includes(query))
    .slice(0, 5)
    .map((name) => ({ manager: "apt", name }));
}

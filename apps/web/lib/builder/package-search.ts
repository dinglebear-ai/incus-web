export type PackageSearchManager = "apt" | "npm" | "pypi" | "homebrew";

export type PackageSearchResult = {
  manager: PackageSearchManager;
  name: string;
  description?: string;
};

const CACHE_TTL_MS = 60_000;
const CATALOG_TTL_MS = 15 * 60_000;
const MAX_QUERY_CACHE_ENTRIES = 128;
const MAX_HOMEBREW_RESPONSE_BYTES = 40 * 1024 * 1024;
const cache = new Map<string, { expiresAt: number; results: PackageSearchResult[] }>();
const inFlight = new Map<string, Promise<PackageSearchResult[]>>();
let homebrewCatalog:
  | { expiresAt: number; entries: Array<{ name: string; desc?: string }> }
  | undefined;
let homebrewCatalogRequest: Promise<Array<{ name: string; desc?: string }>> | undefined;

export async function searchPackages(query: string): Promise<PackageSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9+._-]{0,63}$/.test(normalized)) return [];
  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(normalized);
    cache.set(normalized, cached);
    return cached.results;
  }
  cache.delete(normalized);
  const existing = inFlight.get(normalized);
  if (existing) return existing;

  const request = (async () => {
    const settled = await Promise.allSettled([
      searchNpm(normalized),
      searchPypi(normalized),
      searchHomebrew(normalized),
      searchApt(normalized),
    ]);
    const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []));
    cache.set(normalized, { expiresAt: Date.now() + CACHE_TTL_MS, results });
    while (cache.size > MAX_QUERY_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return results;
  })();
  inFlight.set(normalized, request);
  try {
    return await request;
  } finally {
    inFlight.delete(normalized);
  }
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
  const body = await getHomebrewCatalog();
  return body
    .filter((entry) => entry.name.includes(query))
    .slice(0, 5)
    .map((entry) => ({ manager: "homebrew" as const, name: entry.name, description: entry.desc }));
}

async function getHomebrewCatalog(): Promise<Array<{ name: string; desc?: string }>> {
  if (homebrewCatalog && homebrewCatalog.expiresAt > Date.now()) return homebrewCatalog.entries;
  if (homebrewCatalogRequest) return homebrewCatalogRequest;
  homebrewCatalogRequest = (async () => {
    const response = await fetch("https://formulae.brew.sh/api/formula.json", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`homebrew catalog returned ${response.status}`);
    const declaredBytes = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_HOMEBREW_RESPONSE_BYTES) {
      throw new Error("homebrew catalog exceeded the configured response limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_HOMEBREW_RESPONSE_BYTES) {
      throw new Error("homebrew catalog exceeded the configured response limit");
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Array<{ name?: unknown; desc?: unknown }>;
    if (!Array.isArray(parsed)) throw new Error("homebrew catalog was malformed");
    const entries = parsed.flatMap((entry) =>
      typeof entry?.name === "string"
        ? [{ name: entry.name, desc: typeof entry.desc === "string" ? entry.desc : undefined }]
        : [],
    );
    homebrewCatalog = { expiresAt: Date.now() + CATALOG_TTL_MS, entries };
    return entries;
  })();
  try {
    return await homebrewCatalogRequest;
  } catch (error) {
    if (homebrewCatalog) return homebrewCatalog.entries;
    throw error;
  } finally {
    homebrewCatalogRequest = undefined;
  }
}

export function resetPackageSearchCachesForTests() {
  cache.clear();
  inFlight.clear();
  homebrewCatalog = undefined;
  homebrewCatalogRequest = undefined;
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

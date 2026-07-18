import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPackageSearchCachesForTests, searchPackages } from "./package-search";

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("package search caching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetPackageSearchCachesForTests();
  });

  it("coalesces identical requests and reuses the Homebrew catalog across queries", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("formula.json")) {
        return response([{ name: "git", desc: "version control" }, { name: "git-lfs" }]);
      }
      if (url.includes("pypi.org")) return new Response(null, { status: 404 });
      return response({ objects: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const identical = await Promise.all(Array.from({ length: 25 }, () => searchPackages("git")));
    expect(identical.every((results) => results.some((entry) => entry.name === "git"))).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("formula.json"))).toHaveLength(1);

    await searchPackages("git-lfs");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("formula.json"))).toHaveLength(1);
  });

  it("bounds concurrent distinct searches while allowing queued searches to finish", async () => {
    let releaseFetches!: () => void;
    let blockFetches = true;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (blockFetches) await fetchGate;
      const url = String(input);
      if (url.includes("formula.json")) return response([]);
      if (url.includes("pypi.org")) return new Response(null, { status: 404 });
      return response({ objects: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searches = Array.from({ length: 12 }, (_, index) =>
      searchPackages(`package-${index}`),
    );
    await vi.waitFor(() => {
      const activeNpmQueries = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("registry.npmjs.org"),
      );
      expect(activeNpmQueries).toHaveLength(8);
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("package-8")),
    ).toBe(false);

    blockFetches = false;
    releaseFetches();
    await expect(Promise.all(searches)).resolves.toHaveLength(12);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("registry.npmjs.org")),
    ).toHaveLength(12);
  });
});

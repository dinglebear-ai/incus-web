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
});

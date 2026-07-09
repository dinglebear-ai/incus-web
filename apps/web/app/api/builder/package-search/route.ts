import { searchPackages } from "@/lib/builder/package-search";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  const results = await searchPackages(query);
  return Response.json({ ok: true, results });
}

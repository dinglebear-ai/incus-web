import { headers } from "next/headers";

import { AuthenticationRequiredError, getActorFromHeaders } from "@/lib/auth/identity";
import { searchPackages } from "@/lib/builder/package-search";
import { jsonError } from "@/lib/workspaces/route-helpers";

export async function GET(request: Request) {
  try {
    getActorFromHeaders(await headers());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return jsonError("authentication_required", error.message, 401);
    }
    throw error;
  }
  const query = new URL(request.url).searchParams.get("q") ?? "";
  const results = await searchPackages(query);
  return Response.json({ ok: true, results });
}

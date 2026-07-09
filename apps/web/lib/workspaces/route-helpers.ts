import type { ProvisionerError } from "@/lib/provisioner/contracts";

export function jsonError(code: string, message: string, status: number) {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

export function provisionerError(error: ProvisionerError) {
  return Response.json({ ok: false, error }, { status: statusForProvisionerError(error) });
}

export function statusForProvisionerError(error: ProvisionerError | undefined) {
  if (!error) return 409;
  if (error.retryable) return 503;
  if (
    error.code === "unauthenticated_service" ||
    error.code === "mutation_not_authorized"
  ) {
    return 403;
  }
  if (error.code === "invalid_input" || error.code === "metadata_mismatch") {
    return 400;
  }
  if (error.code === "missing_controller_config") return 424;
  if (error.code === "not_implemented") return 501;
  return 409;
}

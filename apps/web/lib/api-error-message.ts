export function apiErrorMessage(body: unknown, fallback: string) {
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

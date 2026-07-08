import { timingSafeEqual } from "node:crypto";

export function verifyBearerToken(authorizationHeader, expectedToken) {
  const expected = (expectedToken || "").trim();
  if (!expected) {
    throw new Error("expected token must not be empty");
  }

  const provided = typeof authorizationHeader === "string" ? authorizationHeader : "";
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(`Bearer ${expected}`, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) {
    // Compare against a same-length dummy so a length mismatch doesn't
    // short-circuit in meaningfully less time than a same-length wrong
    // token would take to reject via timingSafeEqual below.
    timingSafeEqual(providedBuffer, providedBuffer);
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function requireConfiguredToken(token, envVarName) {
  const trimmed = (token || "").trim();
  if (!trimmed) {
    throw new Error(`${envVarName} is required`);
  }
  return trimmed;
}

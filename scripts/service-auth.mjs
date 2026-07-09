import { timingSafeEqual } from "node:crypto";

// Fails closed (returns false) rather than throwing on a misconfigured
// (empty) expected token. This is a per-request auth check -- callers must
// not have to wrap every call in a try/catch to stay fail-closed. Use
// requireConfiguredToken at startup to fail loudly (exit the process)
// before any request ever reaches this function; this is the last-resort
// guard if that precondition is somehow bypassed.
export function verifyBearerToken(authorizationHeader, expectedToken) {
  const expected = (expectedToken || "").trim();
  if (!expected) {
    console.error(
      "verifyBearerToken called with an empty expected token -- denying by default",
    );
    return false;
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

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticationRequiredError, getActorFromHeaders } from "./identity";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getActorFromHeaders", () => {
  it("prefers x-auth-request-* headers over other identity sources", () => {
    const actor = getActorFromHeaders(
      new Headers({
        "x-auth-request-email": "primary@example.com",
        "x-forwarded-email": "fallback@example.com",
        "x-auth-request-preferred-username": "primary-user",
        "x-forwarded-user": "fallback-user",
        "x-auth-request-subject": "primary-subject",
      }),
    );

    expect(actor.email).toBe("primary@example.com");
    expect(actor.displayName).toBe("primary-user");
    expect(actor.userId).toBe("oidc:primary-subject");
  });

  it("falls back through the header chain when earlier headers are absent", () => {
    const actor = getActorFromHeaders(
      new Headers({ "x-forwarded-email": "fallback@example.com" }),
    );

    expect(actor.email).toBe("fallback@example.com");
    // displayName and subject both fall back to email when nothing else is set.
    expect(actor.displayName).toBe("fallback@example.com");
    expect(actor.userId).toBe("oidc:fallback@example.com");
  });

  it("uses a dev identity when no identity headers are present outside production", () => {
    vi.stubEnv("NODE_ENV", "development");

    const actor = getActorFromHeaders(new Headers());

    expect(actor.email).toBe("dev@incus-web.local");
  });

  it("fails closed in production when no identity headers are present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "");
    // Isolate this from the separate trusted-proxy-secret requirement
    // (covered by its own tests below) by satisfying it explicitly.
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");

    expect(() =>
      getActorFromHeaders(new Headers({ "x-incus-web-proxy-secret": "shh" })),
    ).toThrow(AuthenticationRequiredError);
  });

  it("allows the dev identity in production when INCUS_WEB_ALLOW_DEV_AUTH=1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "1");

    const actor = getActorFromHeaders(new Headers());

    expect(actor.email).toBe("dev@incus-web.local");
  });

  it("fails closed in production when INCUS_WEB_TRUSTED_PROXY_SECRET is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "");
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "");

    expect(() =>
      getActorFromHeaders(
        new Headers({ "x-auth-request-email": "someone@example.com" }),
      ),
    ).toThrow(/INCUS_WEB_TRUSTED_PROXY_SECRET must be set in production/);
  });

  it("does not require a trusted proxy secret in production when dev auth is explicitly allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "1");
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "");

    const actor = getActorFromHeaders(
      new Headers({ "x-auth-request-email": "someone@example.com" }),
    );

    expect(actor.email).toBe("someone@example.com");
  });

  it("rejects requests missing a matching trusted proxy secret when one is configured", () => {
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");

    expect(() =>
      getActorFromHeaders(
        new Headers({ "x-auth-request-email": "someone@example.com" }),
      ),
    ).toThrow(AuthenticationRequiredError);

    expect(() =>
      getActorFromHeaders(
        new Headers({
          "x-auth-request-email": "someone@example.com",
          "x-incus-web-proxy-secret": "wrong",
        }),
      ),
    ).toThrow(AuthenticationRequiredError);
  });

  it("accepts requests with a matching trusted proxy secret", () => {
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");

    const actor = getActorFromHeaders(
      new Headers({
        "x-auth-request-email": "someone@example.com",
        "x-incus-web-proxy-secret": "shh",
      }),
    );

    expect(actor.email).toBe("someone@example.com");
  });
});

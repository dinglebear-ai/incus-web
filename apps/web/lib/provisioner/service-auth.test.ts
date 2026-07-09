import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requireConfiguredToken,
  verifyBearerToken,
} from "../../../../scripts/service-auth.mjs";

describe("service-auth", () => {
  describe("verifyBearerToken", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("accepts a correctly formatted matching token", () => {
      expect(verifyBearerToken("Bearer secret-token", "secret-token")).toBe(true);
    });

    it("rejects a mismatched token of the same length (exercises the real timingSafeEqual comparison, not the length-mismatch decoy)", () => {
      // "secret-tokfn" is 12 chars, same as "secret-token" -- differs only
      // in the second-to-last character, so this hits the genuine
      // timingSafeEqual(providedBuffer, expectedBuffer) false-comparison
      // path rather than the length-mismatch dummy-buffer branch below.
      expect(verifyBearerToken("Bearer secret-tokfn", "secret-token")).toBe(false);
    });

    it("rejects a mismatched token of a different length", () => {
      expect(verifyBearerToken("Bearer short", "secret-token")).toBe(false);
    });

    it("rejects a missing authorization header", () => {
      expect(verifyBearerToken(undefined, "secret-token")).toBe(false);
    });

    it("rejects a header missing the Bearer prefix", () => {
      expect(verifyBearerToken("secret-token", "secret-token")).toBe(false);
    });

    it("fails closed (returns false, does not throw) if the expected token is empty", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(verifyBearerToken("Bearer x", "")).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("empty expected token"),
      );
    });
  });

  describe("requireConfiguredToken", () => {
    it("returns the trimmed token when present", () => {
      expect(requireConfiguredToken("  secret-token  \n", "TEST_TOKEN")).toBe(
        "secret-token",
      );
    });

    it("throws a descriptive error when unset", () => {
      expect(() => requireConfiguredToken(undefined, "TEST_TOKEN")).toThrow(
        "TEST_TOKEN is required",
      );
    });

    it("throws a descriptive error when empty", () => {
      expect(() => requireConfiguredToken("", "TEST_TOKEN")).toThrow(
        "TEST_TOKEN is required",
      );
    });

    it("throws a descriptive error when whitespace-only", () => {
      expect(() => requireConfiguredToken("   ", "TEST_TOKEN")).toThrow(
        "TEST_TOKEN is required",
      );
    });
  });
});

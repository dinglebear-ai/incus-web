import { describe, expect, it } from "vitest";

import {
  requireConfiguredToken,
  verifyBearerToken,
} from "../../../../scripts/service-auth.mjs";

describe("service-auth", () => {
  describe("verifyBearerToken", () => {
    it("accepts a correctly formatted matching token", () => {
      expect(verifyBearerToken("Bearer secret-token", "secret-token")).toBe(true);
    });

    it("rejects a mismatched token of the same length", () => {
      expect(verifyBearerToken("Bearer wrong-tokennn", "secret-token")).toBe(false);
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

    it("throws if the expected token is empty", () => {
      expect(() => verifyBearerToken("Bearer x", "")).toThrow(
        "expected token must not be empty",
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

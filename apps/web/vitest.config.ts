import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    exclude: [...configDefaults.exclude, "e2e/**"],
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
      exclude: ["components/ui/aurora/**"],
      thresholds: {
        lines: 45,
        functions: 45,
        statements: 45,
        branches: 35,
      },
    },
  },
});

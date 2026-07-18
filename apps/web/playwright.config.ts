import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:3109",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3109",
    url: "http://127.0.0.1:3109/healthz",
    reuseExistingServer: !process.env.CI,
    env: {
      INCUS_WEB_DEV_ACTOR_USER_ID: "e2e-user",
      INCUS_WEB_DEV_ACTOR_EMAIL: "e2e@example.com",
      INCUS_WEB_WORKSPACE_OWNER_MODE: "none",
    },
  },
});

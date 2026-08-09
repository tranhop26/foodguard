import { defineConfig, devices } from "@playwright/test";

const contractAddress = "0x4444444444444444444444444444444444444444";
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export default defineConfig({
  expect: { timeout: 7_500 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "work/playwright-results",
  reporter: [["list"]],
  retries: 0,
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
      env: {
        ...inheritedEnvironment,
        FOODGUARD_NEXT_DIST_DIR: ".next-e2e-ready",
        NEXT_PUBLIC_FOODGUARD_ADDRESS: contractAddress,
        NEXT_PUBLIC_FOODGUARD_APP_ORIGIN: "https://app.foodguard.vn",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://127.0.0.1:3100",
    },
    {
      command: "npm run dev -- --hostname 127.0.0.1 --port 3101",
      env: {
        ...inheritedEnvironment,
        FOODGUARD_NEXT_DIST_DIR: ".next-e2e-deployment-required",
        NEXT_PUBLIC_FOODGUARD_ADDRESS: "",
        NEXT_PUBLIC_FOODGUARD_APP_ORIGIN: "",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://127.0.0.1:3101",
    },
  ],
  workers: 1,
});

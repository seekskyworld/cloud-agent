/** 浏览器验收使用临时数据库与真实 API/Worker，不复用开发数据。 */
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3197",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx --conditions=development scripts/browser-server.ts",
    url: "http://127.0.0.1:3197/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

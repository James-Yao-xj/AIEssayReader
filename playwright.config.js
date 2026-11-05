import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4175', headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', ...(process.env.PLAYWRIGHT_CHROME ? { channel: 'chrome' } : {}) } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4175 --strictPort', url: 'http://127.0.0.1:4175', reuseExistingServer: !process.env.CI },
});

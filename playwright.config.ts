import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './workspace/testing/playwright',
  timeout: 15000,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  reporter: [['list'], ['json', { outputFile: 'workspace/reports/playwright-results.json' }]],
});

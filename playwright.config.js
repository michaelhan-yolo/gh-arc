'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 30000,
  use: {
    headless: true,
    viewport: { width: 1400, height: 900 },
    launchOptions: { args: ['--host-resolver-rules=MAP diffs 127.0.0.1'] },
  },
});

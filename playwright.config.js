'use strict';

const { defineConfig } = require('@playwright/test');

// Each spec file is its own project, so each gets a fresh worker: lib/github.js reads the fake
// GitHub's address once, when it loads.
module.exports = defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 30000,
  use: {
    headless: true,
    viewport: { width: 1400, height: 900 },
    launchOptions: { args: ['--host-resolver-rules=MAP diffs 127.0.0.1'] },
  },
  projects: [
    { name: 'review', testMatch: 'review.spec.js' },
    { name: 'extension', testMatch: 'extension.spec.js' },
  ],
});

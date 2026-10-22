'use strict';

// Loads the browser extension into Chromium and drives github.com pull request pages against a
// gh-arc server backed by the in-memory GitHub. github.com itself is a stub page served by route,
// so nothing reaches the real site.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test: base, expect, chromium } = require('@playwright/test');

const fake = require('../support/fake-github');

const EXTENSION = path.join(__dirname, '../../extension');
const GITHUB = 'https://github.com';
const STUB = '<!doctype html><title>GitHub stub</title><h1 id="stub">GitHub\'s own page</h1>';

let github;
let app;
let server;

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await context.route(`${GITHUB}/**`, (route) => route.fulfill({ contentType: 'text/html', body: STUB }));
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const [worker] = context.serviceWorkers();
    await use(worker || await context.waitForEvent('serviceworker'));
  },
  page: async ({ context, worker }, use) => {
    await worker.evaluate((settings) => chrome.storage.sync.set(settings), { server });
    await use(await context.newPage());
  },
});

test.beforeAll(async () => {
  github = await fake.startFakeGitHub();
  process.env.GH_ARC_API_URL = github.url;
  process.env.GH_ARC_TOKEN = 'test-token';
  process.env.GH_ARC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-arc-ext-'));
  const { createServer } = require('../../lib/server');
  app = createServer({ homeRepo: 'octo/widgets' });
  server = `http://127.0.0.1:${await app.listen(0, '127.0.0.1', true)}`;
});

test.afterAll(async () => {
  await app.close();
  await github.close();
});

// Same-document navigation, the way GitHub moves between its pages.
const softNavigate = (page, pathname) => page.evaluate((to) => window.history.pushState(null, '', to), pathname);

test('a pull request and each of its tabs open in gh-arc', async ({ page }) => {
  await page.goto(`${GITHUB}/octo/widgets/pulls`);
  await page.goto(`${GITHUB}/octo/widgets/pull/2/files`);
  await expect(page).toHaveURL(`${server}/diffs/2`);
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');

  for (const [number, tab] of [[3, ''], [1, '/commits'], [3, '/checks'], [2, '/changes']]) {
    await page.goto(`${GITHUB}/octo/widgets/pull/${number}${tab}`);
    await expect(page).toHaveURL(`${server}/diffs/${number}`);
  }
  await page.goto(`${GITHUB}/octo/widgets/pull/1/commits/${fake.HEAD_OID}`);
  await expect(page).toHaveURL(`${server}/diffs/1?commit=${fake.HEAD_OID}`);
});

test('Back from gh-arc returns to the page before the pull request', async ({ page }) => {
  await page.goto(`${GITHUB}/octo/widgets/pulls`);
  await page.goto(`${GITHUB}/octo/widgets/pull/2`);
  await expect(page).toHaveURL(`${server}/diffs/2`);
  await page.goBack();
  await expect(page).toHaveURL(`${GITHUB}/octo/widgets/pulls`);
  await expect(page.locator('#stub')).toBeVisible();
});

test('landing back on the same pull request right away stays on GitHub instead of looping', async ({ page }) => {
  await page.goto(`${GITHUB}/octo/widgets/pull/2`);
  await expect(page).toHaveURL(`${server}/diffs/2`);
  await page.goto(`${GITHUB}/octo/widgets/pull/2`);
  await expect(page.locator('#stub')).toBeVisible();
  await expect(page).toHaveURL(`${GITHUB}/octo/widgets/pull/2`);
});

test('other GitHub pages stay put, and moving to a pull request in place hands it off', async ({ page }) => {
  for (const pathname of ['/octo/widgets', '/octo/widgets/pulls', '/octo/widgets/issues/2', '/octo/widgets/pull/2/conflicts']) {
    await page.goto(`${GITHUB}${pathname}`);
    await expect(page.locator('#stub')).toBeVisible();
    await expect(page).toHaveURL(`${GITHUB}${pathname}`);
  }
  await page.goto(`${GITHUB}/octo/widgets/pulls`);
  await softNavigate(page, '/octo/widgets/pull/2');
  await expect(page).toHaveURL(`${server}/diffs/2`);
});

test('gh-arc=off keeps GitHub for that pull request in the tab, and gh-arc links back carry it', async ({ page }) => {
  await page.goto(`${GITHUB}/octo/widgets/pull/2?gh-arc=off`);
  await expect(page.locator('#stub')).toBeVisible();
  await softNavigate(page, '/octo/widgets/pull/2/files');
  await page.reload();
  await expect(page).toHaveURL(`${GITHUB}/octo/widgets/pull/2/files`);
  await expect(page.locator('#stub')).toBeVisible();

  await softNavigate(page, '/octo/widgets/pull/3');
  await expect(page).toHaveURL(`${server}/diffs/3`);
  const escape = page.locator('#pr-subheading .github-link');
  await expect(escape).toHaveAttribute('href', `${GITHUB}/octo/widgets/pull/3?gh-arc=off`);
  await escape.click();
  await expect(page).toHaveURL(`${GITHUB}/octo/widgets/pull/3?gh-arc=off`);
  await expect(page.locator('#stub')).toBeVisible();
});

test('the takeover turns off globally and per repository', async ({ page, worker }) => {
  await worker.evaluate(() => chrome.storage.sync.set({ disabledRepos: ['octo/widgets'] }));
  await page.goto(`${GITHUB}/Octo/Widgets/pull/2`);
  await expect(page.locator('#stub')).toBeVisible();
  await page.goto(`${GITHUB}/octo/gadgets/pull/2`);
  await expect(page).toHaveURL(`${server}/diffs/octo/gadgets/2`);

  await worker.evaluate(() => chrome.storage.sync.set({ enabled: false, disabledRepos: [] }));
  await page.goto(`${GITHUB}/octo/gadgets/pull/2`);
  await expect(page.locator('#stub')).toBeVisible();
});

test('with the server down, GitHub\'s page stays and says why', async ({ page, worker }) => {
  await worker.evaluate(() => chrome.storage.sync.set({ server: 'http://127.0.0.1:9' }));
  await page.goto(`${GITHUB}/octo/widgets/pull/2`);
  await expect(page.locator('#stub')).toBeVisible();
  await expect(page.locator('#gh-arc-notice')).toContainText("gh-arc isn't running at 127.0.0.1:9");
  await expect(page).toHaveURL(`${GITHUB}/octo/widgets/pull/2`);

  await worker.evaluate((settings) => chrome.storage.sync.set(settings), { server });
  await page.locator('#gh-arc-notice').getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(`${server}/diffs/2`);
});

test('the popup shows the server and turns the takeover off', async ({ page, worker }) => {
  const id = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${id}/popup.html`);
  await expect(page.locator('#status')).toHaveText(/^Running /);
  await page.locator('#enabled').uncheck();
  await expect.poll(() => worker.evaluate(() => chrome.storage.sync.get('enabled'))).toEqual({ enabled: false });
});

test('on a pull request, the popup turns off its repository and opens it in gh-arc on request', async ({ context, page, worker }) => {
  await page.goto(`${GITHUB}/octo/widgets/pull/2?gh-arc=off`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  // The popup reads the active tab as it loads, so it loads again with GitHub's tab in front.
  await page.bringToFront();
  await popup.reload();
  await expect(popup.locator('#repo-name')).toHaveText('octo/widgets');
  await popup.locator('#repo-enabled').uncheck();
  await expect.poll(() => worker.evaluate(() => chrome.storage.sync.get('disabledRepos'))).toEqual({ disabledRepos: ['octo/widgets'] });
  await popup.locator('#open').click();
  await expect(page).toHaveURL(`${server}/diffs/2`);
});

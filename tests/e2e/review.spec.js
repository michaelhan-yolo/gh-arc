'use strict';

// Drives the review page in Chromium against the in-memory GitHub in tests/support.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const fake = require('../support/fake-github');

let github;
let app;
let base;

test.beforeAll(async () => {
  github = await fake.startFakeGitHub();
  process.env.GH_ARC_API_URL = github.url;
  process.env.GH_ARC_WEB_URL = github.url;
  process.env.GH_ARC_TOKEN = 'test-token';
  process.env.GH_ARC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-arc-e2e-'));
});

test.afterAll(async () => {
  await github.close();
});

// A fresh server per test, so its stack and inbox caches start from the reset GitHub.
test.beforeEach(async () => {
  github.reset();
  fs.rmSync(path.join(process.env.GH_ARC_HOME, 'drafts'), { recursive: true, force: true });
  const { createServer } = require('../../lib/server');
  app = createServer({ homeRepo: 'octo/widgets' });
  const port = await app.listen(0, '127.0.0.1', true);
  base = `http://127.0.0.1:${port}`;
});

test.afterEach(async () => {
  await app.close();
});

const callNames = () => github.state.calls.map((call) => call.name);

test('reviews a stacked pull request: drafts, a range, a reply, then one submitted review', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');
  await expect(page.locator('#stack-nav')).toContainText('Stack 2/3');
  await expect(page.locator('#sidebar-stack .side-stack-entry.current')).toContainText('Add the widget model');
  await expect(page.locator('[data-comment-id="T_live"]')).toContainText('Why 100?');
  await expect(page.locator('.file-title', { hasText: 'docs/old.md → docs/new.md' })).toBeVisible();

  const renamed = page.locator('article.file', { hasText: 'docs/new.md' });
  await renamed.locator('[data-line-handle][data-side="old"][data-line="2"]').click();
  await page.locator('[data-comment-text]').fill('Why remove this?');
  await page.locator('[data-comment-submit]').click();
  await expect(renamed.locator('.inline-comment.draft')).toContainText('Why remove this?');

  const source = page.locator('article.file', { hasText: 'src/app.js' });
  await source.locator('[data-line-handle][data-side="new"][data-line="9"]').hover();
  await page.mouse.down();
  await source.locator('[data-line-handle][data-side="new"][data-line="10"]').hover();
  await page.mouse.up();
  await expect(page.locator('.comment-composer')).toContainText('new lines 9-10');
  await page.locator('[data-comment-text]').fill('Name this constant.');
  await page.locator('[data-comment-text]').press('Control+Enter');
  await expect(source.locator('.inline-comment.draft')).toContainText('Name this constant.');

  await page.locator('[data-comment-reply="T_live"]').click();
  await page.locator('[data-reply-text]').fill('Because 100 is the cap.');
  await page.locator('[data-reply-submit]').click();
  await expect(page.locator('[data-comment-id="T_live"] .draft-reply')).toContainText('Because 100 is the cap.');
  await expect(page.locator('#review-jump .badge')).toHaveText('3');

  await page.locator('#review-jump').click();
  await expect(page.locator('.draft-summary li')).toHaveCount(3);
  await page.locator('[data-review-body]').fill('Please fix.');
  await page.locator('[data-review-event="REQUEST_CHANGES"]').click();
  await page.locator('[data-review-submit]').click();
  await expect(page.locator('#toast')).toContainText('Requested changes');
  await expect(page.locator('.draft-summary')).toHaveCount(0);
  await expect(page.locator('.activity-card.changes')).toContainText('Please fix.');

  expect(callNames()).toEqual([
    'addPullRequestReview',
    'addPullRequestReviewThread',
    'addPullRequestReviewThread',
    'addPullRequestReviewThreadReply',
    'submitPullRequestReview',
  ]);
  const inputs = github.state.calls.map((call) => call.input);
  expect(inputs[1]).toMatchObject({ path: 'docs/new.md', side: 'LEFT', line: 2 });
  expect(inputs[2]).toMatchObject({ path: 'src/app.js', side: 'RIGHT', startLine: 9, line: 10 });
  expect(inputs[3]).toMatchObject({ pullRequestReviewThreadId: 'T_live' });
  expect(inputs[4]).toMatchObject({ event: 'REQUEST_CHANGES', body: 'Please fix.' });
});

test('an open review survives a server restart and submits exactly once', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const source = page.locator('article.file', { hasText: 'src/app.js' });
  await source.locator('[data-line-handle][data-side="new"][data-line="21"]').click();
  await page.locator('[data-comment-text]').fill('Keep this inline draft.');
  await page.locator('[data-comment-submit]').click();
  await expect(source.locator('.inline-comment.draft')).toContainText('Keep this inline draft.');

  const oldToken = app.sessionToken;
  const port = app.port;
  await app.close();
  app = require('../../lib/server').createServer({ homeRepo: 'octo/widgets' });
  await app.listen(port, '127.0.0.1', true);
  expect(app.sessionToken).not.toBe(oldToken);

  const requests = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/submit')) requests.push(request);
  });
  // Submit before the debounced draft save, so the submission itself has the old token.
  await page.locator('[data-review-body]').evaluate((textarea) => {
    window.restartMarker = true;
    textarea.value = 'Keep this unsaved review summary.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-review-submit]').click();
  });
  await expect(page.locator('#toast')).toContainText('Review submitted');
  await expect(page.locator('.draft-summary')).toHaveCount(0);
  expect(await page.evaluate(() => window.restartMarker)).toBe(true);
  expect(requests.map((request) => request.headers()['x-gh-arc-token'])).toEqual([oldToken, app.sessionToken]);
  expect(requests.map((request) => request.postDataJSON().body))
    .toEqual(['Keep this unsaved review summary.', 'Keep this unsaved review summary.']);
  expect(callNames()).toEqual(['addPullRequestReview', 'addPullRequestReviewThread', 'submitPullRequestReview']);
  expect(github.state.calls[1].input.body).toBe('Keep this inline draft.');
  expect(github.state.calls[2].input.body).toBe('Keep this unsaved review summary.');
  expect(await page.locator('meta[name="gh-arc-token"]').getAttribute('content')).toBe(app.sessionToken);
});

for (const refreshToken of [false, true]) {
  test(`review errors ${refreshToken ? 'stop after one token refresh' : 'do not retry ordinary permission failures'}`, async ({ page }) => {
    let requests = 0;
    await page.route('**/api/pr/octo/widgets/2/submit', async (route) => {
      requests++;
      await route.fulfill({ status: 403, contentType: 'application/json',
        headers: refreshToken ? { 'X-GH-Arc-Token': 'replacement-token' } : {},
        body: JSON.stringify({ error: 'Review rejected' }) });
    });
    await page.goto(`${base}/diffs/2`);
    await page.locator('[data-review-body]').fill('Keep my summary.');
    await page.locator('[data-review-submit]').click();
    await expect(page.locator('.review-error')).toHaveText('Review rejected');
    await expect(page.locator('[data-review-body]')).toHaveValue('Keep my summary.');
    expect(requests).toBe(refreshToken ? 2 : 1);
    expect(callNames()).toEqual([]);
  });
}

test('drafts survive a reload, and a rejected one shows its error', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const source = page.locator('article.file', { hasText: 'src/app.js' });
  await source.locator('[data-line-handle][data-side="new"][data-line="21"]').click();
  await page.locator('[data-comment-text]').fill('[fail] GitHub rejects this one');
  await page.locator('[data-comment-submit]').click();
  await expect(source.locator('.inline-comment.draft')).toHaveCount(1);

  await page.reload();
  await expect(source.locator('.inline-comment.draft')).toContainText('GitHub rejects this one');
  await page.locator('[data-review-body]').fill('Overall fine.');
  await page.locator('[data-review-submit]').click();
  await expect(page.locator('.review-error')).toContainText("1 comment couldn't be posted");
  await expect(source.locator('.inline-comment.draft .comment-error')).toContainText('must be part of the diff');
  expect(callNames()).not.toContain('submitPullRequestReview');
});

test('context expands from the merge base, files mark viewed, threads resolve', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const source = page.locator('article.file', { hasText: 'src/app.js' });
  await source.locator('[data-context="after"]').first().click();
  await expect(source.locator('td.code', { hasText: 'const v15 = 15;' })).toHaveCount(2);
  await expect(source.locator('.line-plain', { hasText: '15' })).toHaveCount(2);

  await source.locator('[data-viewed]').check();
  await expect(source).toHaveClass(/collapsed/);
  await expect(page.locator('.file-link.viewed')).toHaveCount(1);
  await expect.poll(() => github.state.viewed['src/app.js']).toBe(true);
  await source.locator('[data-file-toggle]').click();

  await page.locator('[data-resolve="T_live"]').click();
  await expect(page.locator('[data-comment-id="T_live"]')).toHaveClass(/resolved/);
  await expect(page.locator('[data-comment-id="T_live"]')).toHaveClass(/collapsed/);
  await expect.poll(() => github.state.threads[0].isResolved).toBe(true);
});

test('keys walk the stack and the changes picker narrows the diff', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('#stack-nav')).toBeVisible();
  await page.locator('[data-range-select]').selectOption('since');
  await expect(page).toHaveURL(new RegExp(`diff=${fake.LAST_REVIEWED_OID}..${fake.HEAD_OID}`));
  await expect(page.locator('.range-banner')).toContainText('since your last review');
  await expect(page.locator('[data-line-handle][data-side="old"]')).toHaveCount(0);
  await expect(page.locator('[data-line-handle][data-side="new"]').first()).toBeVisible();

  await page.locator('body').press(']');
  await expect(page).toHaveURL(`${base}/diffs/3`);
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('#stack-nav')).toBeVisible();
  await page.locator('body').press('[');
  await expect(page).toHaveURL(`${base}/diffs/1`);
});

test('two versions compare without the base changes merged in between', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const toggle = page.locator('[data-versions-menu-toggle]');
  await expect(toggle).toHaveText(/Base → V3/);
  await expect(page.locator('.versions-table')).toHaveCount(0);
  await toggle.click();
  const table = page.locator('.versions-menu .versions-table');
  await expect(table.locator('.version-name')).toHaveText(['Base', /^V1\s*force-pushed/, /^V2\s*you reviewed/, /^V3\s*latest/]);
  await expect(page.locator('[data-versions-show]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('.versions-menu')).toHaveCount(0);
  await page.locator('body').press('v');

  await table.locator(`input[data-version-pick="from"][value="${fake.FORCED_OID}"]`).check();
  await expect(table.locator(`input[data-version-pick="to"][value="${fake.FORCED_OID}"]`)).toBeDisabled();
  await table.locator(`input[data-version-pick="from"][value="${fake.LAST_REVIEWED_OID}"]`).check();
  await page.locator('[data-versions-show]').click();
  await expect(page).toHaveURL(`${base}/diffs/2?diff=${fake.LAST_REVIEWED_OID}..${fake.HEAD_OID}`);

  await expect(page.locator('[data-versions-menu-toggle]')).toHaveText(/V2 → V3/);
  await expect(page.locator('.range-banner')).toContainText('what changed from V2');
  await expect(page.locator('.range-banner')).toContainText('left out');
  const source = page.locator('article.file', { hasText: 'src/app.js' });
  await expect(source.locator('.file-status.rebased')).toHaveText('Base changes left out');
  await expect(source.locator('td.code.old')).toHaveText(['const v10 = 99;']);
  await expect(source.locator('td.code.new')).toHaveText(['const v10 = 100;', 'const extra = true;']);
  await expect(source.locator('[data-context]')).toHaveCount(0);
  await expect(page.locator('.file-title', { hasText: 'docs/old.md → docs/new.md' })).toBeVisible();

  await page.goto(`${base}/diffs/2?diff=${fake.LAST_REVIEWED_OID}..${fake.LAST_REVIEWED_OID}`);
  await expect(page.locator('.empty')).toContainText('V2 and V2 differ only by what was merged in from the base');
});

test('the stack button opens a menu of the whole stack', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await page.locator('[data-stack-menu-toggle]').click();
  const menu = page.locator('.stack-menu');
  await expect(menu.locator('a.stack-menu-item .stack-number')).toHaveText(['#3', '#2', '#1']);
  await expect(menu.locator('.stack-menu-item.current')).toContainText('Render widgets');
  await expect(menu.locator('.stack-menu-trunk')).toHaveText('main');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await page.locator('body').press('s');
  await expect(page.locator('.stack-menu')).toBeVisible();
  await page.mouse.click(1300, 850);
  await expect(page.locator('.stack-menu')).toHaveCount(0);

  await page.locator('[data-versions-menu-toggle]').click();
  await page.locator('[data-stack-menu-toggle]').click();
  await expect(page.locator('.versions-menu')).toHaveCount(0);
  await page.locator('.stack-menu a', { hasText: 'Animate widgets' }).click();
  await expect(page).toHaveURL(`${base}/diffs/3`);
});

test('the sidebar lists stacks only, one row each, with the one on screen marked', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const sidebar = page.locator('#sidebar-stack');
  await expect(sidebar.locator('.side-stack-heading')).toHaveText([/Viewing/, /Your stacks\s*1/]);
  const current = sidebar.locator('.side-stack-entry.current');
  await expect(current.locator('.side-group-label')).toHaveText('Add the widget model');
  await expect(current.locator('.side-group-count')).toHaveText('2/3');
  await expect(sidebar.locator('.side-stack-entry')).toHaveCount(2);
  await expect(sidebar).not.toContainText('Fix a typo');
  await expect(page.locator('#files-heading')).toHaveText('Displaying 2 files (1 modified, 0 added, 0 deleted, 1 renamed)');
  await expect(page.locator('.sidebar-files .file-link')).toHaveCount(2);
  await expect(page.locator('.sidebar-files .file-link .file-kind')).toHaveText(['R', 'M']);

  const docs = sidebar.locator('a.side-stack-entry', { hasText: 'Widget docs' });
  await expect(docs.locator('.side-group-count')).toHaveText('2');
  await docs.click();
  await expect(page).toHaveURL(`${base}/diffs/20`);
});

test('switching pull requests happens in place: sidebar, stack keys, back and forward', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');
  await page.evaluate(() => {
    window.stillTheSamePage = true;
  });
  const stillTheSamePage = () => page.evaluate(() => window.stillTheSamePage === true);

  await page.locator('#sidebar-stack a.side-stack-entry', { hasText: 'Widget docs' }).click();
  await expect(page).toHaveURL(`${base}/diffs/20`);
  await expect(page.locator('#pr-heading')).toContainText('octo/widgets#20');
  expect(await stillTheSamePage()).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL(`${base}/diffs/2`);
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');
  await expect(page.locator('#stack-nav')).toContainText('Stack 2/3');
  await page.locator('body').press('[');
  await expect(page.locator('.pr-title')).toHaveText('Add the widget model');
  await expect(page.locator('#stack-nav')).toContainText('Stack 1/3');
  await expect(page.locator('#sidebar-stack .side-stack-entry.current .side-group-count')).toHaveText('1/3');
  expect(await stillTheSamePage()).toBe(true);

  await page.locator('[data-comment-reply="T_live"]').click();
  await page.locator('[data-reply-text]').fill('half-written');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#stack-nav a.stack-step', { hasText: '#2' }).click();
  await expect(page).toHaveURL(`${base}/diffs/1`);
  await expect(page.locator('[data-reply-text]')).toHaveValue('half-written');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#stack-nav a.stack-step', { hasText: '#2' }).click();
  await expect(page).toHaveURL(`${base}/diffs/2`);
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');
  expect(await stillTheSamePage()).toBe(true);
});

test('people come before the code, inline comments included, and bots after it', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const discussion = page.locator('#discussion');
  const cards = discussion.locator('.activity-card');
  await expect(cards).toHaveCount(4);
  const threads = discussion.locator('.thread-card');
  await expect(threads.filter({ hasText: 'alice commented on src/app.js:10' })).toContainText('Why 100?');
  await expect(threads.filter({ hasText: 'bob commented on src/app.js:5' })).toContainText('Outdated');
  await expect(cards.nth(2)).toContainText('alice commented');
  await expect(cards.nth(2)).toContainText('Looks close.');
  await expect(cards.nth(3)).toContainText('me reviewed');
  await expect(discussion).not.toContainText('Tests PASSED');

  const order = await page.evaluate(() => {
    const at = (node) => Array.from(document.querySelectorAll('#discussion, article.file, #bot-comments')).indexOf(node);
    return {
      discussion: at(document.getElementById('discussion')),
      firstFile: at(document.querySelector('article.file')),
      bots: at(document.getElementById('bot-comments')),
      files: document.querySelectorAll('article.file').length,
    };
  });
  expect(order).toEqual({ discussion: 0, firstFile: 1, bots: order.files + 1, files: order.files });
  await expect(page.locator('#bot-comments details')).not.toHaveAttribute('open', '');

  await discussion.locator('[data-show-bots]').click();
  await expect(page.locator('#bot-comments details')).toHaveAttribute('open', '');
  await expect(page.locator('#bot-comments')).toContainText('github-actions');
  await expect(page.locator('#bot-comments')).toContainText('Tests PASSED');

  await page.locator('#discussion [data-jump-comment="T_live"]').first().click();
  await expect(page.locator('article.file [data-comment-id="T_live"]')).toBeInViewport();
});

test('the header carries the status, checks and stack, and its tabs jump to each section', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('#pr-heading')).toHaveText('#2 Render widgets');
  await expect(page.locator('#checks-pill')).toHaveText('1 check failed');
  await expect(page.locator('#pr-subheading')).toContainText('Updated');
  const tabs = page.locator('#page-tabs .page-tab');
  await expect(tabs).toHaveText(['Summary', 'Details', /Discussion\s*4/, /Code\s*\+3 -2/]);
  await expect(tabs.first()).toHaveClass(/active/);
  await tabs.filter({ hasText: 'Code' }).click();
  await expect(page.locator('article.file').first()).toBeInViewport();
  await expect(tabs.filter({ hasText: 'Code' })).toHaveClass(/active/);

  await page.locator('[data-section-toggle="description"]').click();
  await expect(page.locator('.diff-description')).toHaveCount(0);
  await expect(page.locator('[data-section-toggle="description"]')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-section-toggle="description"]').click();
  await expect(page.locator('.diff-description')).toBeVisible();
});

test('the layout buttons switch between side by side and unified', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('table.diff-table.split').first()).toBeVisible();
  await page.locator('#mode-unified').click();
  await expect(page.locator('table.diff-table.unified').first()).toBeVisible();
  await page.locator('#mode-split').click();
  await expect(page.locator('table.diff-table.split').first()).toBeVisible();
  await expect(page.locator('#mode-split')).toHaveClass(/active/);
});

test('a chosen theme overrides the system and persists across reloads, pages and tabs', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${base}/diffs/2`);
  const theme = page.getByRole('combobox', { name: 'Color theme' });
  await theme.selectOption('dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 25, 27)');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');

  await page.reload();
  await expect(theme).toHaveValue('dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 25, 27)');

  const inbox = await context.newPage();
  await inbox.goto(base);
  const inboxTheme = inbox.getByRole('combobox', { name: 'Color theme' });
  await expect(inboxTheme).toHaveValue('dark');
  await expect(inbox.locator('body')).toHaveCSS('background-color', 'rgb(24, 25, 27)');
  await inbox.emulateMedia({ colorScheme: 'dark' });
  await inboxTheme.selectOption('light');
  await expect(inbox.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(theme).toHaveValue('light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('System theme follows appearance changes and can be restored after an override', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${base}/diffs/2`);
  const theme = page.getByRole('combobox', { name: 'Color theme' });
  await expect(theme).toHaveValue('system');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 25, 27)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  await theme.selectOption('dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 25, 27)');
  await theme.selectOption('system');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('both pages carry the app icon, and the one on a pull request leads to the inbox', async ({ page }) => {
  const icon = await page.request.get(`${base}/assets/icon.svg`);
  expect(icon.headers()['content-type']).toBe('image/svg+xml');

  await page.goto(`${base}/`);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/assets/icon.svg');
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/assets/icon.svg');
  const logo = page.locator('.home-link .app-icon');
  await expect.poll(() => logo.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('.home-link').click();
  await expect(page).toHaveURL(`${base}/`);
});

test('the handle between your stacks and the files resizes them and remembers where it was', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const stacks = page.locator('#sidebar-stack');
  const handle = page.locator('#sidebar-split');
  await expect(page.locator('.side-stack-entry.current')).toBeVisible();
  const sidebar = await page.locator('.sidebar').boundingBox();
  const before = (await stacks.boundingBox()).height;
  expect(before / sidebar.height).toBeGreaterThan(0.6);

  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + 20, grip.y + 3);
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, sidebar.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await stacks.boundingBox()).height)).toBeLessThan(210);

  await page.reload();
  await expect(page.locator('.side-stack-entry.current')).toBeVisible();
  expect((await stacks.boundingBox()).height).toBeLessThan(210);
  await handle.dblclick();
  await expect.poll(async () => (await stacks.boundingBox()).height / sidebar.height).toBeGreaterThan(0.6);
});

const shipCalls = () => github.state.calls
  .filter((call) => ['mergePullRequest', 'updatePullRequest', 'deleteRef'].includes(call.name))
  .map((call) => `${call.name} ${typeof call.input === 'string' ? call.input : call.input.pullRequestId}`);

test('a pull request under review shows a yellow status, and reviewers get the review tools', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const status = page.locator('[data-status-toggle]');
  await expect(status).toHaveText('Under review');
  await expect(status).toHaveClass(/status-review/);
  await expect(page.locator('#review-jump')).toBeVisible();
  await status.click();
  await expect(page.locator('.status-popover')).toContainText('Ship it shows up here once a reviewer accepts.');
  await expect(page.locator('.status-popover .reviewer')).toContainText('me');
  await expect(page.locator('.status-popover .status-actions')).toHaveCount(0);
});

test('asking a blocking reviewer again turns changes requested back into under review', async ({ page }) => {
  github.state.prs[1].blockedBy = 'kent';
  await page.goto(`${base}/diffs/1`);
  const status = page.locator('[data-status-toggle]');
  await expect(status).toHaveText('Changes requested');
  await status.click();
  const popover = page.locator('.status-popover');
  await expect(popover.locator('[data-status-reviewer="kent"]')).toBeChecked();
  await popover.locator('[data-status-more]').fill('@alice');
  await popover.locator('[data-status-change="review"]').click();
  await expect(page.locator('#toast')).toContainText('Asked kent, alice for a review.');
  await expect(status).toHaveText('Under review');
  await status.click();
  await expect(popover.locator('.reviewer-requested')).toHaveText([/kent/, /alice/]);
  await expect(popover.locator('[data-status-reviewer]')).toHaveCount(0);
  expect(github.state.calls.map((call) => call.input)).toEqual([{ pullRequestId: 'PR_1', userLogins: ['kent', 'alice'], union: true }]);
});

test('the author moves a pull request to a draft and back, closes it and reopens it', async ({ page }) => {
  await page.goto(`${base}/diffs/1`);
  const status = page.locator('[data-status-toggle]');
  const change = (action) => page.locator(`.status-popover [data-status-change="${action}"]`);
  await expect(status).toHaveText('Under review');

  await status.click();
  await expect(change('review')).toHaveText('Request review');
  await change('review').click();
  await expect(page.locator('.status-error')).toHaveText('Pick someone to ask for a review.');
  await change('draft').click();
  await expect(status).toHaveText('Draft');

  await status.click();
  await expect(change('draft')).toHaveCount(0);
  await expect(change('review')).toHaveText('Ready for review');
  await change('review').click();
  await expect(page.locator('#toast')).toContainText('#1 is ready for review.');
  await expect(status).toHaveText('Under review');

  await status.click();
  await change('close').click();
  await expect(status).toHaveText('Closed');
  await status.click();
  await expect(change('review')).toHaveCount(0);
  await change('reopen').click();
  await expect(status).toHaveText('Under review');
  expect(callNames()).toEqual(['convertPullRequestToDraft', 'markPullRequestReadyForReview', 'closePullRequest', 'reopenPullRequest']);
});

test('your own accepted pull request hides the review tools and ships with one click', async ({ page }) => {
  github.state.prs[1].approved = true;
  await page.goto(`${base}/diffs/1`);
  await expect(page.locator('.pr-title')).toHaveText('Add the widget model');
  await expect(page.locator('#review-jump')).toBeHidden();
  await expect(page.locator('#review-panel .metadata-header')).toContainText('Comments');
  await expect(page.locator('[data-review-event]')).toHaveCount(0);
  await expect(page.locator('[data-review-submit]')).toHaveText('Post comments');

  const ship = page.locator('[data-status-toggle]');
  await expect(ship).toHaveText('Ship it');
  await expect(ship).not.toHaveClass(/blocked/);
  await ship.click();
  const popover = page.locator('.status-popover');
  await expect(popover.locator('.ship-heading')).toHaveText(/Ship #1 into main/);
  await expect(popover).toContainText('Afterwards #2 moves onto main.');
  await expect(popover.locator('[data-ship-method]')).toHaveText(['Merge commit', 'Squash', 'Rebase']);
  await popover.locator('[data-ship-confirm]').click();
  await expect(page.locator('#toast')).toContainText('Shipped #1 into main.');
  await expect(page.locator('[data-status-toggle]')).toHaveText('Merged');
  expect(shipCalls()).toEqual(['mergePullRequest PR_1', 'updatePullRequest PR_2']);
});

test('a failed reviewer request shows the published draft and preserves the reviewer input', async ({ page }) => {
  github.state.prs[1].draft = true;
  github.state.prs[1].failReviewRequest = true;
  await page.goto(`${base}/diffs/1`);
  const status = page.locator('[data-status-toggle]');
  await expect(status).toHaveText('Draft');
  await status.click();
  const popover = page.locator('.status-popover');
  await popover.locator('[data-status-more]').fill('kent');
  await popover.locator('[data-status-change="review"]').click();
  await expect(popover.locator('.status-error')).toHaveText('Could not resolve the requested reviewer.');
  await expect(status).toHaveText('Under review');
  await expect(popover.locator('[data-status-more]')).toHaveValue('kent');
  await expect(popover.locator('[data-status-change="review"]')).toHaveText('Request review');
  expect(callNames()).toEqual(['markPullRequestReadyForReview', 'requestReviewsByLogin']);
  github.state.prs[1].failReviewRequest = false;
  await popover.locator('[data-status-change="review"]').click();
  await expect(page.locator('#toast')).toContainText('Asked kent for a review.');
  expect(callNames()).toEqual(['markPullRequestReadyForReview', 'requestReviewsByLogin', 'requestReviewsByLogin']);
});

test('shipping higher in the stack lands everything below it first', async ({ page }) => {
  github.state.prs[1].approved = true;
  github.state.prs[2].approved = true;
  await page.goto(`${base}/diffs/2`);
  const ship = page.locator('[data-status-toggle]');
  await expect(ship).toHaveText(/Ship it\s*2/);
  await ship.click();
  const popover = page.locator('.status-popover');
  await expect(popover.locator('.ship-heading')).toHaveText(/Ship 2 pull requests, bottom first, into main/);
  await expect(popover.locator('.ship-item .side-stack-number')).toHaveText(['#1', '#2']);
  await expect(popover.locator('[data-ship-method]')).toHaveText(['Merge commit', 'Squash']);
  await popover.locator('[data-ship-delete]').check();
  await popover.locator('[data-ship-confirm]').click();
  await expect(page.locator('#toast')).toContainText('Shipped #1, #2 into main.');
  expect(shipCalls()).toEqual([
    'mergePullRequest PR_1',
    'deleteRef feat-a',
    'updatePullRequest PR_2',
    'mergePullRequest PR_2',
    'deleteRef feat-b',
    'updatePullRequest PR_3',
  ]);
  expect(github.state.prs[3].baseRefName).toBe('main');
});

test('ship it waits on every pull request below, and stops at the first failure', async ({ page }) => {
  github.state.prs[2].approved = true;
  await page.goto(`${base}/diffs/2`);
  const ship = page.locator('[data-status-toggle]');
  await expect(ship).toHaveClass(/blocked/);
  await ship.click();
  await expect(page.locator('.ship-blocked')).toHaveText('Waiting on #1 to be accepted.');
  await expect(page.locator('[data-ship-confirm]')).toBeDisabled();

  github.state.prs[1].approved = true;
  github.state.prs[2].failMerge = true;
  await page.reload();
  await page.locator('[data-status-toggle]').click();
  await page.locator('[data-ship-confirm]').click();
  await expect(page.locator('#toast')).toContainText('Shipped #1; the next one failed.');
  await expect(page.locator('.ship-item.ship-failed')).toContainText('Required status check "lint" is failing.');
  expect(shipCalls()).toEqual(['mergePullRequest PR_1', 'updatePullRequest PR_2', 'mergePullRequest PR_2']);
});

test('a pull request can retry failed loads without reloading the page', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/pr/octo/widgets/2/pr', async (route) => {
    requests++;
    if (requests <= 2) {
      await route.fulfill({ status: 502, contentType: 'application/json',
        body: JSON.stringify({ error: 'GitHub is temporarily unavailable (HTTP 502). Try again in a moment.' }) });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('[data-region="pr"]')).toContainText('GitHub is temporarily unavailable (HTTP 502)');
  await page.evaluate(() => { window.retryMarker = true; });
  await page.locator('[data-region-retry="pr"]').click();
  await expect(page.locator('[data-region-retry="pr"]')).toBeEnabled();
  await expect(page.locator('[data-region="pr"]')).toContainText('GitHub is temporarily unavailable');
  await page.locator('[data-region-retry="pr"]').click();
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');
  await expect(page.locator('[data-region="pr"]')).toHaveCount(0);
  await expect(page.locator('article.file', { hasText: 'src/app.js' })).toBeVisible();
  expect(await page.evaluate(() => window.retryMarker)).toBe(true);
  expect(requests).toBe(3);
});

test('the inbox can retry a failed load without reloading the page', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/inbox', async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 502, contentType: 'application/json',
        body: JSON.stringify({ error: 'GitHub is temporarily unavailable (HTTP 502). Try again in a moment.' }) });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${base}/`);
  await expect(page.locator('.fatal')).toContainText('GitHub is temporarily unavailable');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#viewer-login')).toHaveText('Signed in to GitHub as me');
  await expect(page.locator('.fatal')).toHaveCount(0);
  await expect(page.locator('.inbox-section', { hasText: 'Your pull requests' }).locator('.inbox-number'))
    .toHaveText(['#21', '#20', '#30']);
  expect(requests).toBe(2);
});

test('the inbox draws each stack top first over its trunk', async ({ page }) => {
  await page.goto(`${base}/`);
  const stack = page.locator('.inbox-section', { hasText: 'Needs your review' }).locator('.inbox-group.is-stack');
  await expect(stack.locator('.inbox-number')).toHaveText(['#3', '#2', '#1']);
  await expect(stack.locator('.inbox-trunk')).toHaveText('main');
  await page.locator('#open-input').fill('https://github.com/octo/widgets/pull/2/files');
  await page.locator('#open-input').press('Enter');
  await expect(page).toHaveURL(`${base}/diffs/2`);
});

test('the inbox sidebar and the repository chips narrow what it lists', async ({ page }) => {
  await page.goto(`${base}/`);
  const nav = page.locator('#home-nav .home-nav-item');
  await expect(nav).toHaveText(['All pull requests', /Needs your review\s*3/, /Your pull requests\s*3/, /Reviewed by you\s*1/, 'Landed diffs']);
  await nav.filter({ hasText: 'Your pull requests' }).click();
  await expect(page).toHaveURL(`${base}/#mine`);
  await expect(page.locator('.inbox-section')).toHaveCount(1);
  await expect(page.locator('#filter-chips')).toHaveText('Section is Your pull requests');
  await page.locator('.quick-filter', { hasText: 'octo/widgets' }).click();
  await expect(page.locator('#filter-chips .filter-chip')).toHaveCount(2);
  await page.locator('.quick-filter-clear').click();
  await expect(page.locator('.inbox-section')).toHaveCount(4);
  await expect(page.locator('#filter-chips .filter-chip')).toHaveCount(0);

  await page.goto(`${base}/diffs/2`);
  await page.locator('.rail-link[title="Reviewed by you"]').click();
  await expect(page).toHaveURL(`${base}/#reviewed`);
  await expect(page.locator('.inbox-section')).toHaveText(/Reviewed by you/);
});

test('landed diffs lists only your merges, newest first, and opens from the left rail', async ({ page }) => {
  Object.assign(github.state.prs[1], { author: 'me', merged: true, mergedAt: '2026-10-01T10:00:00Z' });
  Object.assign(github.state.prs[2], { author: 'me', merged: true, mergedAt: '2026-10-03T10:00:00Z' });
  Object.assign(github.state.prs[3], { author: 'alice', merged: true });
  Object.assign(github.state.prs[30], { closed: true });
  await page.goto(`${base}/diffs/2`);
  await page.getByRole('link', { name: 'Landed diffs', exact: true }).click();
  await expect(page).toHaveURL(`${base}/#landed`);
  await expect(page.locator('.inbox-section')).toHaveCount(1);
  await expect(page.locator('#home-nav .home-nav-item.active')).toHaveText(/Landed diffs\s*2/);
  await expect(page.locator('.inbox-number')).toHaveText(['#2', '#1']);
  await expect(page.locator('.inbox-badges')).toHaveText(['Merged', 'Merged']);
  await expect(page.locator('.inbox-group.is-stack')).toHaveCount(0);
  await page.locator('.quick-filter', { hasText: 'octo/widgets' }).click();
  await expect(page.locator('.inbox-number')).toHaveText(['#2', '#1']);
  await page.reload();
  await expect(page.locator('.inbox-number')).toHaveText(['#2', '#1']);
  await page.locator('.inbox-row', { hasText: 'Render widgets' }).click();
  await expect(page).toHaveURL(`${base}/diffs/2`);
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');
});

test('landed diffs keeps an empty section accessible', async ({ page }) => {
  await page.goto(`${base}/#landed`);
  await expect(page.locator('#home-nav .home-nav-item.active')).toHaveText('Landed diffs');
  await expect(page.locator('.inbox-empty')).toHaveText('Nothing here.');
});

test('uploaded images in the description load from gh-arc after their signed links expire', async ({ page }) => {
  await page.goto(`${base}/diffs/3`);
  const images = page.locator('.diff-description img');
  await expect(images).toHaveCount(2);
  expect(await images.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src')))).toEqual([
    '/api/image/11111111-1111-4111-8111-111111111111',
    '/api/image/22222222-2222-4222-8222-222222222222',
  ]);
  await expect.poll(() => images.evaluateAll((nodes) => nodes.map((node) => node.naturalWidth))).toEqual([420, 1600]);
  // width="420" holds inside the screenshot table, and the wide one stays inside the column.
  expect((await images.nth(0).boundingBox()).width).toBe(420);
  const description = page.locator('.diff-description');
  expect(await description.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.locator('.diff-description a').first()).toHaveAttribute('href', '/api/image/11111111-1111-4111-8111-111111111111');
});

test('private repository screenshots load in the description and review comments', async ({ page }) => {
  const source = `https://github.com/octo/widgets/blob/${fake.PR3_HEAD}/assets/logo.png?raw=true`;
  const html = `<a href="${source}"><img src="${source}" width="360" alt="Before report modal"></a>`;
  github.state.bodyHTML = `<table><tr><td>${html}</td></tr></table>`;
  github.state.threads[0].comments.nodes[0].bodyHTML = html;
  // No signed-in GitHub browser session is available to retrieve these private files.
  await page.route('https://github.com/**', route => route.abort());
  await page.goto(`${base}/diffs/2`);
  await page.locator('#file-list .file-link', { hasText: 'app.js' }).click();
  const images = page.locator('.diff-description img, .inline-comment img[alt="Before report modal"]');
  await expect(images).toHaveCount(2);
  await expect.poll(() => images.evaluateAll(nodes => nodes.map(node => node.naturalWidth))).toEqual([160, 160]);
  await expect(page.locator('.diff-description img')).toHaveAttribute('width', '360');
  const href = await page.locator('.diff-description a').getAttribute('href');
  expect(href).toBe(`/api/repo/octo/widgets/image?ref=${fake.PR3_HEAD}&path=assets%2Flogo.png`);
  const opened = await page.request.get(`${base}${href}`);
  expect(opened.status()).toBe(200);
  expect(opened.headers()['content-type']).toBe('image/png');
});

test('image files show before and after, with swipe and flip', async ({ page }) => {
  await page.goto(`${base}/diffs/3`);
  const logo = page.locator('article.file', { hasText: 'assets/logo.png' });
  await page.locator('#file-list .file-link', { hasText: 'logo.png' }).click();
  await expect(logo.locator('.image-side figcaption')).toHaveText(['Before · 160 × 100', 'After · 160 × 100']);
  await expect(logo).not.toContainText('Binary files');
  const badge = page.locator('article.file', { hasText: 'assets/badge.png' });
  await page.locator('#file-list .file-link', { hasText: 'badge.png' }).click();
  await expect(badge.locator('.image-side figcaption')).toHaveText(['Added · 80 × 80']);
  await expect(badge.locator('[data-image-mode]')).toHaveCount(0);
  const icon = page.locator('article.file', { hasText: 'assets/icon.svg' });
  await page.locator('#file-list .file-link', { hasText: 'icon.svg' }).click();
  await expect(icon.locator('.image-side figcaption')).toHaveText(['Deleted · 64 × 64']);
  await expect(icon.locator('.code-table, table').first()).toContainText('<rect');

  await logo.locator('[data-image-mode="swipe"]').click();
  await expect(page.locator('[data-image-swipe]')).toHaveCount(1);
  await logo.locator('[data-image-swipe]').fill('20');
  await expect(logo.locator('.image-diff')).toHaveAttribute('style', /--swipe: 20%/);

  await logo.locator('[data-image-mode="flip"]').click();
  await expect(logo.locator('.image-old')).toBeHidden();
  await logo.locator('[data-image-flip]').click();
  await expect(logo.locator('.image-old')).toBeVisible();
  await expect(logo.locator('.image-new')).toBeHidden();
  await page.reload();
  await page.locator('#file-list .file-link', { hasText: 'logo.png' }).click();
  await expect(logo.locator('.image-diff')).toHaveAttribute('data-mode', 'flip');
});

// playwright.config.js maps the diffs host to 127.0.0.1 in Chromium, as gh arc setup does for the Mac.
test.describe('under the diffs host', () => {
  test('pages live at diffs/<number> and every link stays short', async ({ page }) => {
    const port = new URL(base).port;
    await page.goto(`http://diffs:${port}/2`);
    await expect(page.locator('.pr-title')).toHaveText('Render widgets');
    await expect(page.locator('#stack-nav a.stack-step')).toHaveText(['‹ #1', '#3 ›']);
    expect(await page.locator('#stack-nav a.stack-step').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(['/1', '/3']);
    await expect(page.locator('#sidebar-stack a.side-stack-entry')).toHaveAttribute('href', '/20');
    await expect(page.locator('.diff-description a')).toHaveAttribute('href', '/1');
    await page.locator('body').press(']');
    await expect(page).toHaveURL(`http://diffs:${port}/3`);
  });
});

test('diff renders while details and comments wait, and late responses cannot replace another PR', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(/\/api\/pr\/octo\/widgets\/2\/(pr|threads)$/, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(`${base}/diffs/2`);
    await expect(page.locator('.diff-table').first()).toBeVisible();
    await expect(page.locator('[data-region="pr"]')).toContainText('Loading');
    await expect(page.locator('[data-region="threads"]')).toContainText('Loading');
    await expect(page.locator('[data-viewed]').first()).toBeDisabled();
    await expect(page.locator('[data-line-handle]')).toHaveCount(0);
    await page.evaluate(() => {
      history.pushState(null, '', '/diffs/3');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.pr-title')).toHaveText('Animate widgets');
    release();
    await expect(page.locator('.pr-title')).toHaveText('Animate widgets');
    await expect(page.locator('[data-region]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { release(); }
});

test('comments can fail and retry without losing a usable diff', async ({ page }) => {
  let failed = true;
  await page.route('**/api/pr/octo/widgets/2/threads', async (route) => {
    if (failed) await route.fulfill({ status: 502, json: { error: 'Comments unavailable' } });
    else await route.continue();
  });
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('.diff-table').first()).toBeVisible();
  await expect(page.locator('[data-region="threads"]')).toContainText('Comments unavailable');
  await expect(page.locator('#review-jump')).toBeDisabled();
  failed = false;
  await page.locator('[data-region-retry="threads"]').click();
  await expect(page.locator('[data-comment-id="T_live"]')).toContainText('Why 100?');
  await expect(page.locator('#review-jump')).toBeEnabled();
});

test('large diffs defer distant files and thread jumps render the destination', async ({ page }) => {
  const lines = Array.from({ length: 30 }, (_, i) => `+const value${i} = ${i};`).join('\n');
  const patch = Array.from({ length: 150 }, (_, i) => {
    const path = `src/file-${String(i).padStart(3, '0')}.js`;
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,30 @@\n${lines}\n`;
  }).join('');
  github.state.threads[0].path = 'src/file-149.js';
  await page.route('**/api/pr/octo/widgets/2/patch', (route) => route.fulfill({ json: { patch, oldRef: fake.BASE_OID, newRef: fake.HEAD_OID } }));
  const start = Date.now();
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('article.file')).toHaveCount(150);
  await expect(page.locator('.diff-table').first()).toBeVisible();
  const count = await page.locator('.diff-table').count();
  expect(count).toBeLessThan(15);
  console.log(`150 files / 4,500 lines: first table in ${Date.now() - start}ms; ${count} tables rendered`);
  await page.locator('#comments-panel-toggle').click();
  await page.locator('#comment-status').selectOption('unresolved');
  await page.locator('[data-thread-jump="T_live"]').click();
  const last = page.locator('#file-149');
  await expect(last.locator('.diff-table')).toBeVisible();
  await expect(last.locator('[data-comment-id="T_live"]')).toBeInViewport();
  await expect(last.locator('.hljs-keyword').first()).toHaveText('const');
  await last.locator('[data-line-handle][data-line="10"]').click();
  await page.locator('[data-comment-text]').fill('Draft survives a panel filter');
  await page.locator('#comment-search').fill('Why');
  await expect(page.locator('[data-comment-text]')).toHaveValue('Draft survives a panel filter');
});

test('comments panel filters authors, status, text, and opens outdated threads', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await expect(page.locator('#review-jump')).toBeEnabled();
  await page.keyboard.press('c');
  await expect(page.getByRole('complementary', { name: 'Review threads' })).toBeVisible();
  await page.locator('#comment-author').selectOption('alice');
  await page.locator('#comment-status').selectOption('unresolved');
  await expect(page.locator('.thread-preview')).toHaveCount(1);
  await page.locator('#comment-search').fill('missing text');
  await expect(page.locator('.thread-preview')).toHaveCount(0);
  await page.locator('#comment-search').fill('');
  await page.locator('#comment-author').selectOption('');
  await page.locator('#comment-status').selectOption('resolved');
  await page.locator('[data-thread-jump="T_old"]').click();
  await expect(page.locator('.outdated-details')).toHaveAttribute('open', '');
  await expect(page.locator('[data-comment-id="T_old"]')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.locator('#comments-panel')).toBeHidden();
});

test('syntax highlighting preserves code, multiline tokens, intraline marks, and both themes', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  const source = page.locator('article.file', { hasText: 'src/app.js' });
  await expect(source.locator('.hljs-keyword').first()).toHaveText('const');
  const changed = source.locator('td.code[data-side="new"][data-line="10"]');
  await expect(changed).toHaveText('const v10 = 100;');
  await expect(changed.locator('.mark')).toHaveText('0');
  const sample = await page.evaluate(() => {
    const input = ['/* beginning', 'still a comment */', 'const text = "<img src=x onerror=alert(1)>";'];
    const html = window.PhabricadeSyntax.lines(input, 'index.js');
    return html.map((line) => {
      const node = document.createElement('div'); node.innerHTML = line;
      return { text: node.textContent, comment: Boolean(node.querySelector('.hljs-comment')), images: node.querySelectorAll('img').length };
    });
  });
  expect(sample).toEqual([
    { text: '/* beginning', comment: true, images: 0 },
    { text: 'still a comment */', comment: true, images: 0 },
    { text: 'const text = "<img src=x onerror=alert(1)>";', comment: false, images: 0 },
  ]);
  await page.locator('#mode-unified').click();
  await expect(source.locator('td.code[data-new-line="10"]')).toHaveText('+const v10 = 100;');
  const keyword = source.locator('.hljs-keyword').first();
  const light = await keyword.evaluate((node) => getComputedStyle(node).color);
  await page.getByRole('combobox', { name: 'Color theme' }).selectOption('dark');
  expect(await keyword.evaluate((node) => getComputedStyle(node).color)).not.toBe(light);
  await expect(page).toHaveTitle(/Phabricade/);
});

test('stack neighbors prefetch, and inbox link intent prefetches without navigating', async ({ page }) => {
  const requests = [];
  page.on('request', (request) => { if (request.url().endsWith('/prefetch')) requests.push(request.url()); });
  await page.goto(`${base}/diffs/2`);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((url) => new URL(url).pathname).sort()).toEqual(['/api/pr/octo/widgets/1/prefetch', '/api/pr/octo/widgets/3/prefetch']);
  await page.goto(`${base}/`);
  await page.locator('a[href="/diffs/2"]').first().hover();
  await expect.poll(() => requests.some((url) => url.endsWith('/2/prefetch'))).toBe(true);
  await expect(page).toHaveURL(`${base}/`);
  expect(github.state.calls).toEqual([]);
});

test('draft replies appear in the thread browser and narrow-screen jumps close the panel', async ({ page }) => {
  await page.goto(`${base}/diffs/2`);
  await page.locator('[data-comment-reply="T_live"]').click();
  await page.locator('[data-reply-text]').fill('Keep this local reply');
  await page.locator('[data-reply-submit]').click();
  await page.locator('#comments-panel-toggle').click();
  await page.locator('#comment-status').selectOption('draft');
  await expect(page.locator('.thread-preview')).toHaveCount(1);
  await expect(page.locator('.thread-preview')).toContainText('Keep this local reply');
  await page.locator('#comment-author').selectOption('me');
  await expect(page.locator('.thread-preview')).toHaveCount(1);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.locator('[data-thread-jump="T_live"]').click();
  await expect(page.locator('#comments-panel')).toBeHidden();
  await expect(page.locator('[data-comment-id="T_live"]')).toBeInViewport();
  expect(github.state.calls).toEqual([]);
});

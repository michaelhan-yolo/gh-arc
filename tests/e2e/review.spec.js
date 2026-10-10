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
  process.env.GH_ARC_TOKEN = 'test-token';
  process.env.GH_ARC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-arc-e2e-'));
  const { createServer } = require('../../lib/server');
  app = createServer();
  const port = await app.listen(0, '127.0.0.1', true);
  base = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await app.close();
  await github.close();
});

test.beforeEach(() => {
  github.reset();
  fs.rmSync(path.join(process.env.GH_ARC_HOME, 'drafts'), { recursive: true, force: true });
});

const callNames = () => github.state.calls.map((call) => call.name);

test('reviews a stacked pull request: drafts, a range, a reply, then one submitted review', async ({ page }) => {
  await page.goto(`${base}/octo/widgets/pull/2`);
  await expect(page.locator('.pr-title')).toHaveText('Render widgets');
  await expect(page.locator('#stack-nav')).toContainText('Stack 2/3');
  await expect(page.locator('.side-group.current .side-stack-row')).toHaveCount(4);
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

test('drafts survive a reload, and a rejected one shows its error', async ({ page }) => {
  await page.goto(`${base}/octo/widgets/pull/2`);
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
  await page.goto(`${base}/octo/widgets/pull/2`);
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
  await page.goto(`${base}/octo/widgets/pull/2`);
  await expect(page.locator('#stack-nav')).toBeVisible();
  await page.locator('[data-range-select]').selectOption('since');
  await expect(page).toHaveURL(new RegExp(`diff=${fake.LAST_REVIEWED_OID}..${fake.HEAD_OID}`));
  await expect(page.locator('.range-banner')).toContainText('since your last review');
  await expect(page.locator('[data-line-handle][data-side="old"]')).toHaveCount(0);
  await expect(page.locator('[data-line-handle][data-side="new"]').first()).toBeVisible();

  await page.locator('body').press(']');
  await expect(page).toHaveURL(`${base}/octo/widgets/pull/3`);
  await page.goto(`${base}/octo/widgets/pull/2`);
  await expect(page.locator('#stack-nav')).toBeVisible();
  await page.locator('body').press('[');
  await expect(page).toHaveURL(`${base}/octo/widgets/pull/1`);
});

test('two versions compare without the base changes merged in between', async ({ page }) => {
  await page.goto(`${base}/octo/widgets/pull/2`);
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
  await expect(page).toHaveURL(`${base}/octo/widgets/pull/2?diff=${fake.LAST_REVIEWED_OID}..${fake.HEAD_OID}`);

  await expect(page.locator('[data-versions-menu-toggle]')).toHaveText(/V2 → V3/);
  await expect(page.locator('.range-banner')).toContainText('what changed from V2');
  await expect(page.locator('.range-banner')).toContainText('left out');
  const source = page.locator('article.file', { hasText: 'src/app.js' });
  await expect(source.locator('.file-status.rebased')).toHaveText('Base changes left out');
  await expect(source.locator('td.code.old')).toHaveText(['const v10 = 99;']);
  await expect(source.locator('td.code.new')).toHaveText(['const v10 = 100;', 'const extra = true;']);
  await expect(source.locator('[data-context]')).toHaveCount(0);
  await expect(page.locator('.file-title', { hasText: 'docs/old.md → docs/new.md' })).toBeVisible();

  await page.goto(`${base}/octo/widgets/pull/2?diff=${fake.LAST_REVIEWED_OID}..${fake.LAST_REVIEWED_OID}`);
  await expect(page.locator('.empty')).toContainText('V2 and V2 differ only by what was merged in from the base');
});

test('the stack button opens a menu of the whole stack', async ({ page }) => {
  await page.goto(`${base}/octo/widgets/pull/2`);
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
  await expect(page).toHaveURL(`${base}/octo/widgets/pull/3`);
});

test('the sidebar lists your stacks, with the one on screen open to its files', async ({ page }) => {
  await page.goto(`${base}/octo/widgets/pull/2`);
  const sidebar = page.locator('#sidebar-stack');
  await expect(sidebar.locator('.side-stack-heading')).toHaveText([/Viewing/, /Your stacks\s*2/]);
  const current = sidebar.locator('.side-group.current');
  await expect(current.locator('.side-stack-number')).toHaveText(['#3', '#2', '#1']);
  await expect(current.locator('.side-stack-row.current')).toContainText('Render widgets');
  await expect(current.locator('.side-stack-trunk')).toHaveText('main');
  await expect(page.locator('#files-heading')).toHaveText(/Files in #2\s*2/);
  await expect(page.locator('.sidebar-files .file-link')).toHaveCount(2);

  const docs = sidebar.locator('.side-group', { hasText: 'Widget docs' }).first();
  await expect(docs).toHaveClass(/collapsed/);
  await expect(docs.locator('.side-group-count')).toHaveText('2');
  await expect(sidebar.locator('.side-group.single .side-stack-number')).toHaveText('#30');
  await docs.locator('[data-side-group]').click();
  await expect(sidebar.locator('.side-group', { hasText: 'Widget docs' }).first().locator('.side-stack-number')).toHaveText(['#21', '#20']);

  await page.reload();
  await expect(sidebar.locator('.side-group', { hasText: 'Widget docs' }).first()).not.toHaveClass(/collapsed/);
  await sidebar.locator('a.side-stack-row', { hasText: '#20' }).click();
  await expect(page).toHaveURL(`${base}/octo/widgets/pull/20`);
});

test('the handle between your stacks and the files resizes them and remembers where it was', async ({ page }) => {
  await page.goto(`${base}/octo/widgets/pull/2`);
  const stacks = page.locator('#sidebar-stack');
  const handle = page.locator('#sidebar-split');
  await expect(page.locator('.side-group.current')).toBeVisible();
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
  await expect(page.locator('.side-group.current')).toBeVisible();
  expect((await stacks.boundingBox()).height).toBeLessThan(210);
  await handle.dblclick();
  await expect.poll(async () => (await stacks.boundingBox()).height / sidebar.height).toBeGreaterThan(0.6);
});

test('the inbox draws each stack top first over its trunk', async ({ page }) => {
  await page.goto(`${base}/`);
  const stack = page.locator('.inbox-section', { hasText: 'Needs your review' }).locator('.inbox-group.is-stack');
  await expect(stack.locator('.inbox-number')).toHaveText(['#3', '#2', '#1']);
  await expect(stack.locator('.inbox-trunk')).toHaveText('main');
  await page.locator('#open-input').fill('https://github.com/octo/widgets/pull/2/files');
  await page.locator('#open-input').press('Enter');
  await expect(page).toHaveURL(`${base}/octo/widgets/pull/2`);
});

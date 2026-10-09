'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parsePatchFiles, githubPathFor, viewerPathFor, patchFromFiles } = require('../../lib/patch');
const { submitDrafts, threadInput } = require('../../lib/review');

const PATCH = [
  'diff --git a/docs/old.md b/docs/new.md',
  'rename from docs/old.md',
  'rename to docs/new.md',
  '--- a/docs/old.md',
  '+++ b/docs/new.md',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-x',
  'diff --git "a/caf\\303\\251 \\"menu\\".js" "b/caf\\303\\251 \\"menu\\".js"',
  '--- "a/caf\\303\\251 \\"menu\\".js"',
  '+++ "b/caf\\303\\251 \\"menu\\".js"',
  '@@ -1 +1 @@',
  '--- a deleted line that looks like a header',
  '+++ an added line that looks like a header',
  'diff --git a/with space.js b/with space.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/with space.js',
  'diff --git a/old name.png b/new name.png',
  'similarity index 100%',
  'rename from old name.png',
  'rename to new name.png',
  '',
].join('\n');

test('parsePatchFiles reads renames, deletions, spaces and git-quoted paths', () => {
  assert.deepEqual(parsePatchFiles(PATCH), [
    { oldPath: 'docs/old.md', newPath: 'docs/new.md' },
    { oldPath: 'gone.js', newPath: null },
    { oldPath: 'café "menu".js', newPath: 'café "menu".js' },
    { oldPath: null, newPath: 'with space.js' },
    { oldPath: 'old name.png', newPath: 'new name.png' },
  ]);
});

test('LEFT-side paths map between the viewer and GitHub', () => {
  const files = parsePatchFiles(PATCH);
  assert.equal(githubPathFor(files, 'old', 'docs/old.md'), 'docs/new.md');
  assert.equal(githubPathFor(files, 'new', 'docs/new.md'), 'docs/new.md');
  assert.equal(githubPathFor(files, 'old', 'gone.js'), 'gone.js');
  assert.equal(viewerPathFor(files, 'old', 'docs/new.md'), 'docs/old.md');
  assert.equal(viewerPathFor(files, 'new', 'docs/new.md'), 'docs/new.md');
});

test('threadInput anchors single lines and ranges on the right side', () => {
  const files = parsePatchFiles(PATCH);
  assert.deepEqual(threadInput('R1', { side: 'old', path: 'docs/old.md', startLine: 1, endLine: 1, text: 'hm' }, files), {
    pullRequestReviewId: 'R1', path: 'docs/new.md', line: 1, side: 'LEFT', body: 'hm',
  });
  assert.deepEqual(threadInput('R1', { side: 'new', path: 'docs/new.md', startLine: 2, endLine: 5, text: 'x' }, files), {
    pullRequestReviewId: 'R1', path: 'docs/new.md', line: 5, side: 'RIGHT', startLine: 2, startSide: 'RIGHT', body: 'x',
  });
});

test('patchFromFiles rebuilds a parseable diff from the files API', () => {
  const text = patchFromFiles([
    { filename: 'a.js', status: 'modified', changes: 2, patch: '@@ -1 +1 @@\n-a\n+b' },
    { filename: 'new.js', previous_filename: 'old.js', status: 'renamed', changes: 0 },
    { filename: 'logo.png', status: 'added', changes: 0 },
  ]);
  assert.deepEqual(parsePatchFiles(text).map((file) => [file.oldPath, file.newPath]), [
    ['a.js', 'a.js'],
    ['old.js', 'new.js'],
    ['logo.png', 'logo.png'],
  ]);
  assert.match(text, /@@ -1 \+1 @@\n-a\n\+b\n/);
});

function fakeGh(options = {}) {
  const calls = [];
  return {
    calls,
    async addPendingReview(id, oid) {
      calls.push(['addPendingReview', id, oid]);
      return 'R_new';
    },
    async addReviewThread(input) {
      calls.push(['addReviewThread', input.path, input.line, input.pullRequestReviewId]);
      if (options.failPath === input.path) {
        throw new Error('line must be part of the diff');
      }
    },
    async addReviewThreadReply(input) {
      calls.push(['addReviewThreadReply', input.pullRequestReviewThreadId, input.pullRequestReviewId]);
    },
    async submitReview(input) {
      calls.push(['submitReview', input.event, input.body]);
      return { id: input.pullRequestReviewId, state: 'APPROVED', url: 'u' };
    },
  };
}

const DRAFTS = {
  threads: [{ id: 'd1', side: 'new', path: 'docs/new.md', startLine: 1, endLine: 1, text: 'one' }],
  replies: [{ id: 'd2', threadId: 'T9', text: 'two' }],
};

test('submitDrafts creates a pending review, posts every draft, then submits', async () => {
  const gh = fakeGh();
  const result = await submitDrafts({
    gh,
    pr: { id: 'PR1', headRefOid: 'abc', pendingReviews: [] },
    viewerLogin: 'me',
    drafts: DRAFTS,
    files: parsePatchFiles(PATCH),
    event: 'APPROVE',
    body: '   ',
  });
  assert.equal(result.submitted, true);
  assert.deepEqual(result.posted, ['d1', 'd2']);
  assert.deepEqual(gh.calls, [
    ['addPendingReview', 'PR1', 'abc'],
    ['addReviewThread', 'docs/new.md', 1, 'R_new'],
    ['addReviewThreadReply', 'T9', 'R_new'],
    ['submitReview', 'APPROVE', undefined],
  ]);
});

test('submitDrafts reuses only the viewer\'s own pending review', async () => {
  const gh = fakeGh();
  await submitDrafts({
    gh,
    pr: { id: 'PR1', headRefOid: 'abc', pendingReviews: [{ id: 'R_theirs', author: { login: 'them' } }, { id: 'R_mine', author: { login: 'me' } }] },
    viewerLogin: 'me',
    drafts: DRAFTS,
    files: [],
    event: 'COMMENT',
    body: 'Thanks',
  });
  assert.equal(gh.calls.some((call) => call[0] === 'addPendingReview'), false);
  assert.deepEqual(gh.calls[0], ['addReviewThread', 'docs/new.md', 1, 'R_mine']);
  assert.deepEqual(gh.calls[gh.calls.length - 1], ['submitReview', 'COMMENT', 'Thanks']);
});

test('submitDrafts leaves the review pending when a draft is rejected', async () => {
  const gh = fakeGh({ failPath: 'docs/new.md' });
  const result = await submitDrafts({
    gh,
    pr: { id: 'PR1', headRefOid: 'abc', pendingReviews: [] },
    viewerLogin: 'me',
    drafts: DRAFTS,
    files: [],
    event: 'COMMENT',
    body: '',
  });
  assert.equal(result.submitted, false);
  assert.deepEqual(result.posted, ['d2']);
  assert.deepEqual(result.failures, [{ id: 'd1', message: 'line must be part of the diff' }]);
  assert.equal(gh.calls.some((call) => call[0] === 'submitReview'), false);
});

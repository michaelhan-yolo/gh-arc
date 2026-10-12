'use strict';

// Drives gh-arc's HTTP API against the in-memory GitHub in tests/support.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fake = require('../support/fake-github');

let github;
let app;
let base;

test.before(async () => {
  github = await fake.startFakeGitHub();
  process.env.GH_ARC_API_URL = github.url;
  process.env.GH_ARC_TOKEN = 'test-token';
  process.env.GH_ARC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-arc-server-'));
  const { createServer } = require('../../lib/server');
  app = createServer({ sessionToken: 'page-token' });
  const port = await app.listen(0, '127.0.0.1', true);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await app.close();
  await github.close();
});

test.beforeEach(() => {
  github.reset();
  fs.rmSync(path.join(process.env.GH_ARC_HOME, 'drafts'), { recursive: true, force: true });
});

const prApi = (action, query) => `${base}/api/pr/octo/widgets/2/${action}${query ? `?${query}` : ''}`;

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function post(url, body, headers = { 'X-GH-Arc-Token': 'page-token' }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function rawGet(host) {
  return new Promise((resolve) => {
    const { port } = new URL(base);
    http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
}

test('only localhost hosts and page-token writes get through', async () => {
  const { port } = new URL(base);
  assert.equal(await rawGet(`evil.example:${port}`), 403);
  assert.equal(await rawGet(`localhost:${port}`), 200);
  const payload = { action: 'review', body: 'x' };
  assert.equal((await post(prApi('drafts'), payload, {})).status, 403);
  assert.equal((await post(prApi('drafts'), payload, { 'X-GH-Arc-Token': 'page-token', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(prApi('drafts'), payload)).status, 200);
});

test('pages carry the page token and a script-locking CSP', async () => {
  const res = await fetch(`${base}/diffs/octo/widgets/2`);
  const html = await res.text();
  assert.match(html, /<meta name="gh-arc-token" content="page-token">/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
});

function rawRequest(port, options) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.end(options.body);
  });
}

test('the diffs alias host is allowed, for reads and page-token writes, and gets short paths', async () => {
  const { createServer } = require('../../lib/server');
  const homed = createServer({ homeRepo: 'octo/widgets', sessionToken: 'page-token' });
  const port = await homed.listen(0, '127.0.0.1', true);
  assert.equal((await rawRequest(port, { path: '/api/ping', headers: { Host: 'diffs' } })).status, 200);
  assert.equal((await rawRequest(port, { path: '/2', headers: { Host: 'diffs' } })).status, 200);
  assert.equal((await rawRequest(port, { path: '/octo/widgets/pull/2', headers: { Host: 'diffs' } })).location, '/2');
  assert.equal((await rawRequest(port, { path: '/octo/widgets/pull/2', headers: { Host: `localhost:${port}` } })).location, '/diffs/2');
  const write = await rawRequest(port, {
    method: 'POST',
    path: '/api/pr/octo/widgets/2/drafts',
    headers: { Host: 'diffs', Origin: 'http://diffs', 'Content-Type': 'application/json', 'X-GH-Arc-Token': 'page-token' },
    body: JSON.stringify({ action: 'review', body: 'via the alias' }),
  });
  assert.equal(write.status, 200);
  assert.equal((await rawRequest(port, { path: '/api/ping', headers: { Host: 'diffs.evil.example' } })).status, 403);
  await homed.close();
});

test('GitHub-shaped paths redirect to /diffs/, and a bare number needs a home repository', async () => {
  const moved = await fetch(`${base}/octo/widgets/pull/2/files?diff=base..${fake.HEAD_OID}`, { redirect: 'manual' });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), `/diffs/octo/widgets/2?diff=base..${fake.HEAD_OID}`);
  assert.equal((await fetch(`${base}/diffs/2`)).status, 404);
  assert.equal((await fetch(`${base}/diffs`, { redirect: 'manual' })).headers.get('location'), '/');

  const { createServer } = require('../../lib/server');
  const homed = createServer({ homeRepo: 'octo/widgets' });
  const port = await homed.listen(0, '127.0.0.1', true);
  const home = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${home}/octo/widgets/pull/2`, { redirect: 'manual' })).headers.get('location'), '/diffs/2');
  assert.equal((await fetch(`${home}/other/repo/pull/7`, { redirect: 'manual' })).headers.get('location'), '/diffs/other/repo/7');
  const page = await (await fetch(`${home}/diffs/2`)).text();
  assert.match(page, /<meta name="gh-arc-home-repo" content="octo\/widgets">/);
  assert.equal((await (await fetch(`${home}/api/ping`)).json()).homeRepo, 'octo/widgets');
  await homed.close();
});

test('pr returns the pull request shaped for the viewer', async () => {
  const { status, body } = await get(prApi('pr'));
  assert.equal(status, 200);
  assert.equal(body.viewer, 'me');
  assert.equal(body.pr.state, 'OPEN');
  assert.equal(body.pr.lastReviewedOid, fake.LAST_REVIEWED_OID);
  assert.deepEqual(body.pr.checks.contexts.map((item) => item.state), ['SUCCESS', 'FAILURE', 'PENDING']);
  assert.deepEqual(body.pr.reviewers, [{ login: 'me', avatarUrl: '', team: false, state: 'REQUESTED' }]);
  assert.deepEqual(body.pr.timeline.map((item) => item.type), ['comment', 'review']);
  assert.deepEqual(body.pr.viewed, { 'src/app.js': false, 'docs/new.md': false });
});

test('threads come back positioned, with outdated ones flagged', async () => {
  const { body } = await get(prApi('threads'));
  const live = body.threads.find((thread) => thread.id === 'T_live');
  const old = body.threads.find((thread) => thread.id === 'T_old');
  assert.deepEqual([live.side, live.path, live.startLine, live.endLine, live.outdated], ['new', 'src/app.js', 10, 10, false]);
  assert.deepEqual([old.outdated, old.resolved, old.endLine], [true, true, 5]);
  assert.deepEqual(body.drafts.threads, []);
});

test('stack finds the parent and child through branch names', async () => {
  const { body } = await get(prApi('stack'));
  assert.equal(body.trunk, 'main');
  assert.deepEqual(body.entries.map((entry) => entry.number), [1, 2, 3]);
  assert.equal(body.parent, 1);
  assert.deepEqual(body.children, [3]);
  assert.equal(body.entries[2].state, 'DRAFT');
});

test('context reads the old side at the merge base and the new side at head', async () => {
  const query = new URLSearchParams({
    oldPath: 'src/app.js', newPath: 'src/app.js', oldFrom: '1', oldTo: '2', newFrom: '21', newTo: '22',
    base: fake.BASE_OID, newRef: fake.HEAD_OID,
  });
  const { body } = await get(prApi('context', query.toString()));
  assert.deepEqual(body.old, [{ line: 1, text: 'const v1 = 1;' }, { line: 2, text: 'const v2 = 2;' }]);
  assert.deepEqual(body.new, [{ line: 21, text: 'const extra = true;' }, { line: 22, text: 'const v21 = 21;' }]);
});

test('versions are pushed heads, including one force-pushed away, in the order they were the head', async () => {
  const { body } = await get(prApi('pr'));
  assert.deepEqual(body.pr.versions.map((version) => [version.number, version.oid, version.forcePushed, version.reviewedByYou]), [
    [1, fake.FORCED_OID, true, false],
    [2, fake.LAST_REVIEWED_OID, false, true],
    [3, fake.HEAD_OID, false, false],
  ]);
});

test('comparing two versions leaves out what the base gained in between', async () => {
  const { status, body } = await get(prApi('patch', `diff=${fake.LAST_REVIEWED_OID}..${fake.HEAD_OID}`));
  assert.equal(status, 200);
  assert.equal(body.fullContext, true);
  assert.equal(body.newRef, fake.HEAD_OID);
  assert.deepEqual(body.notes, { 'src/app.js': 'rebased' });
  assert.match(body.patch, /-const v10 = 99;\n\+const v10 = 100;\n/);
  assert.match(body.patch, /\+const extra = true;\n/);
  assert.doesNotMatch(body.patch, /^[-+]const v25/m);
  assert.match(body.patch, /rename from docs\/old\.md\nrename to docs\/new\.md\n[\s\S]*-old body\n\+new body\n/);
});

test('a version against the base shows the pull request as it was then', async () => {
  const { body } = await get(prApi('patch', `diff=base..${fake.LAST_REVIEWED_OID}`));
  assert.equal(body.oldRef, fake.OLD_MERGE_BASE_OID);
  assert.equal(body.newRef, fake.LAST_REVIEWED_OID);
  assert.equal((await get(prApi('patch', 'diff=nope..also-nope'))).status, 400);
});

test('a single commit view compares against its parent', async () => {
  const { body } = await get(prApi('patch', `commit=${fake.HEAD_OID}`));
  assert.equal(body.oldRef, fake.MERGE_BASE_OID);
  assert.equal(body.newRef, fake.HEAD_OID);
  assert.match(body.patch, /src\/app\.js/);
  assert.equal((await get(prApi('patch', 'commit=not-a-sha'))).status, 400);
});

test('submit posts drafts into one review with GitHub paths and sides', async () => {
  await post(prApi('drafts'), { action: 'add-thread', side: 'old', path: 'docs/old.md', startLine: 2, endLine: 2, text: 'Why remove this?' });
  await post(prApi('drafts'), { action: 'add-thread', side: 'new', path: 'src/app.js', startLine: 9, endLine: 10, text: 'Name this constant.' });
  await post(prApi('drafts'), { action: 'add-reply', threadId: 'T_live', text: 'Because 100 is the cap.' });

  const { status, body } = await post(prApi('submit'), { event: 'REQUEST_CHANGES', body: 'Please fix.' });
  assert.equal(status, 200);
  assert.equal(body.submitted, true);
  assert.equal(body.review.state, 'CHANGES_REQUESTED');
  assert.deepEqual(body.drafts.threads, []);
  assert.deepEqual(body.drafts.replies, []);
  assert.equal(body.drafts.body, '');

  assert.deepEqual(github.state.calls.map((call) => call.name), [
    'addPullRequestReview',
    'addPullRequestReviewThread',
    'addPullRequestReviewThread',
    'addPullRequestReviewThreadReply',
    'submitPullRequestReview',
  ]);
  const [create, left, range, reply, submit] = github.state.calls.map((call) => call.input);
  assert.deepEqual(create, { pullRequestId: 'PR_2', commitOID: fake.HEAD_OID });
  assert.deepEqual(left, { pullRequestReviewId: 'R_pending', path: 'docs/new.md', line: 2, side: 'LEFT', body: 'Why remove this?' });
  assert.deepEqual(range, { pullRequestReviewId: 'R_pending', path: 'src/app.js', line: 10, side: 'RIGHT', startLine: 9, startSide: 'RIGHT', body: 'Name this constant.' });
  assert.deepEqual(reply, { pullRequestReviewId: 'R_pending', pullRequestReviewThreadId: 'T_live', body: 'Because 100 is the cap.' });
  assert.deepEqual(submit, { pullRequestReviewId: 'R_pending', event: 'REQUEST_CHANGES', body: 'Please fix.' });
});

test('a rejected draft keeps its error and the review stays pending until resubmitted', async () => {
  await post(prApi('drafts'), { action: 'add-thread', side: 'new', path: 'src/app.js', startLine: 4, endLine: 4, text: '[fail] off the diff' });
  await post(prApi('drafts'), { action: 'add-thread', side: 'new', path: 'src/app.js', startLine: 10, endLine: 10, text: 'Fine.' });

  const first = await post(prApi('submit'), { event: 'COMMENT', body: '' });
  assert.equal(first.body.submitted, false);
  assert.equal(first.body.drafts.threads.length, 1);
  assert.match(first.body.drafts.threads[0].error, /must be part of the diff/);
  assert.equal(github.state.pendingReview.threads.length, 1);

  await post(prApi('drafts'), { action: 'delete', id: first.body.drafts.threads[0].id });
  const second = await post(prApi('submit'), { event: 'COMMENT', body: 'Done.' });
  assert.equal(second.body.submitted, true);
  assert.equal(github.state.calls.filter((call) => call.name === 'addPullRequestReview').length, 1);
});

test('an empty comment review is refused before anything reaches GitHub', async () => {
  const { status, body } = await post(prApi('submit'), { event: 'COMMENT', body: '  ' });
  assert.equal(status, 400);
  assert.match(body.error, /Write a comment/);
  assert.deepEqual(github.state.calls, []);
});

test('resolve and viewed write through to GitHub', async () => {
  assert.equal((await post(prApi('resolve'), { threadId: 'T_live', resolved: true })).status, 200);
  assert.equal(github.state.threads[0].isResolved, true);
  assert.equal((await post(prApi('viewed'), { path: 'src/app.js', viewed: true })).status, 200);
  assert.equal(github.state.viewed['src/app.js'], true);
  assert.deepEqual(github.state.calls.map((call) => call.name), ['resolveReviewThread', 'markFileAsViewed']);
});

test('inbox groups a review queue into stacks, top first', async () => {
  const { body } = await get(`${base}/api/inbox`);
  const needsReview = body.sections.find((section) => section.key === 'needsReview');
  assert.equal(needsReview.groups.length, 1);
  assert.equal(needsReview.groups[0].trunk, 'main');
  assert.deepEqual(needsReview.groups[0].items.map((item) => item.pr.number), [3, 2, 1]);
  const mine = body.sections.find((section) => section.key === 'mine');
  assert.deepEqual(mine.groups.map((group) => group.items.map((item) => item.pr.number)).sort(), [[21, 20], [30]]);
});

const prApiFor = (number, action) => `${base}/api/pr/octo/widgets/${number}/${action}`;

test('review status comes from the review decision, or the reviews where branches are unprotected', () => {
  const { reviewStatus } = require('../../lib/normalize');
  const reviews = (...states) => ({ nodes: states.map((state) => ({ state })) });
  assert.equal(reviewStatus({ merged: true }), 'MERGED');
  assert.equal(reviewStatus({ state: 'CLOSED' }), 'CLOSED');
  assert.equal(reviewStatus({ state: 'OPEN', isDraft: true }), 'DRAFT');
  assert.equal(reviewStatus({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', latestOpinionatedReviews: reviews('APPROVED') }), 'UNDER_REVIEW');
  assert.equal(reviewStatus({ state: 'OPEN', reviewDecision: 'APPROVED' }), 'ACCEPTED');
  assert.equal(reviewStatus({ state: 'OPEN', reviewDecision: null, latestOpinionatedReviews: reviews('APPROVED') }), 'ACCEPTED');
  assert.equal(reviewStatus({ state: 'OPEN', reviewDecision: null, latestOpinionatedReviews: reviews('APPROVED', 'CHANGES_REQUESTED') }), 'CHANGES_REQUESTED');
  assert.equal(reviewStatus({ state: 'OPEN', reviewDecision: null, latestOpinionatedReviews: reviews() }), 'UNDER_REVIEW');
});

test('you cannot accept or block your own pull request', async () => {
  const { status, body } = await post(prApiFor(1, 'submit'), { event: 'APPROVE', body: 'LGTM' });
  assert.equal(status, 400);
  assert.match(body.error, /your own pull request/);
  assert.deepEqual(github.state.calls, []);
});

test('a stack ships bottom first: merge, move the next onto the trunk, merge it', async () => {
  github.state.prs[1].approved = true;
  github.state.prs[2].approved = true;
  assert.equal((await post(prApiFor(2, 'merge'), { method: 'MERGE', expectedHeadOid: fake.HEAD_OID })).status, 409);
  assert.equal((await post(prApiFor(2, 'retarget'), {})).status, 409);
  assert.deepEqual(github.state.calls, []);

  assert.equal((await post(prApiFor(1, 'merge'), { method: 'MERGE', expectedHeadOid: '1'.repeat(40), deleteBranch: true })).status, 200);
  assert.deepEqual((await post(prApiFor(2, 'retarget'), {})).body, { baseRefName: 'main', moved: true, below: 1 });
  const merged = await post(prApiFor(2, 'merge'), { method: 'MERGE', expectedHeadOid: fake.HEAD_OID });
  assert.equal(merged.body.merged, true);
  assert.equal((await post(prApiFor(3, 'retarget'), {})).status, 200);

  assert.deepEqual(github.state.calls.map((call) => [call.name, call.input && (call.input.pullRequestId || call.input)]), [
    ['mergePullRequest', 'PR_1'],
    ['deleteRef', 'feat-a'],
    ['updatePullRequest', 'PR_2'],
    ['mergePullRequest', 'PR_2'],
    ['updatePullRequest', 'PR_3'],
  ]);
  assert.equal(github.state.calls[0].input.mergeMethod, 'MERGE');
  assert.equal(github.state.prs[3].baseRefName, 'main');
});

test('a ship refuses a head that moved and an unknown merge method', async () => {
  github.state.prs[1].approved = true;
  const moved = await post(prApiFor(1, 'merge'), { method: 'MERGE', expectedHeadOid: 'f'.repeat(40) });
  assert.equal(moved.status, 422);
  assert.match(moved.body.error, /Head branch was modified/);
  assert.equal((await post(prApiFor(1, 'merge'), { method: 'FAST_FORWARD', expectedHeadOid: '1'.repeat(40) })).status, 400);
});

test('an unknown pull request is a 404', async () => {
  const { status } = await get(`${base}/api/pr/octo/widgets/404/pr`);
  assert.equal(status, 404);
});

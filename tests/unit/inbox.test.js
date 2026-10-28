'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.GH_ARC_TOKEN = 'test-token';
const gh = require('../../lib/github');
const { groupIntoStacks } = require('../../lib/stack');

function fakeInbox(t, fail = () => null) {
  const sizes = { needsReview: 31, mine: 82, reviewed: 61, landed: 164 };
  const calls = [];
  const nodes = (key, start, count) => Array.from({ length: count }, (_, offset) => {
    const number = start + offset + 1;
    return { number, repository: { nameWithOwner: 'octo/widgets' }, headRefName: `branch-${number}`,
      baseRefName: number === 1 ? 'main' : `branch-${number - 1}`,
      updatedAt: '2026-10-20T00:00:00Z', headRepositoryOwner: { login: 'octo' } };
  });
  t.mock.method(global, 'fetch', async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    const key = variables?.query?.includes('review-requested:') ? 'needsReview'
      : variables?.query?.includes('reviewed-by:') ? 'reviewed'
      : variables?.query?.includes('is:merged') ? 'landed' : 'mine';
    if (key === 'landed') assert.match(variables.query, /author:@me/);
    const start = Number(variables?.cursor || 0);
    calls.push({ key, start, query });
    const status = fail({ key, start, calls });
    if (status) return new Response('<html><title>Bad Gateway</title><body>nginx</body></html>', { status });
    if (query.includes('needsReview: search')) {
      return Response.json({ data: { viewer: { login: 'me' }, ...Object.fromEntries(
        Object.entries(sizes).map(([name, size]) => [name, { nodes: nodes(name, 0, Math.min(size, 60)) }])) } });
    }
    const pageSize = key === 'landed' ? 100 : 30;
    assert.ok(query.includes(`search(type: ISSUE, query: $query, first: ${pageSize}, after: $cursor)`));
    const end = Math.min(start + pageSize, sizes[key]);
    return Response.json({ data: { viewer: { login: 'me' }, search: {
      nodes: nodes(key, start, end - start), pageInfo: { hasNextPage: end < sizes[key], endCursor: String(end) },
    } } });
  });
  return calls;
}

test('inbox loads every page in each section and keeps a stack spanning pages together', async (t) => {
  const calls = fakeInbox(t);
  const data = await gh.fetchInbox();
  assert.equal(data.viewer.login, 'me');
  for (const [key, size] of Object.entries({ needsReview: 31, mine: 82, reviewed: 61, landed: 164 })) {
    assert.equal(data[key].nodes.length, size);
    assert.equal(new Set(data[key].nodes.map((pr) => pr.number)).size, size);
  }
  assert.deepEqual(calls.filter((call) => call.key === 'mine').map((call) => call.start), [0, 30, 60]);
  assert.deepEqual(calls.filter((call) => call.key === 'landed').map((call) => call.start), [0, 100]);
  assert.doesNotMatch(calls.find((call) => call.key === 'landed').query, /latestOpinionatedReviews|statusCheckRollup/);
  const groups = groupIntoStacks(data.mine.nodes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 82);
  assert.equal(groups[0].trunk, 'main');
});

test('inbox retries a temporary gateway failure on the same page without losing earlier pages', async (t) => {
  const calls = fakeInbox(t, ({ key, start, calls }) => key === 'mine' && start === 30 &&
    calls.filter((call) => call.key === key && call.start === start).length === 1 ? 502 : null);
  const data = await gh.fetchInbox();
  assert.equal(data.mine.nodes.length, 82);
  assert.deepEqual(calls.filter((call) => call.key === 'mine').map((call) => call.start), [0, 30, 30, 60]);
});

for (const status of [502, 503, 504]) {
  test(`inbox stops after three HTTP ${status} failures with a readable error`, async (t) => {
    const calls = fakeInbox(t, ({ key }) => key === 'mine' ? status : null);
    await assert.rejects(gh.fetchInbox(), (err) => {
      assert.equal(err.status, status);
      assert.match(err.message, /GitHub is temporarily unavailable/);
      assert.doesNotMatch(err.message, /<html>|nginx/);
      return true;
    });
    assert.equal(calls.filter((call) => call.key === 'mine').length, 3);
  });
}

test('inbox does not retry authentication failures', async (t) => {
  const calls = fakeInbox(t, ({ key }) => key === 'mine' ? 401 : null);
  await assert.rejects(gh.fetchInbox(), { status: 401 });
  assert.equal(calls.filter((call) => call.key === 'mine').length, 1);
});

test('GraphQL mutations are not retried on gateway errors', async (t) => {
  const calls = fakeInbox(t, () => 502);
  await assert.rejects(gh.graphql('mutation { example }'), { status: 502 });
  assert.equal(calls.length, 1);
});

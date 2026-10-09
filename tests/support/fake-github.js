'use strict';

// An in-memory GitHub for tests: the REST and GraphQL calls gh-arc makes, against a
// three-pull-request stack (main <- feat-a <- feat-b <- feat-c). Mutations are recorded.

const http = require('http');

const OWNER = 'octo';
const REPO = 'widgets';
const BASE_OID = 'a'.repeat(40);
const MERGE_BASE_OID = 'b'.repeat(40);
const HEAD_OID = 'c'.repeat(40);
const LAST_REVIEWED_OID = 'd'.repeat(40);

function appLines(version) {
  const lines = [];
  for (let ii = 1; ii <= 30; ii++) {
    lines.push(version === 'head' && ii === 10 ? 'const v10 = 100;' : `const v${ii} = ${ii};`);
    if (version === 'head' && ii === 20) {
      lines.push('const extra = true;');
    }
  }
  return lines;
}

const CONTENT = {
  [`${MERGE_BASE_OID}:src/app.js`]: `${appLines('base').join('\n')}\n`,
  [`${HEAD_OID}:src/app.js`]: `${appLines('head').join('\n')}\n`,
};

const PR2_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -7,7 +7,7 @@',
  ' const v7 = 7;',
  ' const v8 = 8;',
  ' const v9 = 9;',
  '-const v10 = 10;',
  '+const v10 = 100;',
  ' const v11 = 11;',
  ' const v12 = 12;',
  ' const v13 = 13;',
  '@@ -18,6 +18,7 @@ const v17 = 17;',
  ' const v18 = 18;',
  ' const v19 = 19;',
  ' const v20 = 20;',
  '+const extra = true;',
  ' const v21 = 21;',
  ' const v22 = 22;',
  ' const v23 = 23;',
  'diff --git a/docs/old.md b/docs/new.md',
  'similarity index 80%',
  'rename from docs/old.md',
  'rename to docs/new.md',
  'index 3333333..4444444 100644',
  '--- a/docs/old.md',
  '+++ b/docs/new.md',
  '@@ -1,3 +1,3 @@',
  ' # Title',
  '-old body',
  '+new body',
  ' end',
  '',
].join('\n');

function actor(login) {
  return { login, avatarUrl: '' };
}

function createState() {
  return {
    viewer: 'me',
    pendingReview: null,
    reviews: [],
    viewed: { 'src/app.js': false, 'docs/new.md': false },
    threads: [
      {
        id: 'T_live',
        isResolved: false,
        isOutdated: false,
        path: 'src/app.js',
        line: 10,
        originalLine: 10,
        startLine: null,
        originalStartLine: null,
        diffSide: 'RIGHT',
        startDiffSide: null,
        subjectType: 'LINE',
        viewerCanResolve: true,
        viewerCanUnresolve: false,
        viewerCanReply: true,
        resolvedBy: null,
        comments: { nodes: [comment('C_live', 'alice', 'Why 100?')] },
      },
      {
        id: 'T_old',
        isResolved: true,
        isOutdated: true,
        path: 'src/app.js',
        line: null,
        originalLine: 5,
        startLine: null,
        originalStartLine: null,
        diffSide: 'RIGHT',
        startDiffSide: null,
        subjectType: 'LINE',
        viewerCanResolve: false,
        viewerCanUnresolve: true,
        viewerCanReply: true,
        resolvedBy: actor('bob'),
        comments: { nodes: [comment('C_old', 'bob', 'Rename v5?', '@@ -1,5 +1,5 @@\n const v1 = 1;\n-const v5 = 5;\n+const v5 = 50;')] },
      },
    ],
    calls: [],
  };
}

function comment(id, login, body, diffHunk) {
  return {
    id,
    databaseId: 1,
    body,
    bodyHTML: `<p>${body}</p>`,
    createdAt: '2026-10-01T10:00:00Z',
    url: `https://github.com/${OWNER}/${REPO}/pull/2#discussion_${id}`,
    diffHunk: diffHunk || '@@ -7,7 +7,7 @@\n-const v10 = 10;\n+const v10 = 100;',
    author: actor(login),
    pullRequestReview: { id: 'R_old', state: 'COMMENTED' },
  };
}

const STACK = [
  { number: 1, title: 'Add the widget model', baseRefName: 'main', headRefName: 'feat-a' },
  { number: 2, title: 'Render widgets', baseRefName: 'feat-a', headRefName: 'feat-b' },
  { number: 3, title: 'Animate widgets', baseRefName: 'feat-b', headRefName: 'feat-c' },
  { number: 9, title: 'Unrelated cleanup', baseRefName: 'main', headRefName: 'cleanup' },
];

function summary(pr) {
  return {
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: `https://github.com/${OWNER}/${REPO}/pull/${pr.number}`,
    state: 'OPEN',
    isDraft: pr.number === 3,
    merged: false,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    additions: 3,
    deletions: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    author: actor('dana'),
    lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    updatedAt: '2026-10-02T10:00:00Z',
    repository: { nameWithOwner: `${OWNER}/${REPO}` },
    headRepositoryOwner: { login: OWNER },
  };
}

function pullRequest(state) {
  return {
    ...summary(STACK[1]),
    body: 'Renders the widgets.',
    bodyHTML: '<p>Renders the widgets. Stacked on <a href="https://github.com/octo/widgets/pull/1">#1</a>.</p>',
    mergedAt: null,
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-02T09:00:00Z',
    baseRefOid: BASE_OID,
    headRefOid: HEAD_OID,
    changedFiles: 2,
    mergeable: 'MERGEABLE',
    labels: { nodes: [{ name: 'frontend', color: '1d76db' }] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me', avatarUrl: '' } }] },
    latestOpinionatedReviews: { nodes: [] },
    pendingReviews: {
      nodes: state.pendingReview
        ? [{ id: state.pendingReview.id, author: actor(state.viewer), comments: { totalCount: state.pendingReview.threads.length } }]
        : [],
    },
    reviews: {
      nodes: [
        {
          id: 'R_prev',
          state: 'COMMENTED',
          submittedAt: '2026-10-01T12:00:00Z',
          body: 'First pass.',
          bodyHTML: '<p>First pass.</p>',
          url: `https://github.com/${OWNER}/${REPO}/pull/2#pullrequestreview-1`,
          author: actor('me'),
          commit: { oid: LAST_REVIEWED_OID },
          comments: { totalCount: 0 },
        },
        ...state.reviews,
      ],
    },
    comments: {
      nodes: [{
        id: 'IC_1',
        createdAt: '2026-10-01T11:00:00Z',
        bodyHTML: '<p>Looks close.</p>',
        url: `https://github.com/${OWNER}/${REPO}/pull/2#issuecomment-1`,
        author: actor('alice'),
      }],
    },
    commits: {
      totalCount: 2,
      nodes: [
        { commit: { oid: LAST_REVIEWED_OID, abbreviatedOid: 'ddddddd', messageHeadline: 'Render widgets', committedDate: '2026-10-01T09:00:00Z', parents: { totalCount: 1 }, author: { name: 'Dana', user: actor('dana') } } },
        { commit: { oid: HEAD_OID, abbreviatedOid: 'ccccccc', messageHeadline: 'Use 100 for v10', committedDate: '2026-10-02T09:00:00Z', parents: { totalCount: 1 }, author: { name: 'Dana', user: actor('dana') } } },
      ],
    },
    lastCommit: {
      nodes: [{
        commit: {
          oid: HEAD_OID,
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              totalCount: 3,
              nodes: [
                { __typename: 'CheckRun', name: 'unit tests', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: 'https://example.com/1' },
                { __typename: 'CheckRun', name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://example.com/2' },
                { __typename: 'StatusContext', context: 'deploy preview', state: 'PENDING', targetUrl: 'https://example.com/3' },
              ],
            },
          },
        },
      }],
    },
  };
}

function graphql(state, query, variables) {
  const input = variables && variables.input;
  const record = (name) => state.calls.push({ name, input });

  if (query.includes('addPullRequestReview(input')) {
    record('addPullRequestReview');
    state.pendingReview = { id: 'R_pending', threads: [], replies: [] };
    return { addPullRequestReview: { pullRequestReview: { id: 'R_pending' } } };
  }
  if (query.includes('addPullRequestReviewThread(input')) {
    record('addPullRequestReviewThread');
    if (input.body.includes('[fail]')) {
      return { errors: [{ message: 'pull_request_review_thread.line must be part of the diff' }] };
    }
    state.pendingReview.threads.push(input);
    return { addPullRequestReviewThread: { thread: { id: `T_new_${state.pendingReview.threads.length}` } } };
  }
  if (query.includes('addPullRequestReviewThreadReply(input')) {
    record('addPullRequestReviewThreadReply');
    state.pendingReview.replies.push(input);
    return { addPullRequestReviewThreadReply: { comment: { id: 'C_reply' } } };
  }
  if (query.includes('submitPullRequestReview(input')) {
    record('submitPullRequestReview');
    const stateName = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[input.event];
    state.reviews.push({
      id: input.pullRequestReviewId,
      state: stateName,
      submittedAt: '2026-10-03T10:00:00Z',
      body: input.body || '',
      bodyHTML: input.body ? `<p>${input.body}</p>` : '',
      url: `https://github.com/${OWNER}/${REPO}/pull/2#pullrequestreview-9`,
      author: actor(state.viewer),
      commit: { oid: HEAD_OID },
      comments: { totalCount: state.pendingReview.threads.length },
    });
    state.pendingReview = null;
    return { submitPullRequestReview: { pullRequestReview: { id: input.pullRequestReviewId, state: stateName, url: `https://github.com/${OWNER}/${REPO}/pull/2#pullrequestreview-9` } } };
  }
  if (query.includes('resolveReviewThread(input') || query.includes('unresolveReviewThread(input')) {
    const resolved = !query.includes('unresolveReviewThread');
    record(resolved ? 'resolveReviewThread' : 'unresolveReviewThread');
    const thread = state.threads.find((item) => item.id === input.threadId);
    thread.isResolved = resolved;
    const name = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    return { [name]: { thread: { id: thread.id, isResolved: resolved } } };
  }
  if (query.includes('markFileAsViewed(input') || query.includes('unmarkFileAsViewed(input')) {
    const viewed = !query.includes('unmarkFileAsViewed');
    record(viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed');
    state.viewed[input.path] = viewed;
    return { [viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed']: { clientMutationId: null } };
  }
  if (query.includes('needsReview: search')) {
    return {
      viewer: { login: state.viewer },
      needsReview: { nodes: STACK.slice(0, 3).map(summary) },
      mine: { nodes: [] },
      reviewed: { nodes: [summary(STACK[3])] },
    };
  }
  if (query.includes('pullRequests(states: OPEN')) {
    return {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: STACK.map((pr) => ({ ...pr, headRepositoryOwner: { login: OWNER } })),
        },
      },
    };
  }
  if (query.includes('pr0: pullRequest')) {
    const repository = {};
    const aliases = query.match(/pr\d+: pullRequest\(number: \d+\)/g) || [];
    aliases.forEach((alias) => {
      const [, key, number] = alias.match(/(pr\d+): pullRequest\(number: (\d+)\)/);
      const pr = STACK.find((item) => item.number === Number(number));
      repository[key] = pr ? summary(pr) : null;
    });
    return { repository };
  }
  if (query.includes('reviewThreads(first: 50')) {
    return {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.threads },
        },
      },
    };
  }
  if (query.includes('files(first: 100')) {
    return {
      repository: {
        pullRequest: {
          files: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: Object.entries(state.viewed).map(([path, viewed]) => ({ path, viewerViewedState: viewed ? 'VIEWED' : 'UNVIEWED' })),
          },
        },
      },
    };
  }
  if (query.includes('pendingReviews: reviews')) {
    if (variables.number !== 2) {
      return { viewer: { login: state.viewer }, repository: { nameWithOwner: `${OWNER}/${REPO}`, defaultBranchRef: { name: 'main' }, pullRequest: null } };
    }
    return {
      viewer: { login: state.viewer },
      repository: { nameWithOwner: `${OWNER}/${REPO}`, defaultBranchRef: { name: 'main' }, pullRequest: pullRequest(state) },
    };
  }
  return { errors: [{ message: `fake-github: unhandled query ${query.slice(0, 80)}` }] };
}

function rest(state, method, pathname, search, accept) {
  const prefix = `/repos/${OWNER}/${REPO}`;
  if (pathname === `${prefix}/pulls/2` && accept.includes('diff')) {
    return { type: 'text/plain', body: PR2_DIFF };
  }
  const compare = pathname.match(new RegExp(`^${prefix}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`));
  if (compare) {
    if (accept.includes('diff')) {
      return { type: 'text/plain', body: PR2_DIFF.split('diff --git a/docs')[0] };
    }
    return { json: { merge_base_commit: { sha: compare[1] === BASE_OID ? MERGE_BASE_OID : compare[1] } } };
  }
  const commit = pathname.match(new RegExp(`^${prefix}/commits/([0-9a-f]+)$`));
  if (commit) {
    return { json: { sha: commit[1], parents: [{ sha: MERGE_BASE_OID }] } };
  }
  const contents = pathname.match(new RegExp(`^${prefix}/contents/(.+)$`));
  if (contents) {
    const ref = new URLSearchParams(search).get('ref');
    const body = CONTENT[`${ref}:${decodeURIComponent(contents[1])}`];
    return body === undefined ? { status: 404, json: { message: 'Not Found' } } : { type: 'text/plain', body };
  }
  return { status: 404, json: { message: `fake-github: no route for ${method} ${pathname}` } };
}

function startFakeGitHub(port = 0) {
  const state = createState();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      if (req.headers.authorization !== 'bearer test-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      if (url.pathname === '/graphql') {
        const { query, variables } = JSON.parse(body);
        const result = graphql(state, query, variables);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.errors ? { data: null, errors: result.errors } : { data: result }));
        return;
      }
      const result = rest(state, req.method, url.pathname, url.search, req.headers.accept || '');
      res.writeHead(result.status || 200, { 'Content-Type': result.json ? 'application/json' : result.type });
      res.end(result.json ? JSON.stringify(result.json) : result.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        reset() {
          Object.assign(state, createState());
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = {
  BASE_OID,
  HEAD_OID,
  LAST_REVIEWED_OID,
  MERGE_BASE_OID,
  OWNER,
  REPO,
  startFakeGitHub,
};

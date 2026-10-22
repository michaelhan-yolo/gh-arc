'use strict';

// An in-memory GitHub for tests: the REST and GraphQL calls gh-arc makes, against a
// three-pull-request stack (main <- feat-a <- feat-b <- feat-c). Mutations are recorded.

const http = require('http');
const zlib = require('zlib');

const OWNER = 'octo';
const REPO = 'widgets';
const BASE_OID = 'a'.repeat(40);
const MERGE_BASE_OID = 'b'.repeat(40);
const HEAD_OID = 'c'.repeat(40);
const LAST_REVIEWED_OID = 'd'.repeat(40);
const FORCED_OID = 'e'.repeat(40);
const OLD_MERGE_BASE_OID = '1'.repeat(40);
const WIP_OID = '9'.repeat(40);

// Versions of pull request 2: V1 (force-pushed away) and V2 sit on an older base whose v25 is 0;
// the base then moved (v25 = 25) and was merged in before V3, the head.
function appText(overrides, extra) {
  const lines = [];
  for (let ii = 1; ii <= 30; ii++) {
    lines.push(overrides[ii] || `const v${ii} = ${ii};`);
    if (extra && ii === 20) {
      lines.push('const extra = true;');
    }
  }
  return `${lines.join('\n')}\n`;
}

const OLD_DOC = '# Title\nold body\nend\n';

// A solid-colour PNG, so image tests need no fixture files.
function solidPng(width, height, rgb) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, ii) => rgb[ii % 3])]);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

const OLD_LOGO = solidPng(160, 100, [220, 60, 60]);
const NEW_LOGO = solidPng(160, 100, [40, 120, 220]);
const BADGE = solidPng(80, 80, [40, 160, 90]);
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e3a008"/></svg>\n';
const PR3_HEAD = '3'.repeat(40);

// Images uploaded to comments: GitHub redirects an asset id to short-lived storage links.
const ATTACHMENTS = {
  '11111111-1111-4111-8111-111111111111': { type: 'image/png', body: solidPng(420, 240, [120, 80, 200]) },
  '22222222-2222-4222-8222-222222222222': { type: 'image/png', body: solidPng(1600, 300, [30, 150, 150]) },
  '33333333-3333-4333-8333-333333333333': { type: 'text/html', body: '<html>not an image</html>' },
  '44444444-4444-4444-8444-444444444444': { redirect: 'https://evil.example/steal.png' },
};
// A signed link whose token expired long ago, as a page left open past five minutes holds.
const EXPIRED_JWT = `e30.${Buffer.from(JSON.stringify({ exp: 1000 })).toString('base64url')}.sig`;
const signedImage = (id) => `https://private-user-images.githubusercontent.com/1/2-${id}.png?jwt=${EXPIRED_JWT}`;

const CONTENT = {
  [`${MERGE_BASE_OID}:src/app.js`]: appText({}),
  [`${HEAD_OID}:src/app.js`]: appText({ 10: 'const v10 = 100;' }, true),
  [`${OLD_MERGE_BASE_OID}:src/app.js`]: appText({ 25: 'const v25 = 0;' }),
  [`${LAST_REVIEWED_OID}:src/app.js`]: appText({ 10: 'const v10 = 99;', 25: 'const v25 = 0;' }),
  [`${FORCED_OID}:src/app.js`]: appText({ 10: 'const v10 = 50;', 25: 'const v25 = 0;' }),
  [`${MERGE_BASE_OID}:docs/old.md`]: OLD_DOC,
  [`${OLD_MERGE_BASE_OID}:docs/old.md`]: OLD_DOC,
  [`${LAST_REVIEWED_OID}:docs/old.md`]: OLD_DOC,
  [`${FORCED_OID}:docs/old.md`]: OLD_DOC,
  [`${HEAD_OID}:docs/new.md`]: '# Title\nnew body\nend\n',
  [`${BASE_OID}:assets/logo.png`]: OLD_LOGO,
  [`${PR3_HEAD}:assets/logo.png`]: NEW_LOGO,
  [`${PR3_HEAD}:assets/badge.png`]: BADGE,
  [`${BASE_OID}:assets/icon.svg`]: ICON_SVG,
  [`${PR3_HEAD}:assets/notes.png`]: 'not really a png\n',
};

const COMPARES = {
  [HEAD_OID]: {
    mergeBase: MERGE_BASE_OID,
    files: [
      { filename: 'src/app.js', status: 'modified', sha: 'blob-head-app' },
      { filename: 'docs/new.md', previous_filename: 'docs/old.md', status: 'renamed', sha: 'blob-head-doc' },
    ],
  },
  [LAST_REVIEWED_OID]: { mergeBase: OLD_MERGE_BASE_OID, files: [{ filename: 'src/app.js', status: 'modified', sha: 'blob-v2-app' }] },
  [FORCED_OID]: { mergeBase: OLD_MERGE_BASE_OID, files: [{ filename: 'src/app.js', status: 'modified', sha: 'blob-v1-app' }] },
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

// Pull request 3 changes images: one replaced, one added, an SVG deleted.
const PR3_DIFF = `${PR2_DIFF}${[
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 5555555..6666666 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/assets/badge.png b/assets/badge.png',
  'new file mode 100644',
  'index 0000000..7777777',
  'Binary files /dev/null and b/assets/badge.png differ',
  'diff --git a/assets/icon.svg b/assets/icon.svg',
  'deleted file mode 100644',
  'index 8888888..0000000',
  '--- a/assets/icon.svg',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  `-${ICON_SVG.trim()}`,
  '',
].join('\n')}`;

const PR3_BODY = [
  '<p>Animates the widgets.</p>',
  '<table><thead><tr><th>Before</th><th>After</th></tr></thead><tbody><tr>',
  `<td><a target="_blank" rel="noopener noreferrer" href="${signedImage('11111111-1111-4111-8111-111111111111')}">`,
  `<img src="${signedImage('11111111-1111-4111-8111-111111111111')}" width="420" alt="Before" style="max-width: 100%;"></a></td>`,
  '<td><img src="https://github.com/user-attachments/assets/22222222-2222-4222-8222-222222222222" alt="After, wide"></td>',
  '</tr></tbody></table>',
].join('');

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
    // Per pull request: where it sits, who wrote it, who is asked to review it, who blocks it,
    // and whether it is a draft, accepted, closed or merged.
    prs: Object.fromEntries(STACK.concat(MINE).map((pr) => [pr.number, {
      baseRefName: pr.baseRefName,
      author: pr.number === 1 || MINE.includes(pr) ? 'me' : 'dana',
      requested: pr.number === 2 ? ['me'] : [],
      blockedBy: null,
      draft: pr.number === 3,
      approved: false,
      closed: false,
      merged: false,
      failMerge: false,
      failReviewRequest: false,
    }])),
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

// The viewer's own pull requests: a two-pull-request stack and one on its own.
const MINE = [
  { number: 20, title: 'Widget docs', baseRefName: 'main', headRefName: 'docs-a' },
  { number: 21, title: 'Widget docs examples', baseRefName: 'docs-a', headRefName: 'docs-b' },
  { number: 30, title: 'Fix a typo', baseRefName: 'main', headRefName: 'typo' },
];

function headOid(number) {
  return number === 2 ? HEAD_OID : String(number).repeat(40).slice(0, 40);
}

function summary(state, pr) {
  const live = state.prs[pr.number];
  const onTrunk = live.baseRefName === 'main';
  return {
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: `https://github.com/${OWNER}/${REPO}/pull/${pr.number}`,
    state: live.merged ? 'MERGED' : live.closed ? 'CLOSED' : 'OPEN',
    isDraft: live.draft,
    merged: live.merged,
    baseRefName: live.baseRefName,
    headRefName: pr.headRefName,
    baseRefOid: BASE_OID,
    headRefOid: headOid(pr.number),
    additions: 3,
    deletions: 2,
    reviewDecision: onTrunk ? (live.blockedBy ? 'CHANGES_REQUESTED' : live.approved ? 'APPROVED' : 'REVIEW_REQUIRED') : null,
    mergeStateStatus: onTrunk && !live.approved ? 'BLOCKED' : 'CLEAN',
    latestOpinionatedReviews: {
      nodes: [
        live.approved ? { state: 'APPROVED', submittedAt: '2026-10-02T11:00:00Z', author: actor('carol') } : null,
        live.blockedBy ? { state: 'CHANGES_REQUESTED', submittedAt: '2026-10-02T12:00:00Z', author: actor(live.blockedBy) } : null,
      ].filter(Boolean),
    },
    reviewRequests: { nodes: live.requested.map((login) => ({ requestedReviewer: { __typename: 'User', ...actor(login) } })) },
    author: actor(live.author),
    lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    updatedAt: '2026-10-02T10:00:00Z',
    repository: { nameWithOwner: `${OWNER}/${REPO}` },
    headRepositoryOwner: { login: OWNER },
  };
}

function pullRequest(state, number) {
  return {
    ...summary(state, STACK.find((pr) => pr.number === number)),
    body: 'Renders the widgets.',
    bodyHTML: number === 3
      ? PR3_BODY
      : '<p>Renders the widgets. Stacked on <a href="https://github.com/octo/widgets/pull/1">#1</a>.</p>',
    mergedAt: null,
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-02T09:00:00Z',
    baseRefOid: BASE_OID,
    changedFiles: 2,
    mergeable: 'MERGEABLE',
    viewerCanUpdate: true,
    viewerCanClose: !state.prs[number].closed,
    viewerCanReopen: state.prs[number].closed,
    labels: { nodes: [{ name: 'frontend', color: '1d76db' }] },
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
      nodes: [
        {
          id: 'IC_bot',
          createdAt: '2026-10-01T10:30:00Z',
          bodyHTML: '<p>Tests PASSED</p>',
          url: `https://github.com/${OWNER}/${REPO}/pull/2#issuecomment-0`,
          author: { __typename: 'Bot', login: 'github-actions', avatarUrl: '' },
        },
        {
          id: 'IC_1',
          createdAt: '2026-10-01T11:00:00Z',
          bodyHTML: '<p>Looks close.</p>',
          url: `https://github.com/${OWNER}/${REPO}/pull/2#issuecomment-1`,
          author: actor('alice'),
        },
      ],
    },
    commits: {
      totalCount: 3,
      nodes: [
        { commit: { oid: LAST_REVIEWED_OID, abbreviatedOid: 'ddddddd', messageHeadline: 'Render widgets', committedDate: '2026-10-01T09:00:00Z', parents: { totalCount: 1 }, checkSuites: { totalCount: 3 }, author: { name: 'Dana', user: actor('dana') } } },
        { commit: { oid: WIP_OID, abbreviatedOid: '9999999', messageHeadline: 'Merge main into feat-b', committedDate: '2026-10-02T08:00:00Z', parents: { totalCount: 2 }, checkSuites: { totalCount: 0 }, author: { name: 'Dana', user: actor('dana') } } },
        { commit: { oid: HEAD_OID, abbreviatedOid: 'ccccccc', messageHeadline: 'Use 100 for v10', committedDate: '2026-10-02T09:00:00Z', parents: { totalCount: 1 }, checkSuites: { totalCount: 3 }, author: { name: 'Dana', user: actor('dana') } } },
      ],
    },
    forcePushes: {
      nodes: [{
        createdAt: '2026-10-01T08:30:00Z',
        beforeCommit: { oid: FORCED_OID, abbreviatedOid: 'eeeeeee', messageHeadline: 'Render widgets (first try)', committedDate: '2026-10-01T08:00:00Z', parents: { totalCount: 1 } },
        afterCommit: { oid: LAST_REVIEWED_OID },
      }],
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

const STATE_CHANGES = {
  convertPullRequestToDraft: { draft: true },
  markPullRequestReadyForReview: { draft: false },
  closePullRequest: { closed: true },
  reopenPullRequest: { closed: false },
};

function graphql(state, query, variables) {
  const input = variables && variables.input;
  const record = (name) => state.calls.push({ name, input });
  const numberOf = (id) => Number(String(id).replace('PR_', ''));

  if (query.includes('query ShipInfo')) {
    const pr = STACK.concat(MINE).find((item) => item.number === variables.number);
    const live = pr && state.prs[pr.number];
    return {
      repository: {
        defaultBranchRef: { name: 'main' },
        pullRequest: pr ? {
          id: `PR_${pr.number}`,
          number: pr.number,
          state: live.merged ? 'MERGED' : 'OPEN',
          merged: live.merged,
          baseRefName: live.baseRefName,
          headRefName: pr.headRefName,
          headRefOid: headOid(pr.number),
          author: actor(live.author),
          headRepositoryOwner: { login: OWNER },
        } : null,
      },
    };
  }
  if (query.includes('query MergedForHead')) {
    const pr = STACK.concat(MINE).find((item) => item.headRefName === variables.head && state.prs[item.number].merged);
    return { repository: { pullRequests: { nodes: pr ? [{ number: pr.number }] : [] } } };
  }
  if (query.includes('updatePullRequest(input')) {
    record('updatePullRequest');
    state.prs[numberOf(input.pullRequestId)].baseRefName = input.baseRefName;
    return { updatePullRequest: { pullRequest: { number: numberOf(input.pullRequestId), baseRefName: input.baseRefName } } };
  }
  if (query.includes('mergePullRequest(input')) {
    record('mergePullRequest');
    const number = numberOf(input.pullRequestId);
    const live = state.prs[number];
    if (live.failMerge) {
      return { errors: [{ message: 'Required status check "lint" is failing.' }] };
    }
    if (input.expectedHeadOid !== headOid(number)) {
      return { errors: [{ message: 'Head branch was modified. Review and try the merge again.' }] };
    }
    live.merged = true;
    return { mergePullRequest: { pullRequest: { number, merged: true, url: `https://github.com/${OWNER}/${REPO}/pull/${number}` } } };
  }

  if (query.includes('requestReviewsByLogin(input')) {
    record('requestReviewsByLogin');
    const live = state.prs[numberOf(input.pullRequestId)];
    if (live.failReviewRequest) {
      return { errors: [{ message: 'Could not resolve the requested reviewer.' }] };
    }
    live.requested = Array.from(new Set(live.requested.concat(input.userLogins)));
    return { requestReviewsByLogin: { pullRequest: { id: input.pullRequestId } } };
  }
  const stateChange = Object.entries(STATE_CHANGES).find(([name]) => query.includes(`${name}(input`));
  if (stateChange) {
    const [name, change] = stateChange;
    record(name);
    Object.assign(state.prs[numberOf(input.pullRequestId)], change);
    return { [name]: { pullRequest: { id: input.pullRequestId } } };
  }

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
  if (query.includes('query Inbox(')) {
    const prs = variables.query.includes('review-requested:') ? STACK.slice(0, 3)
      : variables.query.includes('reviewed-by:') ? [STACK[3]] : MINE;
    return {
      viewer: { login: state.viewer },
      search: {
        nodes: prs.map((pr) => summary(state, pr)),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  }
  if (query.includes('pullRequests(states: OPEN')) {
    return {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: STACK.filter((pr) => !state.prs[pr.number].merged)
            .map((pr) => ({ ...pr, baseRefName: state.prs[pr.number].baseRefName, headRepositoryOwner: { login: OWNER } })),
        },
      },
    };
  }
  if (query.includes('pr0: pullRequest')) {
    const repository = {};
    const aliases = query.match(/pr\d+: pullRequest\(number: \d+\)/g) || [];
    aliases.forEach((alias) => {
      const [, key, number] = alias.match(/(pr\d+): pullRequest\(number: (\d+)\)/);
      const pr = STACK.concat(MINE).find((item) => item.number === Number(number));
      repository[key] = pr ? summary(state, pr) : null;
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
    const known = [1, 2, 3].includes(variables.number);
    return {
      viewer: { login: state.viewer },
      repository: {
        nameWithOwner: `${OWNER}/${REPO}`,
        defaultBranchRef: { name: 'main' },
        viewerPermission: 'WRITE',
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        viewerDefaultMergeMethod: 'MERGE',
        deleteBranchOnMerge: false,
        pullRequest: known ? pullRequest(state, variables.number) : null,
      },
    };
  }
  return { errors: [{ message: `fake-github: unhandled query ${query.slice(0, 80)}` }] };
}

function rest(state, method, pathname, search, accept) {
  const prefix = `/repos/${OWNER}/${REPO}`;
  const ref = pathname.match(new RegExp(`^${prefix}/git/refs/heads/(.+)$`));
  if (ref && method === 'DELETE') {
    state.calls.push({ name: 'deleteRef', input: decodeURIComponent(ref[1]) });
    return { status: 204, type: 'text/plain', body: '' };
  }
  if (/^\/repos\/octo\/widgets\/pulls\/[123]$/.test(pathname) && accept.includes('diff')) {
    return { type: 'text/plain', body: pathname.endsWith('/3') ? PR3_DIFF : PR2_DIFF };
  }
  const compare = pathname.match(new RegExp(`^${prefix}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`));
  if (compare) {
    if (accept.includes('diff')) {
      return { type: 'text/plain', body: PR2_DIFF.split('diff --git a/docs')[0] };
    }
    const known = compare[1] === BASE_OID && COMPARES[compare[2]];
    return {
      json: {
        merge_base_commit: { sha: known ? known.mergeBase : compare[1] },
        files: known ? known.files : [],
      },
    };
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
      const stored = url.pathname.match(/^\/storage\/([0-9a-f-]+)$/);
      if (stored) {
        // Signed storage links carry their own signature; a token sent here would be a leak.
        const asset = ATTACHMENTS[stored[1]];
        state.calls.push({ name: 'storage', input: { id: stored[1], authorization: req.headers.authorization || null } });
        res.writeHead(req.headers.authorization ? 400 : 200, { 'Content-Type': asset.type });
        res.end(req.headers.authorization ? 'token sent to storage' : asset.body);
        return;
      }
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
      const attachment = url.pathname.match(/^\/user-attachments\/assets\/([0-9a-f-]+)$/);
      if (attachment) {
        const asset = ATTACHMENTS[attachment[1]];
        state.calls.push({ name: 'attachment', input: attachment[1] });
        res.writeHead(asset ? 302 : 404, asset ? { Location: asset.redirect || `/storage/${attachment[1]}?X-Amz-Signature=x` } : {});
        res.end();
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
  FORCED_OID,
  HEAD_OID,
  LAST_REVIEWED_OID,
  MERGE_BASE_OID,
  OLD_MERGE_BASE_OID,
  OWNER,
  PR3_HEAD,
  REPO,
  startFakeGitHub,
};

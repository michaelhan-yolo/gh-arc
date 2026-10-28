'use strict';

const childProcess = require('child_process');

const API_URL = (process.env.GH_ARC_API_URL || 'https://api.github.com').replace(/\/$/, '');
const WEB_URL = (process.env.GH_ARC_WEB_URL || 'https://github.com').replace(/\/$/, '');
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let cachedToken = null;
const rateLimits = new Map();

// Speculative reads stop with a reserve for explicit navigation and review actions.
function canPrefetch() {
  return ['core', 'graphql'].every((resource) => {
    const budget = rateLimits.get(resource);
    return budget && budget.reset > Date.now() && budget.remaining > Math.max(50, budget.limit * 0.2);
  });
}


function token() {
  if (cachedToken) {
    return cachedToken;
  }
  if (process.env.GH_ARC_TOKEN) {
    cachedToken = process.env.GH_ARC_TOKEN;
    return cachedToken;
  }
  const result = childProcess.spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  if (!value) {
    throw new GitHubError(401, 'No GitHub token. Run `gh auth login` first.');
  }
  cachedToken = value;
  return cachedToken;
}

async function request(method, path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `bearer ${token()}`,
      Accept: options.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gh-arc',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const resource = res.headers.get('x-ratelimit-resource');
  if (resource) rateLimits.set(resource, {
    remaining: Number(res.headers.get('x-ratelimit-remaining')),
    limit: Number(res.headers.get('x-ratelimit-limit')),
    reset: Number(res.headers.get('x-ratelimit-reset')) * 1000,
  });
  if (!res.ok) {
    if (res.status >= 500) {
      await res.body.cancel();
      throw new GitHubError(res.status, `GitHub is temporarily unavailable (HTTP ${res.status}). Try again in a moment.`);
    }
    const text = await res.text();
    throw new GitHubError(res.status, errorMessage(text) || `GitHub request failed (HTTP ${res.status}).`);
  }
  if (options.bytes) {
    return readBytes(res);
  }
  const text = await res.text();
  if (options.raw) {
    return text;
  }
  return text ? JSON.parse(text) : null;
}

async function readBytes(res) {
  if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) {
    throw new GitHubError(413, 'That file is too large to show.');
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new GitHubError(413, 'That file is too large to show.');
  }
  return bytes;
}

// Where an attachment's redirects may lead: GitHub itself and its asset storage.
function assetHost(url) {
  if (url.origin === new URL(WEB_URL).origin) {
    return true;
  }
  return url.protocol === 'https:' &&
    (/\.githubusercontent\.com$/.test(url.hostname) || /^github-[a-z0-9-]+\.s3\.amazonaws\.com$/.test(url.hostname));
}

// Downloads an image GitHub hosts, following redirects only to its own hosts. The token goes
// only to GitHub's web origin, never to the storage a redirect points at.
async function download(href, withToken) {
  let url = new URL(href);
  for (let hop = 0; hop < 5; hop++) {
    if (!assetHost(url)) {
      throw new GitHubError(502, `Refusing to fetch an image from ${url.hostname}.`);
    }
    const sendToken = withToken && hop === 0 && url.origin === new URL(WEB_URL).origin;
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'gh-arc',
        Accept: 'image/*',
        ...(sendToken ? { Authorization: `bearer ${token()}` } : {}),
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (!res.ok) {
      throw new GitHubError(res.status === 404 ? 404 : 502, `GitHub answered ${res.status} for that image.`);
    }
    return readBytes(res);
  }
  throw new GitHubError(502, 'Too many redirects for that image.');
}

// An image uploaded to a comment or description, by its asset id.
function fetchAttachment(id) {
  return download(`${WEB_URL}/user-attachments/assets/${encodeURIComponent(id)}`, true);
}

function fetchSignedImage(href) {
  return download(href, false);
}

function errorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    const details = Array.isArray(parsed.errors)
      ? parsed.errors.map((item) => (typeof item === 'string' ? item : item.message)).filter(Boolean)
      : [];
    return [parsed.message, ...details].filter(Boolean).join(': ');
  } catch (err) {
    return '';
  }
}

async function graphql(query, variables) {
  const data = await request('POST', '/graphql', { body: { query, variables } });
  if (data && Array.isArray(data.errors) && data.errors.length) {
    throw new GitHubError(422, data.errors.map((item) => item.message).join('; '));
  }
  return data.data;
}

const ACTOR = '__typename login avatarUrl(size: 64)';

const PR_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    defaultBranchRef { name }
    viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod deleteBranchOnMerge
    pullRequest(number: $number) {
      id number title url state isDraft merged mergedAt createdAt updatedAt
      body bodyHTML
      author { ${ACTOR} }
      baseRefName headRefName baseRefOid headRefOid
      additions deletions changedFiles
      reviewDecision mergeable mergeStateStatus
      viewerCanUpdate viewerCanClose viewerCanReopen
      headRepositoryOwner { login }
      labels(first: 20) { nodes { name color } }
      reviewRequests(first: 30) {
        nodes { requestedReviewer { __typename ... on User { ${ACTOR} } ... on Team { name slug } ... on Bot { ${ACTOR} } } }
      }
      latestOpinionatedReviews(first: 30) { nodes { state submittedAt author { ${ACTOR} } } }
      pendingReviews: reviews(states: PENDING, first: 5) { nodes { id author { login } comments { totalCount } } }
      reviews(last: 100) {
        nodes { id state submittedAt body bodyHTML url author { ${ACTOR} } commit { oid } comments { totalCount } }
      }
      comments(last: 100) { nodes { id createdAt bodyHTML url author { ${ACTOR} } } }
      commits(last: 100) {
        totalCount
        nodes { commit {
          oid abbreviatedOid messageHeadline committedDate parents { totalCount } checkSuites { totalCount }
          author { name user { login } }
        } }
      }
      forcePushes: timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], last: 50) {
        nodes { ... on HeadRefForcePushedEvent {
          createdAt
          beforeCommit { oid abbreviatedOid messageHeadline committedDate parents { totalCount } }
          afterCommit { oid }
        } }
      }
      lastCommit: commits(last: 1) {
        nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount nodes {
          __typename
          ... on CheckRun { name conclusion status detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } } } }
      }
    }
  }
}`;

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide startDiffSide subjectType
          viewerCanResolve viewerCanUnresolve viewerCanReply
          resolvedBy { login }
          comments(first: 100) {
            nodes { id databaseId body bodyHTML createdAt url diffHunk author { ${ACTOR} } pullRequestReview { id state } }
          }
        }
      }
    }
  }
}`;

const FILES_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

const OPEN_PRS_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number baseRefName headRefName headRepositoryOwner { login } }
    }
  }
}`;

const STACK_PR_FIELDS = `
  id number title url state isDraft merged baseRefName headRefName baseRefOid headRefOid additions deletions reviewDecision
  mergeStateStatus
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } } } }
  author { ${ACTOR} }
  lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const INBOX_PR_FIELDS = `
  ... on PullRequest {
    ${STACK_PR_FIELDS}
    updatedAt mergedAt
    repository { nameWithOwner }
    headRepositoryOwner { login }
  }
`;

async function paginate(query, variables, pick, fetchPage = graphql) {
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const data = await fetchPage(query, { ...variables, cursor });
    const connection = pick(data);
    if (!connection) {
      break;
    }
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      break;
    }
    cursor = connection.pageInfo.endCursor;
  }
  return nodes;
}

async function fetchPullRequest(owner, repo, number) {
  const data = await graphql(PR_QUERY, { owner, repo, number });
  if (!data.repository || !data.repository.pullRequest) {
    throw new GitHubError(404, `Pull request ${owner}/${repo}#${number} was not found.`);
  }
  return data;
}

function fetchReviewThreads(owner, repo, number) {
  return paginate(THREADS_QUERY, { owner, repo, number },
    (data) => data.repository && data.repository.pullRequest && data.repository.pullRequest.reviewThreads);
}

function fetchFileViewedStates(owner, repo, number) {
  return paginate(FILES_QUERY, { owner, repo, number },
    (data) => data.repository && data.repository.pullRequest && data.repository.pullRequest.files);
}

function fetchOpenPullRequests(owner, repo) {
  return paginate(OPEN_PRS_QUERY, { owner, repo },
    (data) => data.repository && data.repository.pullRequests);
}

async function fetchPullRequestSummaries(owner, repo, numbers) {
  if (!numbers.length) {
    return [];
  }
  const fields = numbers.map((number, index) =>
    `pr${index}: pullRequest(number: ${Number(number)}) { ${STACK_PR_FIELDS} }`).join('\n');
  const data = await graphql(
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`,
    { owner, repo });
  return numbers.map((number, index) => data.repository[`pr${index}`]).filter(Boolean);
}

// Keep inbox reads small and retry temporary gateway failures without replaying mutations.
async function fetchInboxPage(query, variables) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await graphql(query, variables);
    } catch (err) {
      if (![502, 503, 504].includes(err.status)) {
        throw err;
      }
      if (attempt >= 2) {
        throw new GitHubError(err.status, `GitHub is temporarily unavailable (HTTP ${err.status}). Try again in a moment.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

async function fetchInbox() {
  // Landed rows need no review or check lookups, so their history can use larger pages.
  const landedFields = `... on PullRequest {
    number title state merged mergedAt updatedAt additions deletions
    author { ${ACTOR} }
    repository { nameWithOwner }
  }`;
  const searches = [
    ['needsReview', 'is:open is:pr archived:false review-requested:@me'],
    ['mine', 'is:open is:pr archived:false author:@me'],
    ['reviewed', 'is:open is:pr archived:false reviewed-by:@me -author:@me'],
    ['landed', 'is:merged is:pr archived:false author:@me sort:updated-desc'],
  ];
  let viewer;
  const sections = await Promise.all(searches.map(async ([key, search]) => {
    const query = `query Inbox($query: String!, $cursor: String) {
      viewer { login }
      search(type: ISSUE, query: $query, first: ${key === 'landed' ? 100 : 30}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${key === 'landed' ? landedFields : INBOX_PR_FIELDS} }
      }
    }`;
    const nodes = await paginate(query, { query: search }, (data) => {
      viewer = data.viewer;
      return data.search;
    }, fetchInboxPage);
    return [key, { nodes }];
  }));
  return { viewer, ...Object.fromEntries(sections) };
}

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function fetchPullRequestDiff(owner, repo, number) {
  return request('GET', `${repoPath(owner, repo)}/pulls/${Number(number)}`, {
    accept: 'application/vnd.github.diff',
    raw: true,
  });
}

async function fetchPullRequestFiles(owner, repo, number) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await request('GET', `${repoPath(owner, repo)}/pulls/${Number(number)}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return files;
}

function fetchCompareDiff(owner, repo, from, to) {
  return request('GET', `${repoPath(owner, repo)}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`, {
    accept: 'application/vnd.github.diff',
    raw: true,
  });
}

async function fetchCompare(owner, repo, base, head) {
  const data = await request('GET', `${repoPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`);
  return {
    mergeBase: data.merge_base_commit.sha,
    files: (data.files || []).map((file) => ({
      filename: file.filename,
      previous_filename: file.previous_filename,
      status: file.status,
      sha: file.sha,
    })),
  };
}

async function fetchCommitParent(owner, repo, sha) {
  const data = await request('GET', `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}`);
  return data.parents && data.parents.length ? data.parents[0].sha : null;
}

async function fetchFileContent(owner, repo, filePath, ref) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  try {
    return await request('GET', `${repoPath(owner, repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
      accept: 'application/vnd.github.raw',
      raw: true,
    });
  } catch (err) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

async function fetchFileBytes(owner, repo, filePath, ref) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  try {
    return await request('GET', `${repoPath(owner, repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
      accept: 'application/vnd.github.raw',
      bytes: true,
    });
  } catch (err) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

async function addPendingReview(pullRequestId, commitOID) {
  const data = await graphql(`mutation($input: AddPullRequestReviewInput!) {
    addPullRequestReview(input: $input) { pullRequestReview { id } }
  }`, { input: { pullRequestId, commitOID } });
  return data.addPullRequestReview.pullRequestReview.id;
}

async function addReviewThread(input) {
  const data = await graphql(`mutation($input: AddPullRequestReviewThreadInput!) {
    addPullRequestReviewThread(input: $input) { thread { id } }
  }`, { input });
  return data.addPullRequestReviewThread.thread;
}

async function addReviewThreadReply(input) {
  const data = await graphql(`mutation($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) { comment { id } }
  }`, { input });
  return data.addPullRequestReviewThreadReply.comment;
}

async function submitReview(input) {
  const data = await graphql(`mutation($input: SubmitPullRequestReviewInput!) {
    submitPullRequestReview(input: $input) { pullRequestReview { id state url } }
  }`, { input });
  return data.submitPullRequestReview.pullRequestReview;
}

async function setThreadResolved(threadId, resolved) {
  const name = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  const inputType = resolved ? 'ResolveReviewThreadInput' : 'UnresolveReviewThreadInput';
  const data = await graphql(`mutation($input: ${inputType}!) {
    ${name}(input: $input) { thread { id isResolved } }
  }`, { input: { threadId } });
  return data[name].thread;
}

async function fetchShipInfo(owner, repo, number) {
  const data = await graphql(`query ShipInfo($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
      pullRequest(number: $number) {
        id number state merged baseRefName headRefName headRefOid
        author { login }
        headRepositoryOwner { login }
      }
    }
  }`, { owner, repo, number });
  if (!data.repository || !data.repository.pullRequest) {
    throw new GitHubError(404, `Pull request ${owner}/${repo}#${number} was not found.`);
  }
  return {
    defaultBranch: data.repository.defaultBranchRef ? data.repository.defaultBranchRef.name : null,
    pr: data.repository.pullRequest,
  };
}

async function fetchMergedPullRequestForHead(owner, repo, headRefName) {
  const data = await graphql(`query MergedForHead($owner: String!, $repo: String!, $head: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(headRefName: $head, states: MERGED, first: 1) { nodes { number } }
    }
  }`, { owner, repo, head: headRefName });
  const node = data.repository.pullRequests.nodes[0];
  return node ? node.number : null;
}

async function updatePullRequestBase(pullRequestId, baseRefName) {
  const data = await graphql(`mutation($input: UpdatePullRequestInput!) {
    updatePullRequest(input: $input) { pullRequest { number baseRefName } }
  }`, { input: { pullRequestId, baseRefName } });
  return data.updatePullRequest.pullRequest;
}

async function mergePullRequest(input) {
  const data = await graphql(`mutation($input: MergePullRequestInput!) {
    mergePullRequest(input: $input) { pullRequest { number merged url } }
  }`, { input });
  return data.mergePullRequest.pullRequest;
}

function deleteBranch(owner, repo, branch) {
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  return request('DELETE', `${repoPath(owner, repo)}/git/refs/heads/${ref}`, { raw: true });
}

// Asks these people for a review, keeping everyone already asked. Asking someone who reviewed
// before is GitHub's re-request.
async function requestReviews(pullRequestId, userLogins) {
  await graphql(`mutation($input: RequestReviewsByLoginInput!) {
    requestReviewsByLogin(input: $input) { pullRequest { id } }
  }`, { input: { pullRequestId, userLogins, union: true } });
}

const STATE_CHANGES = {
  draft: ['convertPullRequestToDraft', 'ConvertPullRequestToDraftInput'],
  ready: ['markPullRequestReadyForReview', 'MarkPullRequestReadyForReviewInput'],
  close: ['closePullRequest', 'ClosePullRequestInput'],
  reopen: ['reopenPullRequest', 'ReopenPullRequestInput'],
};

async function changePullRequestState(pullRequestId, change) {
  const [name, inputType] = STATE_CHANGES[change];
  await graphql(`mutation($input: ${inputType}!) {
    ${name}(input: $input) { pullRequest { id } }
  }`, { input: { pullRequestId } });
}

async function setFileViewed(pullRequestId, path, viewed) {
  const name = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  const inputType = viewed ? 'MarkFileAsViewedInput' : 'UnmarkFileAsViewedInput';
  await graphql(`mutation($input: ${inputType}!) {
    ${name}(input: $input) { clientMutationId }
  }`, { input: { pullRequestId, path } });
}

module.exports = {
  GitHubError,
  canPrefetch,
  addPendingReview,
  addReviewThread,
  addReviewThreadReply,
  changePullRequestState,
  deleteBranch,
  fetchAttachment,
  fetchCommitParent,
  fetchCompare,
  fetchCompareDiff,
  fetchFileBytes,
  fetchFileContent,
  fetchFileViewedStates,
  fetchInbox,
  fetchMergedPullRequestForHead,
  fetchShipInfo,
  fetchOpenPullRequests,
  fetchPullRequest,
  fetchPullRequestDiff,
  fetchPullRequestFiles,
  fetchPullRequestSummaries,
  fetchReviewThreads,
  fetchSignedImage,
  graphql,
  mergePullRequest,
  requestReviews,
  setFileViewed,
  setThreadResolved,
  submitReview,
  updatePullRequestBase,
};

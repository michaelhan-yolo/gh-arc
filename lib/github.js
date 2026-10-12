'use strict';

const childProcess = require('child_process');

const API_URL = (process.env.GH_ARC_API_URL || 'https://api.github.com').replace(/\/$/, '');

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let cachedToken = null;

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
  const text = await res.text();
  if (!res.ok) {
    throw new GitHubError(res.status, errorMessage(text) || `GitHub ${method} ${path} failed: ${res.status}`);
  }
  if (options.raw) {
    return text;
  }
  return text ? JSON.parse(text) : null;
}

function errorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    const details = Array.isArray(parsed.errors)
      ? parsed.errors.map((item) => (typeof item === 'string' ? item : item.message)).filter(Boolean)
      : [];
    return [parsed.message, ...details].filter(Boolean).join(': ');
  } catch (err) {
    return text.slice(0, 500);
  }
}

async function graphql(query, variables) {
  const data = await request('POST', '/graphql', { body: { query, variables } });
  if (data && Array.isArray(data.errors) && data.errors.length) {
    throw new GitHubError(422, data.errors.map((item) => item.message).join('; '));
  }
  return data.data;
}

const ACTOR = 'login avatarUrl(size: 64)';

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
  latestOpinionatedReviews(first: 20) { nodes { state } }
  author { ${ACTOR} }
  lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const INBOX_PR_FIELDS = `
  ... on PullRequest {
    ${STACK_PR_FIELDS}
    updatedAt
    repository { nameWithOwner }
    headRepositoryOwner { login }
  }
`;

async function paginate(query, variables, pick) {
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const data = await graphql(query, { ...variables, cursor });
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

async function fetchInbox() {
  const search = (alias, q) =>
    `${alias}: search(type: ISSUE, query: ${JSON.stringify(q)}, first: 60) { nodes { ${INBOX_PR_FIELDS} } }`;
  const data = await graphql(`query {
    viewer { login }
    ${search('needsReview', 'is:open is:pr archived:false review-requested:@me')}
    ${search('mine', 'is:open is:pr archived:false author:@me')}
    ${search('reviewed', 'is:open is:pr archived:false reviewed-by:@me -author:@me')}
  }`);
  return data;
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

async function setFileViewed(pullRequestId, path, viewed) {
  const name = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  const inputType = viewed ? 'MarkFileAsViewedInput' : 'UnmarkFileAsViewedInput';
  await graphql(`mutation($input: ${inputType}!) {
    ${name}(input: $input) { clientMutationId }
  }`, { input: { pullRequestId, path } });
}

module.exports = {
  GitHubError,
  addPendingReview,
  addReviewThread,
  addReviewThreadReply,
  deleteBranch,
  fetchCommitParent,
  fetchCompare,
  fetchCompareDiff,
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
  graphql,
  mergePullRequest,
  setFileViewed,
  setThreadResolved,
  submitReview,
  updatePullRequestBase,
};

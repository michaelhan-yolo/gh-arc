'use strict';

const { viewerPathFor } = require('./patch');

function actor(value) {
  return value ? { login: value.login, avatarUrl: value.avatarUrl || '' } : { login: 'ghost', avatarUrl: '' };
}

function prState(pr) {
  if (pr.merged) {
    return 'MERGED';
  }
  if (pr.state === 'OPEN' && pr.isDraft) {
    return 'DRAFT';
  }
  return pr.state;
}

function checkState(node) {
  if (node.__typename === 'CheckRun') {
    if (node.status !== 'COMPLETED') {
      return 'PENDING';
    }
    if (node.conclusion === 'SUCCESS') {
      return 'SUCCESS';
    }
    if (node.conclusion === 'CANCELLED') {
      return 'CANCELLED';
    }
    if (['NEUTRAL', 'SKIPPED', 'STALE'].includes(node.conclusion)) {
      return 'NEUTRAL';
    }
    return 'FAILURE';
  }
  if (node.state === 'SUCCESS') {
    return 'SUCCESS';
  }
  if (node.state === 'PENDING' || node.state === 'EXPECTED') {
    return 'PENDING';
  }
  return 'FAILURE';
}

function normalizeChecks(lastCommit) {
  const node = lastCommit && lastCommit.nodes[0];
  const rollup = node && node.commit.statusCheckRollup;
  if (!rollup) {
    return null;
  }
  const contexts = rollup.contexts.nodes.map((item) => ({
    name: item.__typename === 'CheckRun' ? item.name : item.context,
    state: checkState(item),
    url: item.__typename === 'CheckRun' ? item.detailsUrl : item.targetUrl,
  }));
  return { state: rollup.state, total: rollup.contexts.totalCount, contexts };
}

function rollupState(lastCommit) {
  const node = lastCommit && lastCommit.nodes[0];
  return node && node.commit.statusCheckRollup ? node.commit.statusCheckRollup.state : null;
}

function normalizeReviewers(pr) {
  const reviewers = new Map();
  pr.latestOpinionatedReviews.nodes.forEach((review) => {
    if (review.author) {
      reviewers.set(review.author.login, { ...actor(review.author), state: review.state });
    }
  });
  pr.reviewRequests.nodes.forEach(({ requestedReviewer: reviewer }) => {
    if (!reviewer) {
      return;
    }
    const login = reviewer.__typename === 'Team' ? reviewer.name : reviewer.login;
    reviewers.set(login, {
      login,
      avatarUrl: reviewer.avatarUrl || '',
      team: reviewer.__typename === 'Team',
      state: 'REQUESTED',
    });
  });
  return Array.from(reviewers.values());
}

function normalizeTimeline(pr) {
  const reviews = pr.reviews.nodes
    .filter((review) => review.state !== 'PENDING')
    .filter((review) => review.state !== 'COMMENTED' || review.body.trim())
    .map((review) => ({
      type: 'review',
      id: review.id,
      state: review.state,
      author: actor(review.author),
      bodyHTML: review.bodyHTML,
      createdAt: review.submittedAt,
      url: review.url,
      inlineCount: review.comments.totalCount,
    }));
  const comments = pr.comments.nodes.map((comment) => ({
    type: 'comment',
    id: comment.id,
    author: actor(comment.author),
    bodyHTML: comment.bodyHTML,
    createdAt: comment.createdAt,
    url: comment.url,
  }));
  return reviews.concat(comments).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function lastReviewedOid(pr, viewerLogin) {
  const mine = pr.reviews.nodes.filter((review) =>
    review.state !== 'PENDING' && review.author && review.author.login === viewerLogin && review.commit);
  return mine.length ? mine[mine.length - 1].commit.oid : null;
}

function normalizePullRequest(data, owner, repo, viewedFiles) {
  const pr = data.repository.pullRequest;
  const viewerLogin = data.viewer.login;
  const viewed = {};
  (viewedFiles || []).forEach((file) => {
    viewed[file.path] = file.viewerViewedState === 'VIEWED';
  });
  return {
    viewer: viewerLogin,
    repo: {
      owner,
      name: repo,
      nameWithOwner: data.repository.nameWithOwner,
      defaultBranch: data.repository.defaultBranchRef ? data.repository.defaultBranchRef.name : null,
    },
    pr: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: prState(pr),
      isDraft: pr.isDraft,
      merged: pr.merged,
      bodyHTML: pr.bodyHTML,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      author: actor(pr.author),
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      baseRefOid: pr.baseRefOid,
      headRefOid: pr.headRefOid,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable,
      labels: pr.labels.nodes,
      reviewers: normalizeReviewers(pr),
      checks: normalizeChecks(pr.lastCommit),
      timeline: normalizeTimeline(pr),
      commits: pr.commits.nodes.map(({ commit }) => ({
        oid: commit.oid,
        short: commit.abbreviatedOid,
        headline: commit.messageHeadline,
        date: commit.committedDate,
        author: commit.author.user ? commit.author.user.login : commit.author.name,
        isMerge: commit.parents.totalCount > 1,
      })),
      totalCommits: pr.commits.totalCount,
      lastReviewedOid: lastReviewedOid(pr, viewerLogin),
      hasPendingReview: pr.pendingReviews.nodes.some((review) => review.author && review.author.login === viewerLogin),
      viewed,
    },
  };
}

function normalizeThread(thread, files) {
  const side = thread.diffSide === 'LEFT' ? 'old' : 'new';
  const comments = thread.comments.nodes.map((comment) => ({
    id: comment.id,
    author: actor(comment.author),
    body: comment.body,
    bodyHTML: comment.bodyHTML,
    createdAt: comment.createdAt,
    url: comment.url,
    pending: Boolean(comment.pullRequestReview && comment.pullRequestReview.state === 'PENDING'),
  }));
  const first = thread.comments.nodes[0];
  const line = thread.line || thread.originalLine;
  return {
    id: thread.id,
    kind: 'thread',
    side,
    path: viewerPathFor(files, side, thread.path),
    githubPath: thread.path,
    startLine: thread.line ? thread.startLine || thread.line : thread.originalStartLine || line,
    endLine: line,
    fileLevel: thread.subjectType === 'FILE',
    resolved: thread.isResolved,
    outdated: thread.isOutdated || (!thread.line && thread.subjectType !== 'FILE'),
    resolvedBy: thread.resolvedBy ? thread.resolvedBy.login : null,
    canResolve: thread.viewerCanResolve,
    canUnresolve: thread.viewerCanUnresolve,
    canReply: thread.viewerCanReply,
    diffHunk: first ? first.diffHunk : '',
    comments,
  };
}

function normalizeStackEntry(summary, entry) {
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    state: prState(summary),
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    additions: summary.additions,
    deletions: summary.deletions,
    reviewDecision: summary.reviewDecision,
    author: actor(summary.author),
    checks: rollupState(summary.lastCommit),
    parent: entry ? entry.parent : null,
    lane: entry ? entry.lane : 0,
  };
}

function normalizeInboxPr(pr) {
  return {
    ...normalizeStackEntry(pr),
    repository: pr.repository,
    updatedAt: pr.updatedAt,
  };
}

module.exports = {
  normalizeInboxPr,
  normalizePullRequest,
  normalizeStackEntry,
  normalizeThread,
};

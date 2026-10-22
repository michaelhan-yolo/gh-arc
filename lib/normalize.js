'use strict';

const { viewerPathFor } = require('./patch');

// bot marks GitHub Apps and *[bot] accounts (Linear, github-actions, Graphite), so the page can
// put people's comments first.
function actor(value) {
  if (!value) {
    return { login: 'ghost', avatarUrl: '', bot: false };
  }
  return {
    login: value.login,
    avatarUrl: value.avatarUrl || '',
    bot: value.__typename === 'Bot' || /\[bot\]$/.test(value.login),
  };
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

// Phabricator's revision status. Branches without protection report no reviewDecision, so the
// latest approving or blocking reviews decide there. GitHub keeps a change request in its decision
// until that reviewer reviews again, but once the author asks them again they're reviewing.
function reviewStatus(pr) {
  if (pr.merged) {
    return 'MERGED';
  }
  if (pr.state === 'CLOSED') {
    return 'CLOSED';
  }
  if (pr.isDraft) {
    return 'DRAFT';
  }
  const verdicts = pr.latestOpinionatedReviews ? pr.latestOpinionatedReviews.nodes : [];
  const blockers = verdicts.filter((review) => review.state === 'CHANGES_REQUESTED');
  const decision = pr.reviewDecision;
  if (decision === 'CHANGES_REQUESTED' || (!decision && blockers.length)) {
    const requested = new Set(requestedLogins(pr));
    const askedAgain = blockers.length && blockers.every((review) => review.author && requested.has(review.author.login));
    return askedAgain ? 'UNDER_REVIEW' : 'CHANGES_REQUESTED';
  }
  if (decision === 'APPROVED' || (!decision && verdicts.some((review) => review.state === 'APPROVED'))) {
    return 'ACCEPTED';
  }
  return 'UNDER_REVIEW';
}

function requestedLogins(pr) {
  return (pr.reviewRequests ? pr.reviewRequests.nodes : [])
    .map(({ requestedReviewer: reviewer }) => (reviewer && reviewer.__typename !== 'Team' ? reviewer.login : null))
    .filter(Boolean);
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

// A version is the head after one push. GitHub keeps no push log, but CI checks run only on a
// push's tip commit, so commits with check suites mark the pushes; force-pushed-away heads come
// from the timeline. Without CI anywhere on the pull request, every commit counts.
function normalizeVersions(pr, viewerLogin) {
  const commits = pr.commits.nodes.map((node) => node.commit);
  const pushed = commits.some((commit) => commit.checkSuites && commit.checkSuites.totalCount > 0);
  const becameHead = new Map();
  const versions = commits
    .filter((commit, index) => !pushed || commit.checkSuites.totalCount > 0 || index === commits.length - 1)
    .map((commit) => ({ commit, forcePushed: false }));
  (pr.forcePushes ? pr.forcePushes.nodes : []).forEach((event) => {
    if (event.afterCommit) {
      becameHead.set(event.afterCommit.oid, event.createdAt);
    }
    if (event.beforeCommit && !versions.some((version) => version.commit.oid === event.beforeCommit.oid)) {
      versions.push({ commit: event.beforeCommit, forcePushed: true });
    }
  });
  const when = (version) => becameHead.get(version.commit.oid) || version.commit.committedDate;
  versions.sort((left, right) => String(when(left)).localeCompare(String(when(right))));
  const headIndex = versions.findIndex((version) => version.commit.oid === pr.headRefOid);
  if (headIndex !== -1 && headIndex !== versions.length - 1) {
    versions.push(versions.splice(headIndex, 1)[0]);
  }
  const reviewed = new Set(pr.reviews.nodes
    .filter((review) => review.state !== 'PENDING' && review.author && review.author.login === viewerLogin && review.commit)
    .map((review) => review.commit.oid));
  return versions.map(({ commit, forcePushed }, index) => ({
    number: index + 1,
    oid: commit.oid,
    short: commit.abbreviatedOid,
    headline: commit.messageHeadline,
    date: when({ commit }),
    isMerge: commit.parents.totalCount > 1,
    forcePushed,
    reviewedByYou: reviewed.has(commit.oid),
  }));
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
      viewerPermission: data.repository.viewerPermission,
      mergeMethods: [
        data.repository.mergeCommitAllowed ? 'MERGE' : null,
        data.repository.squashMergeAllowed ? 'SQUASH' : null,
        data.repository.rebaseMergeAllowed ? 'REBASE' : null,
      ].filter(Boolean),
      defaultMergeMethod: data.repository.viewerDefaultMergeMethod,
      deleteBranchOnMerge: data.repository.deleteBranchOnMerge,
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
      reviewStatus: reviewStatus(pr),
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      viewerCanUpdate: Boolean(pr.viewerCanUpdate),
      viewerCanClose: Boolean(pr.viewerCanClose),
      viewerCanReopen: Boolean(pr.viewerCanReopen),
      fromFork: Boolean(pr.headRepositoryOwner && pr.headRepositoryOwner.login.toLowerCase() !== owner.toLowerCase()),
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
      versions: normalizeVersions(pr, viewerLogin),
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
    headRefOid: summary.headRefOid,
    mergeStateStatus: summary.mergeStateStatus,
    additions: summary.additions,
    deletions: summary.deletions,
    reviewDecision: summary.reviewDecision,
    reviewStatus: reviewStatus(summary),
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
  reviewStatus,
  normalizeInboxPr,
  normalizePullRequest,
  normalizeVersions,
  normalizeStackEntry,
  normalizeThread,
};

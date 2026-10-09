'use strict';

const { githubPathFor } = require('./patch');

function threadInput(reviewId, draft, files) {
  const side = draft.side === 'old' ? 'LEFT' : 'RIGHT';
  const input = {
    pullRequestReviewId: reviewId,
    path: githubPathFor(files, draft.side, draft.path),
    line: draft.endLine,
    side,
    body: draft.text,
  };
  if (draft.startLine !== draft.endLine) {
    input.startLine = draft.startLine;
    input.startSide = side;
  }
  return input;
}

// Posts every draft into the viewer's pending review (creating one when none exists), then
// submits it. A draft GitHub rejects stays local with its error and the review stays pending.
async function submitDrafts({ gh, pr, viewerLogin, drafts, files, event, body }) {
  const pending = pr.pendingReviews.find((review) => review.author && review.author.login === viewerLogin);
  const reviewId = pending ? pending.id : await gh.addPendingReview(pr.id, pr.headRefOid);
  const posted = [];
  const failures = [];

  for (const draft of drafts.threads) {
    try {
      await gh.addReviewThread(threadInput(reviewId, draft, files));
      posted.push(draft.id);
    } catch (err) {
      failures.push({ id: draft.id, message: err.message });
    }
  }
  for (const reply of drafts.replies) {
    try {
      await gh.addReviewThreadReply({
        pullRequestReviewId: reviewId,
        pullRequestReviewThreadId: reply.threadId,
        body: reply.text,
      });
      posted.push(reply.id);
    } catch (err) {
      failures.push({ id: reply.id, message: err.message });
    }
  }

  if (failures.length) {
    return { submitted: false, posted, failures };
  }
  const review = await gh.submitReview({
    pullRequestReviewId: reviewId,
    event,
    ...(body && body.trim() ? { body } : {}),
  });
  return { submitted: true, posted, failures, review };
}

module.exports = {
  submitDrafts,
  threadInput,
};

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.GH_ARC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-arc-drafts-'));
const drafts = require('../../lib/drafts');

test('add-thread normalizes the range and trims the text', () => {
  const next = drafts.applyDraftChange(drafts.emptyDrafts(), {
    action: 'add-thread', side: 'old', path: 'a.js', startLine: 9, endLine: 4, text: '  hi  ',
  });
  assert.equal(next.threads.length, 1);
  assert.deepEqual(
    { side: next.threads[0].side, start: next.threads[0].startLine, end: next.threads[0].endLine, text: next.threads[0].text },
    { side: 'old', start: 4, end: 9, text: 'hi' });
});

test('add-thread rejects a missing side, path, line or text', () => {
  const base = { action: 'add-thread', side: 'new', path: 'a.js', startLine: 1, endLine: 1, text: 'x' };
  for (const bad of [{ side: 'up' }, { path: '' }, { startLine: 0 }, { endLine: 'x' }, { text: '   ' }]) {
    assert.throws(() => drafts.applyDraftChange(drafts.emptyDrafts(), { ...base, ...bad }));
  }
});

test('replies, edits, deletes and the review body round-trip through the store', () => {
  let store = drafts.emptyDrafts();
  store = drafts.applyDraftChange(store, { action: 'add-reply', threadId: 'T1', text: 'agreed' });
  const id = store.replies[0].id;
  store = drafts.applyDraftChange(store, { action: 'update', id, text: 'agreed, fixing' });
  store = drafts.applyDraftChange(store, { action: 'review', body: 'Summary', event: 'REQUEST_CHANGES' });
  store = drafts.applyDraftChange(store, { action: 'review', event: 'MERGE' });
  assert.equal(store.replies[0].text, 'agreed, fixing');
  assert.equal(store.body, 'Summary');
  assert.equal(store.event, 'REQUEST_CHANGES');

  drafts.writeDrafts('octo', 'widgets', 7, store);
  assert.deepEqual(drafts.readDrafts('octo', 'widgets', 7).replies.map((reply) => reply.text), ['agreed, fixing']);

  store = drafts.applyDraftChange(store, { action: 'delete', id });
  store = drafts.applyDraftChange(store, { action: 'review', body: '' });
  drafts.writeDrafts('octo', 'widgets', 7, store);
  assert.equal(fs.existsSync(drafts.draftsPath('octo', 'widgets', 7)), false);
});

test('draft files never escape the drafts directory', () => {
  const file = drafts.draftsPath('../../etc', 'pa/ss', 1);
  assert.equal(path.dirname(file), path.join(process.env.GH_ARC_HOME, 'drafts'));
});

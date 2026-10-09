'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs, prPathFromUrl, resolveTarget } = require('../../lib/cli');

test('parseArgs reads flags and drops a leading "pr"', () => {
  assert.deepEqual(parseArgs(['pr', '12', '--no-open', '-p', '8000', '-R', 'octo/widgets']), {
    _: ['12'], port: 8000, open: false, repo: 'octo/widgets', help: false,
  });
  assert.throws(() => parseArgs(['--repo', 'nope']));
  assert.throws(() => parseArgs(['--port', 'x']));
});

test('pull request URLs map onto local paths', () => {
  assert.equal(prPathFromUrl('https://github.com/octo/widgets/pull/12/files#diff-1'), '/octo/widgets/pull/12');
  assert.equal(prPathFromUrl('https://example.com/octo/widgets/pull/12'), null);
});

test('resolveTarget handles URLs, owner/repo#n, numbers with -R, and the inbox', () => {
  assert.equal(resolveTarget(parseArgs(['https://github.com/a/b/pull/3'])), '/a/b/pull/3');
  assert.equal(resolveTarget(parseArgs(['a/b#4'])), '/a/b/pull/4');
  assert.equal(resolveTarget(parseArgs(['#5', '-R', 'a/b'])), '/a/b/pull/5');
  assert.equal(resolveTarget(parseArgs(['inbox'])), '/');
  assert.equal(resolveTarget(parseArgs(['serve'])), '/');
});

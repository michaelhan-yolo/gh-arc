'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs, resolveTarget } = require('../../lib/cli');

test('parseArgs reads flags and drops a leading "pr"', () => {
  assert.deepEqual(parseArgs(['pr', '12', '--no-open', '-p', '8000', '-R', 'octo/widgets']), {
    _: ['12'], port: 8000, open: false, repo: 'octo/widgets', help: false, remove: false, dryRun: false,
  });
  assert.deepEqual(parseArgs(['setup', '--remove', '--dry-run']), {
    _: ['setup'], port: 7799, open: true, repo: null, help: false, remove: true, dryRun: true,
  });
  assert.throws(() => parseArgs(['--repo', 'nope']));
  assert.throws(() => parseArgs(['--port', 'x']));
});

test('resolveTarget handles URLs, owner/repo#n, numbers in the checkout or with -R, and the inbox', () => {
  assert.deepEqual(resolveTarget(parseArgs(['https://github.com/a/b/pull/3/files']), null), { repo: 'a/b', number: 3 });
  assert.deepEqual(resolveTarget(parseArgs(['a/b#4']), null), { repo: 'a/b', number: 4 });
  assert.deepEqual(resolveTarget(parseArgs(['#5', '-R', 'a/b']), 'c/d'), { repo: 'a/b', number: 5 });
  assert.deepEqual(resolveTarget(parseArgs(['6']), 'c/d'), { repo: 'c/d', number: 6 });
  assert.throws(() => resolveTarget(parseArgs(['6']), null), /pass -R/);
  assert.equal(resolveTarget(parseArgs(['inbox']), 'c/d'), null);
  assert.equal(resolveTarget(parseArgs(['serve']), 'c/d'), null);
});

test('home-repository pages are short and every other repository is spelled out', () => {
  const routes = require('../../web/routes');
  assert.equal(routes.diffPath('Astroblox-Tech/astro-code', 11505, 'astroblox-tech/astro-code'), '/diffs/11505');
  assert.equal(routes.diffPath('octo/widgets', 2, 'astroblox-tech/astro-code'), '/diffs/octo/widgets/2');
  assert.deepEqual(routes.parseDiffPath('/diffs/11505', 'astroblox-tech/astro-code'), { repo: 'astroblox-tech/astro-code', number: 11505 });
  assert.deepEqual(routes.parseDiffPath('/diffs/octo/widgets/2/', null), { repo: 'octo/widgets', number: 2 });
  assert.equal(routes.parseDiffPath('/diffs/11505', null), null);
  assert.deepEqual(routes.parseGitHubPath('/octo/widgets/pull/2/files'), { repo: 'octo/widgets', number: 2 });
});

test('under the diffs host the paths drop /diffs and never claim the app prefixes', () => {
  const routes = require('../../web/routes');
  assert.equal(routes.diffPath('a/b', 7, 'a/b', true), '/7');
  assert.equal(routes.diffPath('c/d', 7, 'a/b', true), '/c/d/7');
  assert.equal(routes.isAliasHost('diffs'), true);
  assert.equal(routes.isAliasHost('DIFFS:7799'), true);
  assert.equal(routes.isAliasHost('localhost:7799'), false);
  assert.deepEqual(routes.parseDiffPath('/7', 'a/b'), { repo: 'a/b', number: 7 });
  assert.deepEqual(routes.parseDiffPath('/c/d/7', 'a/b'), { repo: 'c/d', number: 7 });
  assert.equal(routes.parseDiffPath('/diffs/x/7', 'a/b'), null);
  assert.equal(routes.parseDiffPath('/api/x/7', 'a/b'), null);
});

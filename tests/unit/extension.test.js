'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const T = require('../../extension/takeover');

test('parsePullUrl takes pull requests and their tabs, and nothing else on GitHub', () => {
  const pull = { owner: 'octo', repo: 'widgets', number: 12, commit: null, skip: false };
  assert.deepEqual(T.parsePullUrl('https://github.com/octo/widgets/pull/12'), pull);
  ['/', '/files', '/commits', '/checks', '/changes', '/files/'].forEach((tab) => {
    assert.deepEqual(T.parsePullUrl(`https://github.com/octo/widgets/pull/12${tab === '/' ? '/' : tab}`), pull, tab);
  });
  assert.deepEqual(T.parsePullUrl('https://github.com/octo/widgets/pull/12/files?w=1#diff-abc'), pull);
  assert.equal(T.parsePullUrl('https://github.com/octo/widgets/pull/12/commits/abc1234').commit, 'abc1234');
  assert.equal(T.parsePullUrl('https://github.com/octo/widgets/pull/12/files/ABC1234').commit, 'abc1234');
  assert.equal(T.parsePullUrl('https://github.com/octo/widgets/pull/12?gh-arc=off').skip, true);

  [
    'https://github.com/octo/widgets',
    'https://github.com/octo/widgets/pulls',
    'https://github.com/octo/widgets/issues/12',
    'https://github.com/octo/widgets/pull/new/my-branch',
    'https://github.com/octo/widgets/pull/12.diff',
    'https://github.com/octo/widgets/pull/12/conflicts',
    'https://github.com/octo/widgets/pull/12/files/abc1234..def5678',
    'https://gist.github.com/octo/widgets/pull/12',
    'http://github.com/octo/widgets/pull/12',
    'not a url',
  ].forEach((href) => assert.equal(T.parsePullUrl(href), null, href));
});

test('takeoverUrl sends the GitHub shape to the server, which redirects it to the page', () => {
  const pull = T.parsePullUrl('https://github.com/octo/widgets/pull/12/files');
  assert.equal(T.takeoverUrl('http://localhost:7799', pull), 'http://localhost:7799/octo/widgets/pull/12');
  const commit = T.parsePullUrl('https://github.com/octo/widgets/pull/12/commits/abc1234');
  assert.equal(T.takeoverUrl('http://diffs', commit), 'http://diffs/octo/widgets/pull/12?commit=abc1234');
});

test('githubUrl marks a page to stay on GitHub, keeping its query and anchor', () => {
  assert.equal(T.githubUrl('https://github.com/octo/widgets/pull/12/files?w=1#r5'),
    'https://github.com/octo/widgets/pull/12/files?w=1&gh-arc=off#r5');
  assert.equal(T.parsePullUrl(T.githubUrl('https://github.com/octo/widgets/pull/12')).skip, true);
});

test('settings: on by default, off globally or per repository, case-insensitively', () => {
  const pull = T.parsePullUrl('https://github.com/Octo/Widgets/pull/1');
  const settings = T.withDefaults({});
  assert.equal(settings.server, 'http://localhost:7799');
  assert.equal(T.takesOver(settings, pull), true);
  assert.equal(T.takesOver({ ...settings, enabled: false }, pull), false);

  const off = { ...settings, disabledRepos: T.setRepo(settings, pull, false) };
  assert.deepEqual(off.disabledRepos, ['octo/widgets']);
  assert.equal(T.takesOver(off, T.parsePullUrl('https://github.com/octo/widgets/pull/2')), false);
  assert.equal(T.takesOver(off, T.parsePullUrl('https://github.com/octo/gadgets/pull/2')), true);
  assert.deepEqual(T.setRepo(off, pull, true), []);
  assert.deepEqual(T.withDefaults({ disabledRepos: 'nope', server: 'https://evil.example' }).disabledRepos, []);
  assert.equal(T.withDefaults({ server: 'https://evil.example' }).server, 'http://localhost:7799');
});

test('normalizeServer accepts only the loopback names gh-arc answers on', () => {
  assert.equal(T.normalizeServer('http://localhost:7799/'), 'http://localhost:7799');
  assert.equal(T.normalizeServer(' http://127.0.0.1:7800/diffs '), 'http://127.0.0.1:7800');
  assert.equal(T.normalizeServer('http://diffs'), 'http://diffs');
  ['https://localhost:7799', 'http://example.com', 'http://user:pw@localhost:7799', 'localhost:7799', '']
    .forEach((value) => assert.equal(T.normalizeServer(value), null, value));
});

test('the manifest asks only for storage, the loopback servers, and github.com pages', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../extension/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['http://localhost/*', 'http://127.0.0.1/*', 'http://diffs/*']);
  assert.deepEqual(manifest.content_scripts.map((script) => script.matches), [['https://github.com/*']]);
  assert.equal(manifest.version, require('../../package.json').version);
});

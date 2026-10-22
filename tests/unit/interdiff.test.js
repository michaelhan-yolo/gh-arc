'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeInterdiff, diffHunks, fullContextPatch, merge3, splitLines } = require('../../lib/interdiff');

function applyHunks(a, b, hunks) {
  const out = [];
  let at = 0;
  hunks.forEach((hunk) => {
    out.push(...a.slice(at, hunk.aStart), ...b.slice(hunk.bStart, hunk.bEnd));
    at = hunk.aEnd;
  });
  return out.concat(a.slice(at));
}

test('diffHunks finds the minimal edit and reconstructs the target', () => {
  assert.deepEqual(diffHunks(['a', 'b', 'c'], ['a', 'x', 'c']), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffHunks(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(diffHunks([], ['a']), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);

  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: Math.floor(random() * 40) }, () => String(Math.floor(random() * 6)));
    const b = Array.from({ length: Math.floor(random() * 40) }, () => String(Math.floor(random() * 6)));
    assert.deepEqual(applyHunks(a, b, diffHunks(a, b)), b, `round ${round}`);
  }
});

test('merge3 replays one side\'s changes onto the other side\'s base', () => {
  const base = ['1', '2', '3', '4', '5', '6'];
  const ours = ['1', 'TWO', '3', '4', '5', '6'];
  const theirs = ['1', '2', '3', '4', 'FIVE', '6', '7'];
  assert.deepEqual(merge3(base, ours, theirs), ['1', 'TWO', '3', '4', 'FIVE', '6', '7']);
  assert.deepEqual(merge3(base, ours, ours), ours);
  assert.equal(merge3(base, ['1', 'mine', '3', '4', '5', '6'], ['1', 'theirs', '3', '4', '5', '6']), null);
});

test('fullContextPatch writes one whole-file hunk with rename and /dev/null headers', () => {
  assert.equal(fullContextPatch('a.js', 'a.js', ['x', 'y'], ['x', 'z']), [
    'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,2 +1,2 @@', ' x', '-y', '+z', '',
  ].join('\n'));
  assert.equal(fullContextPatch('old.md', 'new.md', ['k'], ['k']), [
    'diff --git a/old.md b/new.md', 'rename from old.md', 'rename to new.md', '--- a/old.md', '+++ b/new.md', '',
  ].join('\n'));
  assert.match(fullContextPatch('n.js', 'n.js', null, ['a']), /--- \/dev\/null\n\+\+\+ b\/n\.js\n@@ -0,0 \+1,1 @@\n\+a\n$/);
  assert.equal(fullContextPatch('same.js', 'same.js', ['a'], ['a']), '');
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.equal(splitLines(null), null);
});

test('computeInterdiff leaves base changes out and flags files it could not separate', async () => {
  const contents = {
    'baseA:app.js': '1\n2\n3\n4\n5\n',
    'A:app.js': '1\nmine\n3\n4\n5\n',
    'baseB:app.js': '1\n2\n3\n4\nFIVE\n',
    'B:app.js': '1\nmine, revised\n3\n4\nFIVE\n',
    'baseA:clash.js': 'x\n',
    'A:clash.js': 'mine\n',
    'baseB:clash.js': 'theirs\n',
    'B:clash.js': 'mine again\n',
    'A:same.js': 'same\n',
    'B:same.js': 'same\n',
    'baseA:same.js': '',
    'baseB:same.js': '',
  };
  const compares = {
    A: { mergeBase: 'baseA', files: ['app.js', 'clash.js', 'same.js'].map((filename) => ({ filename, sha: `A-${filename}` })) },
    B: { mergeBase: 'baseB', files: ['app.js', 'clash.js', 'same.js'].map((filename) => ({ filename, sha: `B-${filename}` })) },
  };
  const result = await computeInterdiff({
    compare: async (base, head) => compares[head],
    content: async (ref, path) => (contents[`${ref}:${path}`] === undefined ? null : contents[`${ref}:${path}`]),
    base: 'tip',
    from: 'A',
    to: 'B',
  });
  assert.equal(result.baseMoved, true);
  assert.deepEqual(result.notes, { 'app.js': 'rebased', 'clash.js': 'mixed' });
  assert.match(result.patch, /-mine\n\+mine, revised\n/);
  assert.doesNotMatch(result.patch, /^[-+]FIVE$/m);
  assert.match(result.patch, /-mine\n\+mine again\n/);
  assert.doesNotMatch(result.patch, /same\.js/);
});

test('computeInterdiff marks changed images binary instead of diffing their bytes', async () => {
  const png = (tag) => `\x89PNG\r\n\x1a\n\0\0\0\rIHDR${tag}`;
  const contents = { 'A:logo.png': png('a'), 'B:logo.png': png('b'), 'B:new.png': png('n'), 'A:same.png': png('s'), 'B:same.png': png('s') };
  const files = (head, names) => names.map((filename) => ({ filename, sha: `${head}-${filename}` }));
  const compares = {
    A: { mergeBase: 'base', files: files('A', ['logo.png', 'same.png']) },
    B: { mergeBase: 'base', files: files('B', ['logo.png', 'new.png', 'same.png']) },
  };
  const result = await computeInterdiff({
    compare: async (base, head) => compares[head],
    content: async (ref, path) => (contents[`${ref}:${path}`] === undefined ? null : contents[`${ref}:${path}`]),
    base: 'tip',
    from: 'A',
    to: 'B',
  });
  assert.equal(result.patch, [
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    'diff --git a/new.png b/new.png',
    'new file mode 100644',
    'Binary files /dev/null and b/new.png differ',
    '',
  ].join('\n'));
});

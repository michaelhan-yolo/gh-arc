'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildStack, groupIntoStacks } = require('../../lib/stack');

const pr = (number, baseRefName, headRefName, owner = 'octo') => ({
  number,
  baseRefName,
  headRefName,
  headRepositoryOwner: { login: owner },
});

test('buildStack walks down to the trunk and up through children', () => {
  const open = [pr(1, 'main', 'a'), pr(2, 'a', 'b'), pr(3, 'b', 'c'), pr(9, 'main', 'other')];
  const stack = buildStack(open, open[1], 'octo');
  assert.equal(stack.trunk, 'main');
  assert.deepEqual(stack.entries.map((entry) => entry.number), [1, 2, 3]);
  assert.equal(stack.parent, 1);
  assert.deepEqual(stack.children, [3]);
  assert.ok(stack.entries.every((entry) => entry.lane === 0));
});

test('buildStack gives a branch-off child its own lane', () => {
  const open = [pr(1, 'main', 'a'), pr(2, 'a', 'b'), pr(4, 'a', 'b2'), pr(3, 'b', 'c')];
  const stack = buildStack(open, open[0], 'octo');
  assert.deepEqual(stack.entries.map((entry) => [entry.number, entry.lane, entry.parent]), [
    [1, 0, null],
    [2, 0, 1],
    [3, 0, 2],
    [4, 1, 1],
  ]);
  assert.deepEqual(stack.children, [2, 4]);
});

test('buildStack ignores branches from forks that share a name', () => {
  const open = [pr(1, 'main', 'a'), pr(2, 'a', 'b'), pr(5, 'b', 'c', 'someone-else')];
  const stack = buildStack(open, open[1], 'octo');
  assert.deepEqual(stack.entries.map((entry) => entry.number), [1, 2]);
});

test('buildStack includes a current pull request that is no longer open', () => {
  const open = [pr(1, 'main', 'a'), pr(3, 'b', 'c')];
  const merged = pr(2, 'a', 'b');
  const stack = buildStack(open, merged, 'octo');
  assert.deepEqual(stack.entries.map((entry) => entry.number), [1, 2, 3]);
});

test('buildStack stops on a branch cycle', () => {
  const open = [pr(1, 'b', 'a'), pr(2, 'a', 'b')];
  const stack = buildStack(open, open[0], 'octo');
  assert.deepEqual(stack.entries.map((entry) => entry.number).sort(), [1, 2]);
});

test('groupIntoStacks orders each stack top first and lanes only branches', () => {
  const inbox = (number, base, head, updatedAt) => ({
    ...pr(number, base, head),
    repository: { nameWithOwner: 'octo/widgets' },
    updatedAt,
  });
  const groups = groupIntoStacks([
    inbox(1, 'main', 'a', '2026-10-01'),
    inbox(2, 'a', 'b', '2026-10-02'),
    inbox(3, 'b', 'c', '2026-10-03'),
    inbox(4, 'a', 'b2', '2026-10-04'),
    inbox(9, 'main', 'solo', '2026-10-05'),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map((item) => item.pr.number), [9]);
  assert.equal(groups[1].trunk, 'main');
  assert.deepEqual(groups[1].items.map((item) => [item.pr.number, item.lane]), [[4, 1], [3, 0], [2, 0], [1, 0]]);
});

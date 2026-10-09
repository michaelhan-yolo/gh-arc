'use strict';

// A stack is the chain of pull requests whose base branch is another open pull request's head
// branch. Entries come back bottom first; `lane` is the column a branch-off child draws in.
function buildStack(openPrs, current, repoOwner) {
  const sameRepo = openPrs.filter((pr) =>
    pr.number === current.number ||
    !pr.headRepositoryOwner ||
    !repoOwner ||
    pr.headRepositoryOwner.login.toLowerCase() === repoOwner.toLowerCase());
  const prs = sameRepo.some((pr) => pr.number === current.number) ? sameRepo : sameRepo.concat(current);

  const byHead = new Map();
  const childrenByBase = new Map();
  prs.forEach((pr) => {
    if (!byHead.has(pr.headRefName)) {
      byHead.set(pr.headRefName, pr);
    }
    if (!childrenByBase.has(pr.baseRefName)) {
      childrenByBase.set(pr.baseRefName, []);
    }
    childrenByBase.get(pr.baseRefName).push(pr);
  });
  childrenByBase.forEach((list) => list.sort((a, b) => a.number - b.number));

  const visited = new Set([current.number]);
  const ancestors = [];
  let base = current.baseRefName;
  while (byHead.has(base) && !visited.has(byHead.get(base).number)) {
    const parent = byHead.get(base);
    visited.add(parent.number);
    ancestors.unshift(parent);
    base = parent.baseRefName;
  }

  const entries = ancestors.map((pr, index) => ({
    number: pr.number,
    parent: index ? ancestors[index - 1].number : null,
    lane: 0,
  }));
  entries.push({
    number: current.number,
    parent: ancestors.length ? ancestors[ancestors.length - 1].number : null,
    lane: 0,
  });

  let maxLane = 0;
  function visitChildren(pr, lane) {
    const children = (childrenByBase.get(pr.headRefName) || []).filter((child) => !visited.has(child.number));
    children.forEach((child, index) => {
      visited.add(child.number);
      const childLane = index === 0 ? lane : ++maxLane;
      entries.push({ number: child.number, parent: pr.number, lane: childLane });
      visitChildren(child, childLane);
    });
  }
  visitChildren(current, 0);

  return {
    trunk: base,
    entries,
    parent: entries.find((entry) => entry.number === current.number).parent,
    children: entries.filter((entry) => entry.parent === current.number).map((entry) => entry.number),
  };
}

// Groups a flat list of pull requests into stacks per repository, top of each stack first.
// `lane` is the column a branch-off child draws in; a linear stack stays in lane 0.
function groupIntoStacks(prs) {
  const byRepo = new Map();
  prs.forEach((pr) => {
    const repo = pr.repository.nameWithOwner;
    if (!byRepo.has(repo)) {
      byRepo.set(repo, []);
    }
    byRepo.get(repo).push(pr);
  });

  const groups = [];
  byRepo.forEach((list, repo) => {
    const byHead = new Map(list.map((pr) => [pr.headRefName, pr]));
    const childrenOf = new Map();
    const roots = [];
    list.forEach((pr) => {
      const parent = byHead.get(pr.baseRefName);
      if (parent && parent !== pr) {
        if (!childrenOf.has(parent.number)) {
          childrenOf.set(parent.number, []);
        }
        childrenOf.get(parent.number).push(pr);
      } else {
        roots.push(pr);
      }
    });

    const seen = new Set();
    let maxLane = 0;
    function walk(pr, lane, items) {
      if (seen.has(pr.number)) {
        return;
      }
      seen.add(pr.number);
      items.push({ pr, lane });
      (childrenOf.get(pr.number) || [])
        .sort((a, b) => a.number - b.number)
        .forEach((child, index) => walk(child, index === 0 ? lane : ++maxLane, items));
    }

    roots
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .concat(list)
      .forEach((root) => {
        const items = [];
        maxLane = 0;
        walk(root, 0, items);
        if (items.length) {
          groups.push({ repo, trunk: root.baseRefName, items: items.reverse() });
        }
      });
  });
  return groups;
}

module.exports = {
  buildStack,
  groupIntoStacks,
};

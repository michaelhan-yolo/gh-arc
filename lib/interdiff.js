'use strict';

// Compares two versions of a pull request the way Phabricator compares two diffs: version A's
// own changes are replayed onto version B's base (a three-way merge), so what the base gained
// in between, such as a lower pull request merged up the stack, drops out of the comparison.

const MAX_EDIT_DISTANCE = 4000;
const FETCH_CONCURRENCY = 16;

function splitLines(text) {
  if (text === null || text === undefined) {
    return null;
  }
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

// Myers' O(ND) diff; returns the [aIndex, bIndex] pairs of equal lines, or null past maxD.
function matchingLines(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) {
    return [];
  }
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) {
      return null;
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(trace, n, m);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return [];
}

function backtrack(trace, n, m) {
  const matches = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d - 1];
    const at = (k) => previous[k + d - 1];
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const snakeX = previousK === k + 1 ? previousX : previousX + 1;
    while (x > snakeX && y > snakeX - k) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = previousX;
    y = previousX - previousK;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([x, y]);
  }
  return matches.reverse();
}

// The regions where a and b differ: a[aStart, aEnd) became b[bStart, bEnd).
function diffHunks(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) {
    return [];
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const matches = matchingLines(middleA, middleB, MAX_EDIT_DISTANCE) || [];
  const hunks = [];
  let ai = 0;
  let bi = 0;
  matches.concat([[middleA.length, middleB.length]]).forEach(([x, y]) => {
    if (x > ai || y > bi) {
      hunks.push({ aStart: start + ai, aEnd: start + x, bStart: start + bi, bEnd: start + y });
    }
    ai = x + 1;
    bi = y + 1;
  });
  return hunks;
}

function sameLines(left, right) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

// Applies both sides' changes to base; null when they touch the same lines differently.
function merge3(base, ours, theirs) {
  const changes = diffHunks(base, ours)
    .map((hunk) => ({ start: hunk.aStart, end: hunk.aEnd, lines: ours.slice(hunk.bStart, hunk.bEnd), side: 'ours' }))
    .concat(diffHunks(base, theirs)
      .map((hunk) => ({ start: hunk.aStart, end: hunk.aEnd, lines: theirs.slice(hunk.bStart, hunk.bEnd), side: 'theirs' })))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const out = [];
  let cursor = 0;
  let index = 0;
  while (index < changes.length) {
    const group = [changes[index]];
    const groupStart = changes[index].start;
    let groupEnd = changes[index].end;
    index++;
    while (index < changes.length && changes[index].start <= groupEnd) {
      groupEnd = Math.max(groupEnd, changes[index].end);
      group.push(changes[index]);
      index++;
    }
    const apply = (side) => {
      const lines = [];
      let at = groupStart;
      group.filter((change) => change.side === side).forEach((change) => {
        lines.push(...base.slice(at, change.start), ...change.lines);
        at = change.end;
      });
      lines.push(...base.slice(at, groupEnd));
      return lines;
    };
    out.push(...base.slice(cursor, groupStart));
    const hasOurs = group.some((change) => change.side === 'ours');
    const hasTheirs = group.some((change) => change.side === 'theirs');
    if (hasOurs && hasTheirs) {
      const mine = apply('ours');
      if (!sameLines(mine, apply('theirs'))) {
        return null;
      }
      out.push(...mine);
    } else {
      out.push(...apply(hasOurs ? 'ours' : 'theirs'));
    }
    cursor = groupEnd;
  }
  out.push(...base.slice(cursor));
  return out;
}

function quotePath(prefix, filePath) {
  const value = `${prefix}/${filePath}`;
  if (!/["\\\t\n]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\n/g, '\\n')}"`;
}

// One whole-file hunk per file, so the viewer folds unchanged runs itself and needs no
// context from the server (the old side may be a merged text that exists in no commit).
function fullContextPatch(oldPath, newPath, oldLines, newLines) {
  const before = oldLines || [];
  const after = newLines || [];
  const hunks = diffHunks(before, after);
  if (!hunks.length && oldLines && newLines && oldPath === newPath) {
    return '';
  }
  const body = [];
  let ai = 0;
  hunks.forEach((hunk) => {
    for (; ai < hunk.aStart; ai++) {
      body.push(` ${before[ai]}`);
    }
    for (let ii = hunk.aStart; ii < hunk.aEnd; ii++) {
      body.push(`-${before[ii]}`);
    }
    for (let ii = hunk.bStart; ii < hunk.bEnd; ii++) {
      body.push(`+${after[ii]}`);
    }
    ai = hunk.aEnd;
  });
  for (; hunks.length && ai < before.length; ai++) {
    body.push(` ${before[ai]}`);
  }
  const header = [`diff --git ${quotePath('a', oldPath || newPath)} ${quotePath('b', newPath || oldPath)}`];
  if (oldLines && newLines && oldPath !== newPath) {
    header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }
  header.push(
    oldLines ? `--- ${quotePath('a', oldPath)}` : '--- /dev/null',
    newLines ? `+++ ${quotePath('b', newPath)}` : '+++ /dev/null');
  if (body.length) {
    header.push(`@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@`);
  }
  return `${header.concat(body).join('\n')}\n`;
}

// git's test: a NUL byte near the start means binary.
function isBinary(text) {
  return typeof text === 'string' && text.slice(0, 8000).includes('\0');
}

function binaryPatch(oldPath, newPath, hadOld, hasNew) {
  const header = [`diff --git ${quotePath('a', oldPath || newPath)} ${quotePath('b', newPath || oldPath)}`];
  if (!hadOld) {
    header.push('new file mode 100644');
  } else if (!hasNew) {
    header.push('deleted file mode 100644');
  } else if (oldPath !== newPath) {
    header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }
  header.push(`Binary files ${hadOld ? quotePath('a', oldPath) : '/dev/null'} and ${hasNew ? quotePath('b', newPath) : '/dev/null'} differ`);
  return `${header.join('\n')}\n`;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// Pairs each file across the two versions, following a rename made between them.
function pairFiles(olderFiles, newerFiles) {
  const pairs = newerFiles.map((file) => ({
    newPath: file.filename,
    newBasePath: file.previous_filename || file.filename,
    newer: file,
    older: null,
  }));
  olderFiles.forEach((file) => {
    const pair = pairs.find((item) => item.newPath === file.filename) ||
      pairs.find((item) => !item.older && item.newer && item.newer.previous_filename === file.filename);
    if (pair) {
      pair.older = file;
    } else {
      pairs.push({ newPath: file.filename, newBasePath: file.previous_filename || file.filename, newer: null, older: file });
    }
  });
  return pairs.map((pair) => {
    const oldPath = pair.older ? pair.older.filename : pair.newer.previous_filename || pair.newPath;
    return {
      ...pair,
      oldPath,
      oldBasePath: pair.older ? pair.older.previous_filename || pair.older.filename : oldPath,
    };
  });
}

// from and to are version commits; base is the base branch tip. compare(base, head) returns
// { mergeBase, files } as GitHub's compare does; content(ref, path) returns text or null.
async function computeInterdiff({ compare, content, base, from, to }) {
  const [older, newer] = await Promise.all([compare(base, from), compare(base, to)]);
  const baseMoved = older.mergeBase !== newer.mergeBase;
  const notes = {};
  const patches = await mapLimit(pairFiles(older.files, newer.files), FETCH_CONCURRENCY, async (pair) => {
    const sameBlob = pair.older && pair.newer && pair.older.sha && pair.older.sha === pair.newer.sha;
    if (sameBlob && !baseMoved && pair.oldPath === pair.newPath) {
      return '';
    }
    const [olderText, newerText] = await Promise.all([content(from, pair.oldPath), content(to, pair.newPath)]);
    if (isBinary(olderText) || isBinary(newerText)) {
      return olderText === newerText && pair.oldPath === pair.newPath
        ? ''
        : binaryPatch(pair.oldPath, pair.newPath, olderText !== null, newerText !== null);
    }
    let oldLines = splitLines(olderText);
    const newLines = splitLines(newerText);
    if (baseMoved) {
      const [olderBase, newerBase] = await Promise.all([
        content(older.mergeBase, pair.oldBasePath),
        content(newer.mergeBase, pair.newBasePath),
      ]);
      if (olderBase !== newerBase) {
        const rebased = merge3(splitLines(olderBase) || [], oldLines || [], splitLines(newerBase) || []);
        if (rebased) {
          oldLines = rebased.length || oldLines ? rebased : null;
          notes[pair.newPath] = 'rebased';
        } else {
          notes[pair.newPath] = 'mixed';
        }
      }
    }
    if (!oldLines && !newLines) {
      return '';
    }
    const patch = fullContextPatch(pair.oldPath, pair.newPath, oldLines, newLines);
    if (!patch) {
      delete notes[pair.newPath];
    }
    return patch;
  });
  return {
    patch: patches.join(''),
    notes,
    baseMoved,
    oldBase: older.mergeBase,
    newBase: newer.mergeBase,
  };
}

module.exports = {
  computeInterdiff,
  diffHunks,
  fullContextPatch,
  matchingLines,
  merge3,
  pairFiles,
  splitLines,
};

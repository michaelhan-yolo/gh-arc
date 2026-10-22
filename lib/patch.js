'use strict';

const { applyHeaderLine, parseDiffGitLine } = require('../web/patch-paths');

// Paths the viewer uses: a file's old path on the LEFT side and its new path on the RIGHT.
// GitHub anchors every review thread to the file's current path, whichever side it is on.

function parsePatchFiles(patchText) {
  const files = [];
  let file = null;
  let inHunk = false;
  String(patchText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').forEach((line) => {
    if (line.startsWith('diff --git ')) {
      file = parseDiffGitLine(line);
      files.push(file);
      inHunk = false;
      return;
    }
    if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (file && !inHunk) {
      applyHeaderLine(file, line);
    }
  });
  return files;
}

function githubPathFor(files, side, viewerPath) {
  const file = files.find((item) =>
    (side === 'old' ? item.oldPath || item.newPath : item.newPath || item.oldPath) === viewerPath);
  return file ? file.newPath || file.oldPath : viewerPath;
}

function viewerPathFor(files, side, githubPath) {
  if (side !== 'old') {
    return githubPath;
  }
  const file = files.find((item) => (item.newPath || item.oldPath) === githubPath);
  return file ? file.oldPath || file.newPath : githubPath;
}

// Rebuilds a unified diff from the pull request files API, for diffs too large for the diff endpoint.
function patchFromFiles(files) {
  return files.map((file) => {
    const oldPath = file.previous_filename || file.filename;
    const newPath = file.filename;
    const header = [`diff --git a/${oldPath} b/${newPath}`];
    if (file.status === 'renamed') {
      header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
    } else if (file.status === 'added') {
      header.push('new file mode 100644');
    } else if (file.status === 'removed') {
      header.push('deleted file mode 100644');
    }
    if (!file.patch) {
      header.push(file.status === 'removed' || file.status === 'added' || file.changes
        ? `Binary files or large diff not shown (${file.changes} changes)`
        : 'No textual changes');
      return `${header.join('\n')}\n`;
    }
    header.push(
      file.status === 'added' ? '--- /dev/null' : `--- a/${oldPath}`,
      file.status === 'removed' ? '+++ /dev/null' : `+++ b/${newPath}`);
    return `${header.join('\n')}\n${file.patch.replace(/\n?$/, '\n')}`;
  }).join('');
}

module.exports = {
  githubPathFor,
  parsePatchFiles,
  patchFromFiles,
  viewerPathFor,
};

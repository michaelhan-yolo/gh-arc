'use strict';

// Reads file paths out of git patch headers. Loaded by the server (require) and the page (script tag).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GhArcPatchPaths = factory();
  }
}(typeof self !== 'undefined' ? self : this, () => {
  const ESCAPES = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };

  // git C-quotes paths with special characters, writing non-ASCII bytes as octal escapes.
  function unquoteGitPath(value) {
    if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
      return value;
    }
    const encoder = new TextEncoder();
    const bytes = [];
    const body = value.slice(1, -1);
    for (let ii = 0; ii < body.length; ii++) {
      const ch = body[ii];
      const next = body[ii + 1];
      if (ch === '\\' && next !== undefined) {
        const octal = body.slice(ii + 1).match(/^[0-7]{1,3}/);
        if (octal) {
          bytes.push(parseInt(octal[0], 8));
          ii += octal[0].length;
          continue;
        }
        if (ESCAPES[next] !== undefined) {
          bytes.push(ESCAPES[next]);
          ii += 1;
          continue;
        }
      }
      bytes.push(...encoder.encode(ch));
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  function cleanPatchPath(value) {
    if (!value) {
      return null;
    }
    const trimmed = value.replace(/\t.*$/, '').trim();
    if (trimmed === '/dev/null') {
      return null;
    }
    return unquoteGitPath(trimmed).replace(/^[ab]\//, '');
  }

  // "diff --git a/x b/y": quoted halves split on their quotes; an unquoted line with spaces
  // splits where both halves name the same path, else at the first " b/".
  function parseDiffGitLine(line) {
    const raw = line.slice('diff --git '.length).trim();
    let parts;
    if (raw.startsWith('"') || raw.endsWith('"')) {
      parts = raw.match(/"(?:[^"\\]|\\.)*"|\S+/g) || [];
    } else {
      const half = (raw.length - 5) / 2;
      if (Number.isInteger(half) && raw.startsWith('a/') && raw.slice(2, 2 + half) === raw.slice(5 + half) &&
          raw.slice(2 + half, 5 + half) === ' b/') {
        parts = [raw.slice(0, 2 + half), raw.slice(3 + half)];
      } else {
        const split = raw.indexOf(' b/');
        parts = split === -1 ? raw.split(' ') : [raw.slice(0, split), raw.slice(split + 1)];
      }
    }
    return {
      oldPath: cleanPatchPath(parts[0] || ''),
      newPath: cleanPatchPath(parts[parts.length - 1] || ''),
    };
  }

  // Applies one file-header line ("--- a/x", "rename to y", ...) to a file's paths.
  function applyHeaderLine(file, line) {
    if (line.startsWith('--- ')) {
      file.oldPath = cleanPatchPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      file.newPath = cleanPatchPath(line.slice(4));
    } else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      file.oldPath = unquoteGitPath(line.slice(line.indexOf(' from ') + 6));
    } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      file.newPath = unquoteGitPath(line.slice(line.indexOf(' to ') + 4));
    } else if (line.startsWith('new file mode ')) {
      // A binary file has no ---/+++ lines to say it was added or deleted.
      file.oldPath = null;
    } else if (line.startsWith('deleted file mode ')) {
      file.newPath = null;
    } else {
      return false;
    }
    return true;
  }

  return {
    applyHeaderLine,
    cleanPatchPath,
    parseDiffGitLine,
    unquoteGitPath,
  };
}));

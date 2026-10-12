'use strict';

// The app's page paths. Loaded by the server and CLI (require) and the pages (script tag).
// A pull request in the home repository lives at /diffs/<number>; any other at
// /diffs/<owner>/<repo>/<number>. Under the alias host that gh arc setup installs, the host
// already says "diffs", so the paths drop it: http://diffs/<number>. GitHub's own
// /<owner>/<repo>/pull/<number> shape redirects.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GhArcRoutes = factory();
  }
}(typeof self !== 'undefined' ? self : this, () => {
  const ALIAS_HOST = 'diffs';
  const NAME = '[A-Za-z0-9_.-]+';
  const DIFF_PATH = new RegExp(`^/diffs/(?:(${NAME})/(${NAME})/)?(\\d+)/?$`);
  const SHORT_PATH = new RegExp(`^/(?!(?:diffs|api|assets)/)(?:(${NAME})/(${NAME})/)?(\\d+)/?$`);
  const GITHUB_PATH = new RegExp(`^/(${NAME})/(${NAME})/pull/(\\d+)(?:/(?:files|commits|checks))?/?$`);
  const GITHUB_URL = new RegExp(`github\\.com/(${NAME})/(${NAME})/pull/(\\d+)`);
  const SHORT_REF = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);

  function sameRepo(left, right) {
    return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
  }

  // Short paths drop the /diffs prefix, for pages served under the alias host.
  function diffPath(repo, number, homeRepo, short) {
    const prefix = short ? '' : '/diffs';
    return sameRepo(repo, homeRepo) ? `${prefix}/${number}` : `${prefix}/${repo}/${number}`;
  }

  function isAliasHost(hostname) {
    return String(hostname).split(':')[0].toLowerCase() === ALIAS_HOST;
  }

  // { repo, number } for a page path, with or without /diffs, or null; a bare number needs a
  // home repository.
  function parseDiffPath(pathname, homeRepo) {
    const match = String(pathname).match(DIFF_PATH) || String(pathname).match(SHORT_PATH);
    if (!match) {
      return null;
    }
    const repo = match[1] ? `${match[1]}/${match[2]}` : homeRepo;
    return repo ? { repo, number: Number(match[3]) } : null;
  }

  function parseGitHubPath(pathname) {
    const match = String(pathname).match(GITHUB_PATH);
    return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
  }

  // A pull request URL or owner/repo#123, as { repo, number }, or null.
  function parseReference(value) {
    const text = String(value).trim();
    const match = text.match(GITHUB_URL) || text.match(SHORT_REF);
    return match ? { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
  }

  return {
    ALIAS_HOST,
    diffPath,
    isAliasHost,
    parseDiffPath,
    parseGitHubPath,
    parseReference,
  };
}));

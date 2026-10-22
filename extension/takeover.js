'use strict';

// Which github.com pages the extension hands to gh-arc, and where they go. Loaded by the
// content script, the service worker and the popup, and by the unit tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GhArcTakeover = factory();
  }
}(typeof self !== 'undefined' ? self : this, () => {
  const DEFAULT_SERVER = 'http://localhost:7799';
  const DEFAULTS = { enabled: true, disabledRepos: [], server: DEFAULT_SERVER };
  // A pull request and its tabs; a commit inside the Commits or Files tab opens that commit.
  const PULL_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\/(files|changes|commits|checks)(?:\/([0-9a-f]{7,40}))?)?\/?$/i;
  // Links carrying this parameter show GitHub's own page; gh-arc's links back to GitHub use it.
  const SKIP_PARAM = 'gh-arc';
  const SKIP_VALUE = 'off';
  const SERVER_HOSTS = ['localhost', '127.0.0.1', 'diffs'];

  // { owner, repo, number, commit, skip } for a github.com pull request page, or null.
  function parsePullUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
      return null;
    }
    const match = url.pathname.match(PULL_PATH);
    if (!match) {
      return null;
    }
    return {
      owner: match[1],
      repo: match[2],
      number: Number(match[3]),
      commit: match[4] && match[4].toLowerCase() !== 'checks' && match[5] ? match[5].toLowerCase() : null,
      skip: url.searchParams.get(SKIP_PARAM) === SKIP_VALUE,
    };
  }

  function repoKey(pull) {
    return `${pull.owner}/${pull.repo}`.toLowerCase();
  }

  function pullKey(pull) {
    return `${repoKey(pull)}#${pull.number}`;
  }

  // The gh-arc address for a pull request; the server's GitHub-shaped route redirects it to the
  // pull request's own page.
  function takeoverUrl(base, pull) {
    const query = pull.commit ? `?commit=${pull.commit}` : '';
    return `${base}/${pull.owner}/${pull.repo}/pull/${pull.number}${query}`;
  }

  // The same GitHub page, marked to stay on GitHub.
  function githubUrl(href) {
    const url = new URL(href);
    url.searchParams.set(SKIP_PARAM, SKIP_VALUE);
    return url.toString();
  }

  function withDefaults(stored) {
    const settings = { ...DEFAULTS, ...(stored || {}) };
    settings.disabledRepos = Array.isArray(settings.disabledRepos) ? settings.disabledRepos : [];
    settings.server = normalizeServer(settings.server) || DEFAULT_SERVER;
    return settings;
  }

  function takesOver(settings, pull) {
    return Boolean(settings.enabled) && !settings.disabledRepos.includes(repoKey(pull));
  }

  function setRepo(settings, pull, on) {
    const others = settings.disabledRepos.filter((key) => key !== repoKey(pull));
    return on ? others : [...others, repoKey(pull)];
  }

  // The server as an origin, or null: only the loopback names gh-arc answers on, over http.
  function normalizeServer(value) {
    let url;
    try {
      url = new URL(String(value || '').trim());
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'http:' || !SERVER_HOSTS.includes(url.hostname) || url.username || url.password) {
      return null;
    }
    return url.origin;
  }

  return {
    DEFAULT_SERVER,
    DEFAULTS,
    SKIP_PARAM,
    SKIP_VALUE,
    githubUrl,
    normalizeServer,
    parsePullUrl,
    pullKey,
    repoKey,
    setRepo,
    takeoverUrl,
    takesOver,
    withDefaults,
  };
}));

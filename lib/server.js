'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const gh = require('./github');
const draftStore = require('./drafts');
const { computeInterdiff } = require('./interdiff');
const normalize = require('./normalize');
const { parsePatchFiles, patchFromFiles } = require('./patch');
const routes = require('../web/routes');
const { submitDrafts } = require('./review');
const { buildStack, groupIntoStacks } = require('./stack');

const APP = 'gh-arc';
const VERSION = require('../package.json').version;
const ROOT_DIR = path.join(__dirname, '..');
const WEB_DIR = path.join(ROOT_DIR, 'web');
const BUILD = buildId();
const SHA = /^[0-9a-f]{7,40}$/i;
const NAME = '[A-Za-z0-9_.-]+';
const API_ROUTE = new RegExp(`^/api/pr/(${NAME})/(${NAME})/(\\d+)/([a-z]+)$`);
const FRESH_MS = 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const PATCH_TTL_MS = 30 * 1000;
const CONTENT_CACHE_LIMIT = 400;

const STATIC = {
  '/assets/viewer.js': ['viewer.js', 'application/javascript; charset=utf-8'],
  '/assets/home.js': ['home.js', 'application/javascript; charset=utf-8'],
  '/assets/common.js': ['common.js', 'application/javascript; charset=utf-8'],
  '/assets/patch-paths.js': ['patch-paths.js', 'application/javascript; charset=utf-8'],
  '/assets/routes.js': ['routes.js', 'application/javascript; charset=utf-8'],
  '/assets/viewer.css': ['viewer.css', 'text/css; charset=utf-8'],
  '/assets/icon.svg': ['icon.svg', 'image/svg+xml'],
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  'media-src https:',
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// options.homeRepo ("owner/repo") is the repository whose pull requests live at /diffs/<number>.
function createServer(options = {}) {
  const sessionToken = options.sessionToken || crypto.randomBytes(24).toString('hex');
  const homeRepo = options.homeRepo || null;
  let forwardPort = null;
  const openPrsCache = new Map();
  const inboxCache = new Map();
  const patchCache = new Map();
  const contentCache = new Map();
  const compareCache = new Map();
  const commitParentCache = new Map();
  const interdiffCache = new Map();
  const prIds = new Map();
  let port = null;

  const respond = (req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  };
  const server = http.createServer(respond);
  const forwardServer = http.createServer(respond);

  async function handle(req, res) {
    if (!allowedHost(req.headers.host)) {
      throw new HttpError(403, 'gh-arc only answers on 127.0.0.1 and localhost.');
    }
    if (req.method === 'POST') {
      checkMutation(req);
    } else if (req.method !== 'GET') {
      throw new HttpError(405, 'Method Not Allowed');
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/api/ping') {
      return sendJson(res, { app: APP, version: VERSION, build: BUILD, homeRepo, forwardPort });
    }
    if (STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return send(res, 200, type, fs.readFileSync(path.join(WEB_DIR, file)));
    }
    if (pathname === '/' || pathname === '/index.html') {
      return servePage(res, 'home.html');
    }
    if (pathname === '/diffs' || pathname === '/diffs/') {
      return redirect(res, '/');
    }
    if (routes.parseDiffPath(pathname, homeRepo)) {
      return servePage(res, 'pr.html');
    }
    if (/^(\/diffs)?\/\d+\/?$/.test(pathname)) {
      throw new HttpError(404, 'No home repository is set, so open it as /diffs/<owner>/<repo>/<number>.');
    }
    const github = routes.parseGitHubPath(pathname);
    if (github) {
      const short = routes.isAliasHost(req.headers.host);
      return redirect(res, `${routes.diffPath(github.repo, github.number, homeRepo, short)}${url.search}`);
    }
    if (pathname === '/api/inbox') {
      return sendJson(res, await inbox());
    }
    const api = pathname.match(API_ROUTE);
    if (api) {
      const [, owner, repo, number, action] = api;
      return sendJson(res, await prApi(req, owner, repo, Number(number), action, url.searchParams));
    }
    throw new HttpError(404, 'Not Found');
  }

  // The loopback names, plus the alias gh arc setup points at 127.0.0.1 (port 80 forwards here).
  function allowedHosts() {
    return [`127.0.0.1:${port}`, `localhost:${port}`, routes.ALIAS_HOST, `${routes.ALIAS_HOST}:${port}`];
  }

  function allowedHost(host) {
    return allowedHosts().includes(String(host || '').toLowerCase());
  }

  function checkMutation(req) {
    const origin = req.headers.origin;
    if (origin && !allowedHosts().some((host) => origin === `http://${host}`)) {
      throw new HttpError(403, 'Cross-origin requests are not allowed.');
    }
    const header = Buffer.from(String(req.headers['x-gh-arc-token'] || ''));
    const expected = Buffer.from(sessionToken);
    if (header.length !== expected.length || !crypto.timingSafeEqual(header, expected)) {
      throw new HttpError(403, 'Missing or stale page token. Reload the page.');
    }
  }

  function servePage(res, file) {
    const html = fs.readFileSync(path.join(WEB_DIR, file), 'utf8')
      .replace('__GH_ARC_TOKEN__', sessionToken)
      .replace('__GH_ARC_HOME_REPO__', homeRepo || '');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  }

  function inbox() {
    return staleWhileRevalidate(inboxCache, 'inbox', loadInbox);
  }

  async function loadInbox() {
    const data = await gh.fetchInbox();
    const sections = [
      ['needsReview', 'Needs your review'],
      ['mine', 'Your pull requests'],
      ['reviewed', 'Reviewed by you'],
    ];
    return {
      viewer: data.viewer.login,
      sections: sections.map(([key, title]) => ({
        key,
        title,
        groups: groupIntoStacks(data[key].nodes.filter((node) => node && node.number).map(normalize.normalizeInboxPr)),
      })),
    };
  }

  async function prApi(req, owner, repo, number, action, params) {
    const key = `${owner}/${repo}#${number}`;
    const method = req.method;

    if (action === 'pr' && method === 'GET') {
      prewarm(owner, repo);
      const [data, viewedFiles] = await Promise.all([
        gh.fetchPullRequest(owner, repo, number),
        gh.fetchFileViewedStates(owner, repo, number).catch(() => []),
      ]);
      prIds.set(key, data.repository.pullRequest.id);
      return normalize.normalizePullRequest(data, owner, repo, viewedFiles);
    }

    if (action === 'patch' && method === 'GET') {
      return patchForRange(owner, repo, number, params);
    }

    if (action === 'threads' && method === 'GET') {
      const [threads, patch] = await Promise.all([
        gh.fetchReviewThreads(owner, repo, number),
        prPatch(owner, repo, number),
      ]);
      return {
        threads: threads.map((thread) => normalize.normalizeThread(thread, patch.files)),
        drafts: draftStore.readDrafts(owner, repo, number),
      };
    }

    if (action === 'stack' && method === 'GET') {
      return stack(owner, repo, number);
    }

    if (action === 'context' && method === 'GET') {
      return context(owner, repo, params);
    }

    if (action === 'drafts') {
      if (method === 'GET') {
        return draftStore.readDrafts(owner, repo, number);
      }
      const payload = await readJsonBody(req);
      let next;
      try {
        next = draftStore.applyDraftChange(draftStore.readDrafts(owner, repo, number), payload);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      return draftStore.writeDrafts(owner, repo, number, next);
    }

    if (action === 'submit' && method === 'POST') {
      return submit(owner, repo, number, await readJsonBody(req));
    }

    if (action === 'resolve' && method === 'POST') {
      const payload = await readJsonBody(req);
      if (typeof payload.threadId !== 'string' || !payload.threadId) {
        throw new HttpError(400, 'threadId is required.');
      }
      return gh.setThreadResolved(payload.threadId, Boolean(payload.resolved));
    }

    if (action === 'merge' && method === 'POST') {
      return merge(owner, repo, number, await readJsonBody(req));
    }

    if (action === 'retarget' && method === 'POST') {
      return retarget(owner, repo, number);
    }

    if (action === 'viewed' && method === 'POST') {
      const payload = await readJsonBody(req);
      if (typeof payload.path !== 'string' || !payload.path) {
        throw new HttpError(400, 'path is required.');
      }
      await gh.setFileViewed(await prId(owner, repo, number), payload.path, Boolean(payload.viewed));
      return { path: payload.path, viewed: Boolean(payload.viewed) };
    }

    throw new HttpError(404, `Unknown action "${action}".`);
  }

  async function prId(owner, repo, number) {
    const key = `${owner}/${repo}#${number}`;
    if (!prIds.has(key)) {
      const [summary] = await gh.fetchPullRequestSummaries(owner, repo, [number]);
      prIds.set(key, summary.id);
    }
    return prIds.get(key);
  }

  function prPatch(owner, repo, number, fresh) {
    const key = `${owner}/${repo}#${number}`;
    const cached = patchCache.get(key);
    if (cached && !fresh && Date.now() - cached.at < PATCH_TTL_MS) {
      return cached.promise;
    }
    const promise = gh.fetchPullRequestDiff(owner, repo, number)
      .catch((err) => {
        if (![406, 422, 500, 502, 503].includes(err.status)) {
          throw err;
        }
        return gh.fetchPullRequestFiles(owner, repo, number).then(patchFromFiles);
      })
      .then((text) => ({ text, files: parsePatchFiles(text) }));
    patchCache.set(key, { at: Date.now(), promise });
    promise.catch(() => patchCache.delete(key));
    return promise;
  }

  async function patchForRange(owner, repo, number, params) {
    const commit = params.get('commit');
    const diff = params.get('diff');
    if (commit) {
      requireSha(commit);
      const parent = await commitParent(owner, repo, commit);
      if (!parent) {
        throw new HttpError(422, 'That commit has no parent to compare against.');
      }
      const text = await gh.fetchCompareDiff(owner, repo, parent, commit);
      return { patch: text, oldRef: parent, newRef: commit };
    }
    if (diff) {
      const [from, to] = diff.split('..');
      requireSha(to);
      const [summary] = await gh.fetchPullRequestSummaries(owner, repo, [number]);
      const base = summary.baseRefOid;
      if (from === 'base') {
        const [text, oldRef] = await Promise.all([
          gh.fetchCompareDiff(owner, repo, base, to),
          mergeBase(owner, repo, base, to),
        ]);
        return { patch: text, oldRef, newRef: to };
      }
      requireSha(from);
      const result = await interdiff(owner, repo, base, from, to);
      return { patch: result.patch, oldRef: null, newRef: to, fullContext: true, notes: result.notes, baseMoved: result.baseMoved };
    }
    const patch = await prPatch(owner, repo, number);
    return { patch: patch.text, oldRef: null, newRef: null };
  }

  function interdiff(owner, repo, base, from, to) {
    const key = `${owner}/${repo}@${base}:${from}..${to}`;
    return remember(interdiffCache, key, () => computeInterdiff({
      compare: (left, right) => compare(owner, repo, left, right),
      content: (ref, filePath) => fileText(owner, repo, filePath, ref),
      base,
      from,
      to,
    }));
  }

  function compare(owner, repo, base, head) {
    return remember(compareCache, `${owner}/${repo}@${base}...${head}`, () => gh.fetchCompare(owner, repo, base, head));
  }

  function commitParent(owner, repo, sha) {
    return remember(commitParentCache, `${owner}/${repo}@${sha}`, () => gh.fetchCommitParent(owner, repo, sha));
  }

  async function stack(owner, repo, number) {
    const [[current], openPrs] = await Promise.all([
      gh.fetchPullRequestSummaries(owner, repo, [number]),
      openPullRequests(owner, repo),
    ]);
    if (!current) {
      throw new HttpError(404, `Pull request ${owner}/${repo}#${number} was not found.`);
    }
    const shape = buildStack(openPrs, current, owner);
    const others = shape.entries.map((entry) => entry.number).filter((value) => value !== number);
    const summaries = new Map([[number, current]]);
    (await gh.fetchPullRequestSummaries(owner, repo, others)).forEach((summary) => {
      summaries.set(summary.number, summary);
    });
    return {
      current: number,
      trunk: shape.trunk,
      parent: shape.parent,
      children: shape.children,
      entries: shape.entries
        .filter((entry) => summaries.has(entry.number))
        .map((entry) => normalize.normalizeStackEntry(summaries.get(entry.number), entry)),
    };
  }

  function openPullRequests(owner, repo) {
    return staleWhileRevalidate(openPrsCache, `${owner}/${repo}`, () => gh.fetchOpenPullRequests(owner, repo));
  }

  function prewarm(owner, repo) {
    openPullRequests(owner, repo).catch(() => {});
    inbox().catch(() => {});
  }

  async function context(owner, repo, params) {
    const oldPath = params.get('oldPath') || params.get('newPath') || '';
    const newPath = params.get('newPath') || params.get('oldPath') || '';
    const newRef = params.get('newRef') || params.get('head');
    requireSha(newRef);
    let oldRef = params.get('oldRef');
    if (oldRef) {
      requireSha(oldRef);
    } else {
      const base = params.get('base');
      requireSha(base);
      oldRef = await mergeBase(owner, repo, base, newRef);
    }
    const oldRange = range(params.get('oldFrom'), params.get('oldTo'));
    const newRange = range(params.get('newFrom'), params.get('newTo'));
    const [oldLines, newLines] = await Promise.all([
      oldRange ? fileLines(owner, repo, oldPath, oldRef) : null,
      newRange ? fileLines(owner, repo, newPath, newRef) : null,
    ]);
    return {
      old: slice(oldLines, oldRange),
      new: slice(newLines, newRange),
    };
  }

  async function mergeBase(owner, repo, base, head) {
    return (await compare(owner, repo, base, head)).mergeBase;
  }

  function fileText(owner, repo, filePath, ref) {
    if (!filePath || filePath.split('/').includes('..')) {
      return Promise.resolve(null);
    }
    return remember(contentCache, `${owner}/${repo}@${ref}:${filePath}`,
      () => gh.fetchFileContent(owner, repo, filePath, ref), CONTENT_CACHE_LIMIT);
  }

  async function fileLines(owner, repo, filePath, ref) {
    const text = await fileText(owner, repo, filePath, ref);
    return text === null ? null : text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  }

  // Ships one pull request into the default branch, as the page showed it: GitHub refuses if the
  // head moved since. A stack ships bottom first, one call per pull request (see retarget).
  async function merge(owner, repo, number, payload) {
    if (!['MERGE', 'SQUASH', 'REBASE'].includes(payload.method)) {
      throw new HttpError(400, 'Pick a merge method: MERGE, SQUASH or REBASE.');
    }
    requireSha(payload.expectedHeadOid);
    const { defaultBranch, pr } = await gh.fetchShipInfo(owner, repo, number);
    if (pr.merged) {
      return { merged: true, already: true };
    }
    if (pr.baseRefName !== defaultBranch) {
      throw new HttpError(409, `#${number} merges into ${pr.baseRefName}, not ${defaultBranch}. Ship the pull request below it first.`);
    }
    const shipped = await withRetries(() => gh.mergePullRequest({
      pullRequestId: pr.id,
      mergeMethod: payload.method,
      expectedHeadOid: payload.expectedHeadOid,
    }));
    let deletedBranch = null;
    const sameRepo = !pr.headRepositoryOwner || pr.headRepositoryOwner.login.toLowerCase() === owner.toLowerCase();
    if (payload.deleteBranch && sameRepo) {
      await gh.deleteBranch(owner, repo, pr.headRefName);
      deletedBranch = pr.headRefName;
    }
    openPrsCache.delete(`${owner}/${repo}`);
    inboxCache.clear();
    return { merged: shipped.merged, url: shipped.url, deletedBranch };
  }

  // Moves a pull request onto the default branch once the pull request it sat on has merged.
  // Refusing otherwise keeps a stack from carrying unmerged work into the default branch.
  async function retarget(owner, repo, number) {
    const { defaultBranch, pr } = await gh.fetchShipInfo(owner, repo, number);
    if (pr.baseRefName === defaultBranch) {
      return { baseRefName: defaultBranch, moved: false };
    }
    const below = await gh.fetchMergedPullRequestForHead(owner, repo, pr.baseRefName);
    if (!below) {
      throw new HttpError(409, `#${number} sits on ${pr.baseRefName}, and no merged pull request ships that branch. Ship the one below it first.`);
    }
    await gh.updatePullRequestBase(pr.id, defaultBranch);
    openPrsCache.delete(`${owner}/${repo}`);
    return { baseRefName: defaultBranch, moved: true, below };
  }

  async function submit(owner, repo, number, payload) {
    const event = draftStore.EVENTS.includes(payload.event) ? payload.event : 'COMMENT';
    const body = typeof payload.body === 'string' ? payload.body : '';
    const [data, patch] = await Promise.all([
      gh.fetchPullRequest(owner, repo, number),
      prPatch(owner, repo, number, true),
    ]);
    const pr = data.repository.pullRequest;
    const viewerLogin = data.viewer.login;
    if (event !== 'COMMENT' && pr.author && pr.author.login === viewerLogin) {
      throw new HttpError(400, "You can't accept or block your own pull request; post your comments instead.");
    }
    const store = draftStore.readDrafts(owner, repo, number);
    const pending = pr.pendingReviews.nodes.find((review) => review.author && review.author.login === viewerLogin);
    const hasInline = store.threads.length || store.replies.length || (pending && pending.comments.totalCount);
    if (event === 'COMMENT' && !body.trim() && !hasInline) {
      throw new HttpError(400, 'Write a comment or add an inline comment before submitting.');
    }

    const result = await submitDrafts({
      gh,
      pr: { id: pr.id, headRefOid: pr.headRefOid, pendingReviews: pr.pendingReviews.nodes },
      viewerLogin,
      drafts: store,
      files: patch.files,
      event,
      body,
    });

    const posted = new Set(result.posted);
    const errors = new Map(result.failures.map((failure) => [failure.id, failure.message]));
    const withError = (draft) => (errors.has(draft.id) ? { ...draft, error: errors.get(draft.id) } : draft);
    const remaining = {
      ...store,
      threads: store.threads.filter((draft) => !posted.has(draft.id)).map(withError),
      replies: store.replies.filter((draft) => !posted.has(draft.id)).map(withError),
      body: result.submitted ? '' : body,
      event: result.submitted ? 'COMMENT' : event,
    };
    draftStore.writeDrafts(owner, repo, number, remaining);
    return { ...result, drafts: remaining };
  }

  function listen(requestedPort = 7799, host = '127.0.0.1', strictPort = false) {
    return new Promise((resolve, reject) => {
      let attempt = requestedPort;
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && !strictPort && attempt < requestedPort + 20) {
          attempt++;
          server.listen(attempt, host);
          return;
        }
        reject(err);
      });
      server.on('listening', () => {
        port = server.address().port;
        resolve(port);
      });
      server.listen(attempt, host);
    });
  }

  // The port gh arc setup's pf rule forwards port 80 to; null when something else holds it.
  function listenForward(requestedPort) {
    return new Promise((resolve) => {
      forwardServer.once('error', () => resolve(null));
      forwardServer.listen(requestedPort, '127.0.0.1', () => {
        forwardPort = requestedPort;
        resolve(requestedPort);
      });
    });
  }

  return {
    server,
    sessionToken,
    homeRepo,
    listen,
    listenForward,
    prewarm,
    get port() {
      return port;
    },
    // server.close alone waits on the spare sockets browsers keep open without sending a request.
    close: () => Promise.all([server, forwardPort ? forwardServer : null].filter(Boolean).map((each) => (
      new Promise((resolve) => {
        each.close(resolve);
        each.closeAllConnections();
      })
    ))),
  };
}

// Fingerprints the code a server runs, so the CLI reuses only a server running this same code.
function buildId() {
  const hash = crypto.createHash('sha1');
  ['lib', 'web'].forEach((dir) => {
    fs.readdirSync(path.join(ROOT_DIR, dir)).sort().forEach((file) => {
      hash.update(file).update(fs.readFileSync(path.join(ROOT_DIR, dir, file)));
    });
  });
  return hash.digest('hex').slice(0, 12);
}

// Right after a pull request moves onto a new base, GitHub may still be recomputing whether it
// can merge and refuse for a moment; those refusals get a few more tries.
async function withRetries(attempt, tries = 5, waitMs = 1500) {
  for (let ii = 1; ; ii++) {
    try {
      return await attempt();
    } catch (err) {
      const transient = /base branch was modified|not mergeable|mergeability/i.test(err.message);
      if (!transient || ii >= tries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Serves the last answer while a refresh runs, so only the first request waits on GitHub.
function staleWhileRevalidate(cache, key, load) {
  const cached = cache.get(key);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && (age < FRESH_MS || cached.refreshing)) {
    return cached.promise;
  }
  const promise = load();
  if (cached && cached.ready && age < STALE_MS) {
    cached.refreshing = true;
    promise.then(
      () => cache.set(key, { at: Date.now(), promise, ready: true }),
      () => {
        cached.refreshing = false;
      });
    return cached.promise;
  }
  const entry = { at: Date.now(), promise, ready: false };
  cache.set(key, entry);
  promise.then(
    () => {
      entry.ready = true;
    },
    () => cache.delete(key));
  return promise;
}

// Caches a promise per key for answers that never change (keys name exact commits); a failure
// is forgotten so the next request retries. With a limit, the oldest entry goes first.
function remember(cache, key, load, limit) {
  if (!cache.has(key)) {
    if (limit && cache.size >= limit) {
      cache.delete(cache.keys().next().value);
    }
    const promise = load();
    cache.set(key, promise);
    promise.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

function requireSha(value) {
  if (!value || !SHA.test(value)) {
    throw new HttpError(400, 'Expected a commit SHA.');
  }
}

function range(from, to) {
  const start = Number(from || 0);
  const end = Number(to || 0);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return null;
  }
  return { start, end: Math.min(end, start + 500) };
}

function slice(lines, lineRange) {
  if (!lines || !lineRange) {
    return [];
  }
  const body = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return body.slice(lineRange.start - 1, lineRange.end).map((text, index) => ({
    line: lineRange.start + index,
    text,
  }));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new HttpError(413, 'Payload Too Large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new HttpError(400, 'Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function sendJson(res, value) {
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(value));
}

function sendError(res, err) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const known = err instanceof HttpError || err instanceof gh.GitHubError;
  const status = known && err.status >= 400 && err.status < 600 ? err.status : known ? 502 : 500;
  send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: err.message || 'Request failed.' }));
}

module.exports = {
  APP,
  BUILD,
  VERSION,
  createServer,
};

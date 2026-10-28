'use strict';

(function () {
  const { api, homeRepo } = window.GhArc;
  const pending = new Map();
  let queue = [];
  let running = 0;
  let intentTimer;
  let idle;

  function target(path) {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin || url.search) return null;
    const route = window.GhArcRoutes.parseDiffPath(url.pathname, homeRepo);
    if (!route) return null;
    const [owner, repo] = route.repo.split('/');
    return `/api/pr/${owner}/${repo}/${route.number}/prefetch`;
  }

  function drain() {
    while (running < 2 && queue.length) {
      const path = queue.shift();
      running++;
      api(path).then((result) => {
        if (!result.prefetched) pending.delete(path);
      }, () => pending.delete(path)).finally(() => { running--; drain(); });
    }
  }

  function enqueue(paths) {
    if (document.hidden) return;
    for (const path of paths) {
      const key = target(path);
      if (!key || Date.now() - (pending.get(key) || 0) < 15000) continue;
      pending.set(key, Date.now());
      if (pending.size > 40) pending.delete(pending.keys().next().value);
      queue.push(key);
    }
    drain();
  }

  function reset() {
    clearTimeout(intentTimer);
    cancelIdleCallback(idle);
    for (const path of queue) pending.delete(path);
    queue = [];
  }

  function schedule(paths) {
    cancelIdleCallback(idle);
    idle = requestIdleCallback(() => enqueue(paths));
  }

  function linkPath(event) {
    const link = event.target.closest('a[href]');
    if (!link || link.target === '_blank') return null;
    const url = new URL(link.href);
    return url.pathname === location.pathname ? null : link.href;
  }
  document.addEventListener('pointerover', (event) => {
    const path = linkPath(event);
    if (!path || !target(path)) return;
    clearTimeout(intentTimer);
    intentTimer = setTimeout(() => enqueue([path]), 120);
  });
  document.addEventListener('pointerout', (event) => {
    if (event.target.closest('a[href]') && !event.target.closest('a[href]').contains(event.relatedTarget)) clearTimeout(intentTimer);
  });
  document.addEventListener('focusin', (event) => {
    const path = linkPath(event);
    if (path) enqueue([path]);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  window.PhabricadePrefetch = { schedule, reset };
})();

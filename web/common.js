'use strict';

(function () {
  const tokenMeta = document.querySelector('meta[name="gh-arc-token"]');
  const token = tokenMeta ? tokenMeta.getAttribute('content') : '';
  const homeMeta = document.querySelector('meta[name="gh-arc-home-repo"]');
  const homeRepo = homeMeta ? homeMeta.getAttribute('content') || null : null;
  const routes = window.GhArcRoutes;

  const short = routes.isAliasHost(window.location.hostname);

  function diffPath(repo, number) {
    return routes.diffPath(repo, number, homeRepo, short);
  }

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: {} };
    if (options.body !== undefined) {
      init.method = options.method || 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-GH-Arc-Token'] = token;
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (err) {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error((payload && payload.error) || text || `Request failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function relativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) {
        return `${Math.floor(seconds / size)}${unit} ago`;
      }
    }
    return 'just now';
  }

  function time(value) {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    return `<time datetime="${escapeHtml(value)}" title="${escapeHtml(date.toLocaleString())}">${escapeHtml(relativeTime(value))}</time>`;
  }

  function avatar(actor, size) {
    const px = size || 20;
    if (!actor || !actor.avatarUrl) {
      const initial = actor && actor.login ? actor.login.slice(0, 1).toUpperCase() : '?';
      return `<span class="avatar avatar-fallback" style="width:${px}px;height:${px}px">${escapeHtml(initial)}</span>`;
    }
    return `<img class="avatar" src="${escapeHtml(actor.avatarUrl)}" alt="" width="${px}" height="${px}" loading="lazy">`;
  }

  const STATE_LABELS = {
    OPEN: 'Open',
    DRAFT: 'Draft',
    MERGED: 'Merged',
    CLOSED: 'Closed',
  };

  function stateBadge(state) {
    const key = STATE_LABELS[state] ? state : 'OPEN';
    return `<span class="state-badge state-${key.toLowerCase()}">${STATE_LABELS[key]}</span>`;
  }

  // Review status, Phabricator style: label, tone (a CSS class suffix) and a one-glyph mark.
  const STATUSES = {
    UNDER_REVIEW: ['Under review', 'review', '●'],
    ACCEPTED: ['Accepted', 'accepted', '✓'],
    CHANGES_REQUESTED: ['Changes requested', 'changes', '✕'],
    DRAFT: ['Draft', 'draft', '◌'],
    MERGED: ['Merged', 'merged', '●'],
    CLOSED: ['Closed', 'closed', '⊘'],
  };

  function statusInfo(status) {
    const [label, tone, mark] = STATUSES[status] || STATUSES.UNDER_REVIEW;
    return { label, tone, mark };
  }

  function statusChip(status) {
    const { label, tone } = statusInfo(status);
    return `<span class="status-chip status-${tone}">${label}</span>`;
  }

  function statusMark(status) {
    const { label, tone, mark } = statusInfo(status);
    return `<span class="status-mark status-${tone}" title="${label}" aria-label="${label}">${mark}</span>`;
  }

  const CHECK_LABELS = {
    SUCCESS: ['✓', 'Checks passed'],
    FAILURE: ['✕', 'Checks failed'],
    ERROR: ['✕', 'Checks errored'],
    PENDING: ['●', 'Checks running'],
    EXPECTED: ['●', 'Checks expected'],
    NEUTRAL: ['–', 'Skipped'],
    CANCELLED: ['⊘', 'Cancelled'],
  };

  function checksIcon(state) {
    const entry = CHECK_LABELS[state];
    if (!entry) {
      return '';
    }
    return `<span class="checks-icon checks-${state.toLowerCase()}" title="${entry[1]}" aria-label="${entry[1]}">${entry[0]}</span>`;
  }

  // A github.com pull request link, marked so the gh-arc browser extension leaves it on GitHub
  // instead of sending it back here.
  function onGitHub(href) {
    let url;
    try {
      url = new URL(href);
    } catch (err) {
      return href;
    }
    if (url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+/.test(url.pathname)) {
      url.searchParams.set('gh-arc', 'off');
    }
    return url.toString();
  }

  // Pull request links inside GitHub-rendered markdown open here; everything else opens in a new tab.
  function localPrPath(href) {
    const match = String(href).match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/files)?\/?(#.*)?$/);
    return match && !match[4] ? diffPath(`${match[1]}/${match[2]}`, match[3]) : null;
  }

  function prepareLinks(root) {
    root.querySelectorAll('.markdown-body a[href]').forEach((link) => {
      const local = localPrPath(link.getAttribute('href'));
      if (local) {
        link.setAttribute('href', local);
        link.removeAttribute('target');
        return;
      }
      link.setAttribute('href', onGitHub(link.getAttribute('href')));
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer noopener');
    });
  }

  window.GhArc = {
    api,
    avatar,
    checksIcon,
    diffPath,
    homeRepo,
    escapeHtml,
    localPrPath,
    onGitHub,
    prepareLinks,
    relativeTime,
    stateBadge,
    statusChip,
    statusInfo,
    statusMark,
    time,
  };
}());

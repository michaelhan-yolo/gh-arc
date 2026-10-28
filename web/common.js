'use strict';

(function () {
  const tokenMeta = document.querySelector('meta[name="gh-arc-token"]');
  let token = tokenMeta ? tokenMeta.getAttribute('content') : '';
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
    let response = await fetch(path, init);
    const freshToken = response.status === 403 && response.headers.get('X-GH-Arc-Token');
    // This rejection happens before the action runs, so a restart can be recovered once.
    if (init.method === 'POST' && freshToken) {
      token = freshToken;
      if (tokenMeta) tokenMeta.setAttribute('content', token);
      init.headers['X-GH-Arc-Token'] = token;
      await response.body.cancel();
      response = await fetch(path, init);
    }
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
    return `<span class="status-chip status-${tone}"><span class="status-dot" aria-hidden="true"></span>${label}</span>`;
  }

  function statusMark(status) {
    const { label, tone, mark } = statusInfo(status);
    return `<span class="status-mark status-${tone}" title="${label}" aria-label="${label}">${mark}</span>`;
  }

  const CHECK_LABELS = {
    SUCCESS: ['check-circle', 'Checks passed'],
    FAILURE: ['x-circle', 'Checks failed'],
    ERROR: ['x-circle', 'Checks errored'],
    PENDING: ['clock', 'Checks running'],
    EXPECTED: ['clock', 'Checks expected'],
    NEUTRAL: ['minus-circle', 'Skipped'],
    CANCELLED: ['slash-circle', 'Cancelled'],
  };

  function checksIcon(state) {
    const entry = CHECK_LABELS[state];
    if (!entry) {
      return '';
    }
    return `<span class="checks-icon checks-${state.toLowerCase()}" title="${entry[1]}" role="img" aria-label="${entry[1]}">${icon(entry[0], 16)}</span>`;
  }

  // Thin line icons, drawn on a 24px grid in the text color.
  const ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'minus-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    'slash-circle': '<circle cx="12" cy="12" r="9"/><path d="M6 18L18 6"/>',
    'x-circle': '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    chat: '<path d="M4 5.5h16v10.5H9.5L5 19.5V16H4z"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    columns: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M12 5v14"/>',
    rows: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 12h18"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
    inbox: '<path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5"/><path d="M5.5 5h13L21 13.5V19H3v-5.5z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.1M4.5 12h.1M4.5 17.5h.1"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    stack: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  };

  function icon(name, size) {
    const px = size || 16;
    return `<svg class="icon icon-${name}" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  }

  // Static pages mark where an icon goes with data-icon.
  document.querySelectorAll('[data-icon]').forEach((node) => {
    node.innerHTML = icon(node.getAttribute('data-icon'), Number(node.getAttribute('data-icon-size')) || 16);
  });

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
    icon,
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

'use strict';

(function () {
  const tokenMeta = document.querySelector('meta[name="gh-arc-token"]');
  const token = tokenMeta ? tokenMeta.getAttribute('content') : '';

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

  const DECISIONS = {
    APPROVED: ['Accepted', 'decision-approved'],
    CHANGES_REQUESTED: ['Changes requested', 'decision-changes'],
    REVIEW_REQUIRED: ['Needs review', 'decision-required'],
  };

  function decisionChip(decision) {
    const entry = DECISIONS[decision];
    return entry ? `<span class="decision-chip ${entry[1]}">${entry[0]}</span>` : '';
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

  // Pull request links inside GitHub-rendered markdown open here; everything else opens in a new tab.
  function localPrPath(href) {
    const match = String(href).match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/files)?\/?(#.*)?$/);
    return match && !match[4] ? `/${match[1]}/${match[2]}/pull/${match[3]}` : null;
  }

  function prepareLinks(root) {
    root.querySelectorAll('.markdown-body a[href]').forEach((link) => {
      const local = localPrPath(link.getAttribute('href'));
      if (local) {
        link.setAttribute('href', local);
        link.removeAttribute('target');
        return;
      }
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noreferrer noopener');
    });
  }

  window.GhArc = {
    api,
    avatar,
    checksIcon,
    decisionChip,
    escapeHtml,
    localPrPath,
    prepareLinks,
    relativeTime,
    stateBadge,
    time,
  };
}());

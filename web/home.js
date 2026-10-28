'use strict';

(function () {
  const { api, avatar, checksIcon, diffPath, escapeHtml, homeRepo, icon, statusChip, time } = window.GhArc;
  const inbox = document.getElementById('inbox');
  const nav = document.getElementById('home-nav');
  const chips = document.getElementById('filter-chips');
  const quick = document.getElementById('quick-filters');
  const form = document.getElementById('open-form');
  const input = document.getElementById('open-input');
  // Each inbox section's icon in the sidebar; the pull request page's rail links to the same ones.
  const SECTION_ICONS = { needsReview: 'inbox', mine: 'user', reviewed: 'eye', landed: 'check-circle' };
  let data = null;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const path = targetPath(input.value.trim());
    if (path) {
      window.location.assign(path);
    } else {
      input.setCustomValidity('Paste a pull request URL or owner/repo#123.');
      input.reportValidity();
    }
  });
  input.addEventListener('input', () => input.setCustomValidity(''));

  inbox.addEventListener('click', (event) => {
    if (event.target.closest('[data-inbox-retry]')) load();
  });
  window.addEventListener('hashchange', render);

  load();

  function targetPath(value) {
    const reference = window.GhArcRoutes.parseReference(value);
    if (reference) {
      return diffPath(reference.repo, reference.number);
    }
    const number = value.match(/^#?(\d+)$/);
    return number && homeRepo ? diffPath(homeRepo, number[1]) : null;
  }

  async function load() {
    inbox.innerHTML = '<div class="empty">Loading your inbox…</div>';
    try {
      data = await api('/api/inbox');
      document.getElementById('viewer-login').textContent = `Signed in to GitHub as ${data.viewer}`;
      render();
    } catch (err) {
      inbox.innerHTML = `<div class="fatal"><strong>Couldn't load your inbox.</strong><p>${escapeHtml(err.message)}</p><button type="button" data-inbox-retry>Try again</button></div>`;
    }
  }

  // The view lives in the address: #mine shows one section, repo=owner/name one repository.
  function filters() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const keys = data.sections.map((section) => section.key);
    const section = Array.from(params.keys()).find((key) => keys.includes(key) && !params.get(key)) || null;
    return { section, repo: params.get('repo') || null };
  }

  function filterHref(view) {
    const parts = [];
    if (view.section) {
      parts.push(view.section);
    }
    if (view.repo) {
      parts.push(`repo=${encodeURIComponent(view.repo)}`);
    }
    return `#${parts.join('&')}`;
  }

  function itemCount(groups) {
    return groups.reduce((total, group) => total + group.items.length, 0);
  }

  function render() {
    if (!data) {
      return;
    }
    const view = filters();
    const sectionTitle = view.section && data.sections.find((section) => section.key === view.section).title;
    nav.innerHTML = [
      `<a class="home-nav-item${view.section ? '' : ' active'}" href="${filterHref({ repo: view.repo })}">${icon('list', 18)}<span class="home-nav-label">All pull requests</span></a>`,
      ...data.sections.map((section) => {
        const count = itemCount(section.groups);
        return `<a class="home-nav-item${view.section === section.key ? ' active' : ''}" href="${filterHref({ section: section.key, repo: view.repo })}">
          ${icon(SECTION_ICONS[section.key] || 'inbox', 18)}<span class="home-nav-label">${escapeHtml(section.title)}</span>
          ${count ? `<span class="count-badge">${count}</span>` : ''}</a>`;
      }),
    ].join('');

    const chip = (label, value, without) =>
      `<a class="filter-chip" href="${filterHref(without)}" title="Remove this filter">${label} is <b>${escapeHtml(value)}</b>${icon('x', 14)}</a>`;
    chips.innerHTML = [
      view.section ? chip('Section', sectionTitle, { repo: view.repo }) : '',
      view.repo ? chip('Repository', view.repo, { section: view.section }) : '',
    ].join('');

    const repos = Array.from(new Set(data.sections.flatMap((section) => section.groups.map((group) => group.repo)))).sort();
    quick.innerHTML = repos.map((repo) => {
      const active = view.repo === repo;
      return `<a class="quick-filter${active ? ' active' : ''}" href="${filterHref({ section: view.section, repo: active ? null : repo })}"
        aria-pressed="${active}">${escapeHtml(repo)}${active ? icon('x', 14) : ''}</a>`;
    }).join('') + (view.section || view.repo ? '<a class="quick-filter-clear" href="#">Clear all</a>' : '');

    inbox.innerHTML = data.sections
      .filter((section) => !view.section || section.key === view.section)
      .map((section) => renderSection(section, view.repo))
      .join('');
  }

  function renderSection(section, repo) {
    const groups = section.groups.filter((group) => !repo || group.repo === repo);
    const count = itemCount(groups);
    return `
      <section class="inbox-section" id="section-${escapeHtml(section.key)}">
        <h2>${escapeHtml(section.title)} <span class="section-count">${count}</span></h2>
        ${count
          ? `<div class="inbox-table">${groups.map(renderGroup).join('')}</div>`
          : '<div class="muted inbox-empty">Nothing here.</div>'}
      </section>
    `;
  }

  function renderGroup(group) {
    const stacked = group.items.length > 1;
    const trunk = stacked
      ? `<div class="inbox-row inbox-trunk"><span class="stack-graph" aria-hidden="true"><span class="stack-dot"></span></span><code>${escapeHtml(group.trunk)}</code></div>`
      : '';
    return `
      <div class="inbox-group${stacked ? ' is-stack' : ''}">
        ${stacked ? `<div class="inbox-group-label">${icon('stack', 14)}Stack of ${group.items.length} in ${escapeHtml(group.repo)}</div>` : ''}
        ${group.items.map((item) => renderRow(group.repo, item)).join('')}
        ${trunk}
      </div>
    `;
  }

  function renderRow(repo, item) {
    const pr = item.pr;
    const lines = pr.additions + pr.deletions;
    return `
      <a class="inbox-row" href="${escapeHtml(diffPath(repo, pr.number))}" style="--lane: ${item.lane}">
        <span class="stack-graph" aria-hidden="true"><span class="stack-dot"></span></span>
        <span class="inbox-avatar" title="${escapeHtml(pr.author.login)}">${avatar(pr.author, 22)}</span>
        <span class="inbox-number${pr.state === 'MERGED' ? ' landed' : ''}">#${pr.number}</span>
        <span class="inbox-title">${escapeHtml(pr.title)}</span>
        <span class="inbox-repo" title="${escapeHtml(repo)}">${escapeHtml(repo.split('/')[1])}</span>
        <span class="inbox-lines" title="+${pr.additions} -${pr.deletions}">${lines.toLocaleString()} line${lines === 1 ? '' : 's'}</span>
        <span class="inbox-updated" title="${pr.mergedAt ? 'Landed' : 'Updated'}">${time(pr.mergedAt || pr.updatedAt)}</span>
        <span class="inbox-badges">${statusChip(pr.reviewStatus)}</span>
        <span class="inbox-checks">${checksIcon(pr.checks)}</span>
      </a>
    `;
  }
}());

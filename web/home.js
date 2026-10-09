'use strict';

(function () {
  const { api, avatar, checksIcon, decisionChip, escapeHtml, stateBadge, time } = window.GhArc;
  const inbox = document.getElementById('inbox');
  const form = document.getElementById('open-form');
  const input = document.getElementById('open-input');

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

  load();

  function targetPath(value) {
    const url = value.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    if (url) {
      return `/${url[1]}/${url[2]}/pull/${url[3]}`;
    }
    const short = value.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
    return short ? `/${short[1]}/${short[2]}/pull/${short[3]}` : null;
  }

  async function load() {
    try {
      const data = await api('/api/inbox');
      document.getElementById('viewer-login').textContent = `Signed in to GitHub as ${data.viewer}`;
      inbox.innerHTML = data.sections.map(renderSection).join('');
    } catch (err) {
      inbox.innerHTML = `<div class="fatal"><strong>Couldn't load your inbox.</strong><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function renderSection(section) {
    const count = section.groups.reduce((total, group) => total + group.items.length, 0);
    return `
      <section class="inbox-section">
        <h2>${escapeHtml(section.title)} <span class="section-count">${count}</span></h2>
        ${count
          ? `<div class="inbox-table">${section.groups.map(renderGroup).join('')}</div>`
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
        ${stacked ? `<div class="inbox-group-label">Stack of ${group.items.length} in ${escapeHtml(group.repo)}</div>` : ''}
        ${group.items.map((item) => renderRow(group.repo, item)).join('')}
        ${trunk}
      </div>
    `;
  }

  function renderRow(repo, item) {
    const pr = item.pr;
    return `
      <a class="inbox-row" href="/${escapeHtml(repo)}/pull/${pr.number}" style="--lane: ${item.lane}">
        <span class="stack-graph" aria-hidden="true"><span class="stack-dot"></span></span>
        <span class="inbox-repo" title="${escapeHtml(repo)}">${escapeHtml(repo.split('/')[1])}</span>
        <span class="inbox-number">#${pr.number}</span>
        <span class="inbox-title">${escapeHtml(pr.title)}</span>
        <span class="inbox-badges">${pr.state === 'OPEN' ? '' : stateBadge(pr.state)}${decisionChip(pr.reviewDecision)}${checksIcon(pr.checks)}</span>
        <span class="inbox-author">${avatar(pr.author, 18)}${escapeHtml(pr.author.login)}</span>
        <span class="stat"><span class="add">+${pr.additions}</span> <span class="del">-${pr.deletions}</span></span>
        <span class="inbox-updated">${time(pr.updatedAt)}</span>
      </a>
    `;
  }
}());

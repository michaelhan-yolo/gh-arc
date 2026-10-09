'use strict';

// The diff engine (patch parsing, split/unified tables, context expansion, range selection)
// comes from local-arc (MIT, Emerson Ding). The GitHub layer around it is gh-arc's.
(function () {
  const { api, avatar, checksIcon, decisionChip, escapeHtml, prepareLinks, stateBadge, time } = window.GhArc;
  const { applyHeaderLine, parseDiffGitLine } = window.GhArcPatchPaths;
  const escapeAttr = escapeHtml;
  const LARGE_FILE_LINES = 1500;
  const GENERATED_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|uv\.lock)$|\.min\.(js|css)$|(^|\/)(__generated__|generated)\/|\.snap$/;
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const ACTIVITY_VISIBLE = 6;
  const LONG_SUMMARY_CHARS = 2500;
  const ROUTE = parseRoute();
  const RANGE = parseRange();

  const state = {
    mode: readPreference('ghArcMode', 'split'),
    files: [],
    expanded: new Set(),
    collapsedFolders: new Set(),
    context: {},
    refs: { oldRef: null, newRef: null },
    data: null,
    stack: null,
    threads: [],
    drafts: { threads: [], replies: [], body: '', event: 'COMMENT' },
    allComments: [],
    comments: [],
    commentsVisible: true,
    openComments: new Set(),
    closedComments: new Set(),
    collapsedFiles: new Set(),
    expandedFiles: new Set(),
    selection: null,
    rangeDrag: null,
    activeCommentId: null,
    replyToId: null,
    editingId: null,
    filter: '',
    showAllActivity: false,
    summaryExpanded: false,
    outdatedOpen: false,
    submitting: false,
    submitError: '',
  };

  const el = {
    content: document.getElementById('content'),
    fileList: document.getElementById('file-list'),
    summary: document.getElementById('summary'),
    heading: document.getElementById('pr-heading'),
    subheading: document.getElementById('pr-subheading'),
    filter: document.getElementById('file-filter'),
    split: document.getElementById('mode-split'),
    unified: document.getElementById('mode-unified'),
    commentsToggle: document.getElementById('comments-toggle'),
    reviewJump: document.getElementById('review-jump'),
    stackNav: document.getElementById('stack-nav'),
    resizer: document.getElementById('sidebar-resizer'),
    toast: document.getElementById('toast'),
  };

  boot();

  // ---------------------------------------------------------------- data

  function parseRoute() {
    const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  }

  function parseRange() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('commit')) {
      return { commit: params.get('commit') };
    }
    if (params.get('from') && params.get('to')) {
      return { from: params.get('from'), to: params.get('to') };
    }
    return null;
  }

  function prApi(action, query) {
    return `/api/pr/${ROUTE.owner}/${ROUTE.repo}/${ROUTE.number}/${action}${query ? `?${query}` : ''}`;
  }

  function prPath(number) {
    return `/${ROUTE.owner}/${ROUTE.repo}/pull/${number}`;
  }

  async function boot() {
    bindControls();
    setMode(state.mode, true);
    el.content.innerHTML = '<div class="empty">Loading pull request…</div>';
    loadStack();
    try {
      const [data, patch, threads] = await Promise.all([
        api(prApi('pr')),
        api(prApi('patch', RANGE ? new URLSearchParams(RANGE).toString() : '')),
        api(prApi('threads')),
      ]);
      state.data = data;
      state.refs = { oldRef: patch.oldRef, newRef: patch.newRef || data.pr.headRefOid };
      state.files = parsePatch(patch.patch);
      applyThreads(threads);
      document.title = `#${data.pr.number} ${data.pr.title}`;
      render();
      jumpToHash();
    } catch (err) {
      renderFatal(err);
    }
  }

  async function loadStack() {
    try {
      state.stack = await api(prApi('stack'));
    } catch (err) {
      state.stack = { error: err.message };
    }
    renderStackNav();
    const section = document.getElementById('stack-section');
    if (section) {
      section.outerHTML = renderStackSection();
    }
  }

  async function reloadAfterSubmit() {
    const [data, threads] = await Promise.all([api(prApi('pr')), api(prApi('threads'))]);
    state.data = data;
    applyThreads(threads);
    render();
  }

  function applyThreads(payload) {
    state.threads = payload.threads;
    state.drafts = payload.drafts;
    refreshComments();
  }

  // The summary and action being typed here win over the copy the server echoes back.
  function setDrafts(drafts) {
    state.drafts = { ...drafts, body: state.drafts.body, event: state.drafts.event };
    refreshComments();
  }

  function refreshComments() {
    const replies = state.drafts.replies;
    state.allComments = state.threads
      .map((thread) => ({ ...thread, draftReplies: replies.filter((reply) => reply.threadId === thread.id) }))
      .concat(state.drafts.threads.map((draft) => ({ ...draft, kind: 'draft' })));
    state.comments = state.allComments.filter(isPositioned);
  }

  function isPositioned(comment) {
    if (comment.kind === 'thread' && (comment.outdated || comment.fileLevel || !comment.endLine)) {
      return false;
    }
    return !RANGE || (headView() && comment.side === 'new');
  }

  // Review comments anchor to the head commit, so only a view whose right side is head can take them.
  function headView() {
    return !RANGE || Boolean(state.data && state.refs.newRef === state.data.pr.headRefOid);
  }

  function canComment(side) {
    return !RANGE || (headView() && side === 'new');
  }

  function findComment(id) {
    return state.allComments.find((comment) => comment.id === id) || null;
  }

  function fileForComment(comment) {
    return state.files.find((file) => commentPath(file, comment.side) === comment.path) || null;
  }

  function isCommentCollapsed(comment) {
    if (state.closedComments.has(comment.id)) {
      return true;
    }
    return !state.openComments.has(comment.id) && comment.kind === 'thread' && comment.resolved;
  }

  function githubPath(file) {
    return file.newPath || file.oldPath || '';
  }

  function isViewed(file) {
    return !RANGE && Boolean(state.data && state.data.pr.viewed[githubPath(file)]);
  }

  function isBulky(file) {
    return file.additions + file.deletions > LARGE_FILE_LINES || GENERATED_RE.test(githubPath(file));
  }

  function isFileCollapsed(file) {
    if (state.collapsedFiles.has(file.id)) {
      return true;
    }
    if (state.expandedFiles.has(file.id)) {
      return false;
    }
    return isViewed(file) || isBulky(file);
  }

  function readPreference(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writePreference(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      // Preferences are a convenience; private windows may refuse them.
    }
  }

  // ---------------------------------------------------------------- controls

  function bindControls() {
    el.split.addEventListener('click', () => setMode('split'));
    el.unified.addEventListener('click', () => setMode('unified'));
    el.commentsToggle.addEventListener('click', () => {
      state.commentsVisible = !state.commentsVisible;
      updateCommentsToggle();
      renderContent();
    });
    el.reviewJump.addEventListener('click', () => {
      const panel = document.getElementById('review-panel');
      if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const textarea = panel.querySelector('[data-review-body]');
        if (textarea) {
          textarea.focus({ preventScroll: true });
        }
      }
    });
    bindSidebarResize();
    el.filter.addEventListener('input', () => {
      state.filter = el.filter.value.trim().toLowerCase();
      renderFileList();
      renderContent();
    });
    el.fileList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-folder]');
      if (!button) {
        return;
      }
      const key = button.getAttribute('data-folder');
      if (state.collapsedFolders.has(key)) {
        state.collapsedFolders.delete(key);
      } else {
        state.collapsedFolders.add(key);
      }
      renderFileList();
    });
    el.content.addEventListener('click', onContentClick);
    el.content.addEventListener('change', onContentChange);
    el.content.addEventListener('input', onContentInput);
    el.content.addEventListener('keydown', onContentKeydown);
    el.content.addEventListener('toggle', (event) => {
      if (event.target.matches('[data-outdated-details]')) {
        state.outdatedOpen = event.target.open;
      }
    }, true);
    el.content.addEventListener('pointerdown', (event) => {
      if (event.target.closest('[data-comment-marker]')) {
        return;
      }
      const lineButton = event.target.closest('[data-line-handle]');
      if (lineButton) {
        startRangeSelection(lineButton, event);
      }
    });
    el.content.addEventListener('mouseover', (event) => {
      if (state.rangeDrag) {
        updateRangeSelectionFromPoint(event.clientX, event.clientY);
        return;
      }
      const inlineComment = event.target.closest('[data-comment-id]');
      if (inlineComment) {
        setActiveComment(inlineComment.getAttribute('data-comment-id'));
      }
    });
    el.content.addEventListener('mouseout', (event) => {
      const inlineComment = event.target.closest('[data-comment-id]');
      if (inlineComment && !inlineComment.contains(event.relatedTarget)) {
        setActiveComment(null);
      }
    });
    document.addEventListener('pointermove', (event) => {
      if (state.rangeDrag) {
        updateRangeSelectionFromPoint(event.clientX, event.clientY);
      }
    });
    document.addEventListener('pointerup', finishRangeSelection);
    document.addEventListener('pointercancel', cancelRangeSelection);
    document.addEventListener('keydown', onGlobalKeydown);
  }

  function onContentClick(event) {
    const match = (selector) => event.target.closest(selector);
    let node;

    if ((node = match('[data-expand]'))) {
      state.expanded.add(node.getAttribute('data-expand'));
      rerenderFileById(Number(node.getAttribute('data-expand').split(':')[0]));
    } else if ((node = match('[data-context]'))) {
      fetchContext(node);
    } else if ((node = match('[data-file-toggle]'))) {
      toggleFile(Number(node.getAttribute('data-file-toggle')));
    } else if ((node = match('[data-file-expand]'))) {
      const file = state.files[Number(node.getAttribute('data-file-expand'))];
      state.expandedFiles.add(file.id);
      state.collapsedFiles.delete(file.id);
      rerenderFile(file);
    } else if ((node = match('[data-comment-marker]'))) {
      toggleCommentMarker(node.getAttribute('data-comment-marker'));
    } else if ((node = match('[data-comment-toggle]'))) {
      toggleComment(node.getAttribute('data-comment-toggle'));
    } else if (match('[data-comment-cancel]')) {
      const selection = state.selection;
      const reply = state.replyToId && findComment(state.replyToId);
      state.selection = null;
      state.replyToId = null;
      if (selection) {
        rerenderFileById(selection.fileId);
      } else if (reply) {
        rerenderForComment(reply);
      }
    } else if ((node = match('[data-comment-reply]'))) {
      const comment = findComment(node.getAttribute('data-comment-reply'));
      state.replyToId = comment.id;
      state.openComments.add(comment.id);
      state.closedComments.delete(comment.id);
      rerenderForComment(comment);
      focusFirst('[data-reply-text]');
    } else if ((node = match('[data-comment-submit]'))) {
      saveComment(node);
    } else if ((node = match('[data-reply-submit]'))) {
      saveReply(node);
    } else if ((node = match('[data-resolve]'))) {
      resolveThread(node.getAttribute('data-resolve'), node.getAttribute('data-resolved') === 'true');
    } else if ((node = match('[data-draft-delete]'))) {
      deleteDraft(node.getAttribute('data-draft-delete'));
    } else if ((node = match('[data-draft-edit]'))) {
      state.editingId = node.getAttribute('data-draft-edit');
      rerenderForDraft(state.editingId);
      focusFirst('[data-draft-edit-text]');
    } else if (match('[data-draft-edit-cancel]')) {
      const id = state.editingId;
      state.editingId = null;
      rerenderForDraft(id);
    } else if ((node = match('[data-draft-edit-save]'))) {
      saveDraftEdit(node);
    } else if ((node = match('[data-review-event]'))) {
      setReviewEvent(node.getAttribute('data-review-event'));
    } else if (match('[data-review-submit]')) {
      submitReview();
    } else if ((node = match('[data-jump-comment]'))) {
      event.preventDefault();
      jumpToComment(node.getAttribute('data-jump-comment'));
    } else if (match('[data-activity-more]')) {
      state.showAllActivity = true;
      renderContent();
    } else if (match('[data-summary-more]')) {
      state.summaryExpanded = !state.summaryExpanded;
      renderContent();
    }
  }

  function onContentChange(event) {
    const target = event.target;
    if (target.matches('[data-viewed]')) {
      setViewed(Number(target.getAttribute('data-viewed')), target.checked);
    } else if (target.matches('[data-range-select]')) {
      const value = target.value;
      const params = new URLSearchParams();
      if (value.startsWith('commit:')) {
        params.set('commit', value.slice('commit:'.length));
      } else if (value === 'since') {
        params.set('from', state.data.pr.lastReviewedOid);
        params.set('to', state.data.pr.headRefOid);
      }
      const query = params.toString();
      window.location.assign(`${prPath(ROUTE.number)}${query ? `?${query}` : ''}`);
    }
  }

  let reviewBodyTimer = null;

  function onContentInput(event) {
    if (event.target.matches('[data-review-body]')) {
      state.drafts.body = event.target.value;
      window.clearTimeout(reviewBodyTimer);
      reviewBodyTimer = window.setTimeout(() => {
        saveDraftPayload({ action: 'review', body: state.drafts.body }).catch(() => {});
      }, 600);
    }
  }

  function onContentKeydown(event) {
    const target = event.target;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      const scope = target.closest('.comment-composer, .reply-composer, .draft-editor, .review-panel');
      const button = scope && scope.querySelector(
        '[data-comment-submit], [data-reply-submit], [data-draft-edit-save], [data-review-submit]');
      if (button) {
        event.preventDefault();
        button.click();
      }
    } else if (event.key === 'Escape' && target.matches('textarea')) {
      const scope = target.closest('.comment-composer, .reply-composer, .draft-editor');
      const button = scope && scope.querySelector('[data-comment-cancel], [data-draft-edit-cancel]');
      if (button) {
        event.preventDefault();
        button.click();
      }
    }
  }

  function onGlobalKeydown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) {
      return;
    }
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      stepFile(event.key === 'j' ? 1 : -1);
    } else if (event.key === '[' || event.key === ']') {
      const stack = state.stack;
      const target = stack && !stack.error && (event.key === '[' ? stack.parent : stack.children[0]);
      if (target) {
        window.location.assign(prPath(target));
      }
    }
  }

  // Files scroll to just under the sticky top bar (scroll-margin-top in the CSS).
  function stepFile(direction) {
    const articles = Array.from(el.content.querySelectorAll('article.file'));
    const anchor = 72;
    const tops = articles.map((article) => article.getBoundingClientRect().top);
    let target = null;
    if (direction > 0) {
      target = articles.find((article, index) => tops[index] > anchor + 4) || null;
    } else {
      for (let ii = articles.length - 1; ii >= 0; ii--) {
        if (tops[ii] < anchor - 4) {
          target = articles[ii];
          break;
        }
      }
    }
    if (target) {
      target.scrollIntoView({ block: 'start' });
    }
  }

  function setMode(mode, initial) {
    state.mode = mode;
    writePreference('ghArcMode', mode);
    el.split.classList.toggle('active', mode === 'split');
    el.unified.classList.toggle('active', mode === 'unified');
    if (!initial) {
      renderContent();
    }
  }

  function bindSidebarResize() {
    const savedWidth = Number(readPreference('ghArcSidebarWidth', 0));
    if (savedWidth) {
      setSidebarWidth(savedWidth);
    }
    let dragging = false;
    function stopDrag() {
      dragging = false;
      document.body.classList.remove('resizing-sidebar');
    }
    function updateFromClientX(clientX) {
      const width = clamp(clientX, 180, Math.min(640, window.innerWidth - 360));
      setSidebarWidth(width);
      writePreference('ghArcSidebarWidth', String(width));
    }
    el.resizer.addEventListener('pointerdown', (event) => {
      dragging = true;
      document.body.classList.add('resizing-sidebar');
      el.resizer.setPointerCapture(event.pointerId);
      updateFromClientX(event.clientX);
      event.preventDefault();
    });
    el.resizer.addEventListener('pointermove', (event) => {
      if (dragging) {
        updateFromClientX(event.clientX);
      }
    });
    el.resizer.addEventListener('pointerup', stopDrag);
    el.resizer.addEventListener('pointercancel', stopDrag);
    el.resizer.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      event.preventDefault();
      const current = Number(getComputedStyle(document.documentElement)
        .getPropertyValue('--sidebar-width')
        .replace('px', '')) || 280;
      updateFromClientX(current + (event.key === 'ArrowRight' ? 20 : -20));
    });
  }

  function setSidebarWidth(width) {
    document.documentElement.style.setProperty('--sidebar-width', `${Math.round(width)}px`);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // ---------------------------------------------------------------- page

  function render() {
    renderHeader();
    renderStackNav();
    updateCommentsToggle();
    updateReviewJump();
    renderSummary();
    renderFileList();
    renderContent();
  }

  function renderFatal(err) {
    const hint = err.status === 401
      ? 'Run <code>gh auth login</code>, then reload.'
      : err.status === 404
        ? 'Check the number and that your GitHub account can see this repository.'
        : '';
    el.heading.textContent = `${ROUTE.owner}/${ROUTE.repo}#${ROUTE.number}`;
    el.content.innerHTML = `
      <div class="fatal">
        <strong>Couldn't load this pull request.</strong>
        <p>${escapeHtml(err.message)}</p>
        ${hint ? `<p class="muted">${hint}</p>` : ''}
      </div>`;
  }

  function renderHeader() {
    const { pr, repo } = state.data;
    el.heading.innerHTML = `<span class="heading-number">#${pr.number}</span> ${escapeHtml(pr.title)}`;
    el.heading.title = pr.title;
    el.subheading.innerHTML = `${escapeHtml(repo.nameWithOwner)} · <code>${escapeHtml(pr.headRefName)}</code> → <code>${escapeHtml(pr.baseRefName)}</code>`;
  }

  function renderStackNav() {
    const stack = state.stack;
    if (!stack || stack.error || stack.entries.length < 2) {
      el.stackNav.hidden = true;
      return;
    }
    const position = stack.entries.findIndex((entry) => entry.number === stack.current) + 1;
    const parent = stack.parent;
    const child = stack.children[0];
    el.stackNav.hidden = false;
    el.stackNav.innerHTML = `
      ${parent
        ? `<a class="stack-step" href="${prPath(parent)}" title="Down the stack: #${parent} ( [ )">‹ #${parent}</a>`
        : '<span class="stack-step disabled" title="Bottom of the stack">‹</span>'}
      <span class="stack-position" title="Position from the bottom of the stack">Stack ${position}/${stack.entries.length}</span>
      ${child
        ? `<a class="stack-step" href="${prPath(child)}" title="Up the stack: #${child} ( ] )">#${child} ›</a>`
        : '<span class="stack-step disabled" title="Top of the stack">›</span>'}
    `;
  }

  function renderSummary() {
    const files = state.files.length;
    const add = sum(state.files.map((file) => file.additions));
    const del = sum(state.files.map((file) => file.deletions));
    const unresolved = state.threads.filter((thread) => !thread.resolved).length;
    const drafts = state.drafts.threads.length + state.drafts.replies.length;
    const viewed = RANGE ? 0 : state.files.filter(isViewed).length;
    el.summary.innerHTML = [
      `${files} file${files === 1 ? '' : 's'} changed, <span class="add">+${add}</span> <span class="del">-${del}</span>`,
      viewed ? `${viewed} of ${files} viewed` : '',
      unresolved ? `${unresolved} unresolved thread${unresolved === 1 ? '' : 's'}` : '',
      drafts ? `<span class="draft-count">${drafts} unsubmitted</span>` : '',
    ].filter(Boolean).join('<br>');
  }

  function updateCommentsToggle() {
    const count = state.comments.length;
    el.commentsToggle.textContent = `${state.commentsVisible ? 'Hide' : 'Show'} comments${count ? ` (${count})` : ''}`;
  }

  function updateReviewJump() {
    const drafts = state.drafts.threads.length + state.drafts.replies.length;
    el.reviewJump.innerHTML = `Review${drafts ? ` <span class="badge">${drafts}</span>` : ''}`;
    el.reviewJump.title = drafts ? `${drafts} unsubmitted comment${drafts === 1 ? '' : 's'}` : 'Write and submit a review';
  }

  function showToast(html, kind) {
    el.toast.innerHTML = html;
    el.toast.className = `toast${kind ? ` toast-${kind}` : ''}`;
    el.toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      el.toast.hidden = true;
    }, kind === 'error' ? 9000 : 6000);
  }

  function jumpToHash() {
    if (!window.location.hash) {
      return;
    }
    const node = document.getElementById(window.location.hash.slice(1));
    if (node) {
      node.scrollIntoView({ block: 'start' });
    }
  }

  function jumpToComment(id) {
    const comment = findComment(id);
    if (!comment) {
      return;
    }
    const file = isPositioned(comment) ? fileForComment(comment) : null;
    if (file && isFileCollapsed(file)) {
      state.expandedFiles.add(file.id);
      state.collapsedFiles.delete(file.id);
      rerenderFile(file);
    }
    if (!file && comment.kind === 'thread' && !state.outdatedOpen) {
      state.outdatedOpen = true;
      renderContent();
    }
    const node = el.content.querySelector(`[data-comment-id="${CSS.escape(id)}"]`);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      setActiveComment(id);
    }
  }

  // ---------------------------------------------------------------- sidebar

  function renderFileList() {
    const filtered = getFilteredFiles();
    if (!filtered.length) {
      el.fileList.innerHTML = '<div class="muted">No matching files.</div>';
      return;
    }
    el.fileList.innerHTML = renderTreeChildren(buildFileTree(filtered), 0);
  }

  function buildFileTree(files) {
    const root = { type: 'folder', name: '', key: '', folders: new Map(), files: [], commentCount: 0 };
    files.forEach((file) => {
      const parts = treePath(file).split('/').filter(Boolean);
      if (!parts.length) {
        parts.push(displayPath(file));
      }
      let folder = root;
      const folders = [root];
      parts.slice(0, -1).forEach((part) => {
        const key = folder.key ? `${folder.key}/${part}` : part;
        if (!folder.folders.has(part)) {
          folder.folders.set(part, { type: 'folder', name: part, key, folders: new Map(), files: [], commentCount: 0 });
        }
        folder = folder.folders.get(part);
        folders.push(folder);
      });
      const commentCount = fileCommentCount(file);
      folders.forEach((item) => {
        item.commentCount += commentCount;
      });
      folder.files.push({ type: 'file', name: parts[parts.length - 1], file, commentCount });
    });
    return compactFolders(root);
  }

  // A folder holding only one folder merges with it into a single a/b/c row.
  function compactFolders(folder) {
    folder.folders.forEach((child, key) => {
      let merged = child;
      while (merged.folders.size === 1 && !merged.files.length) {
        const only = merged.folders.values().next().value;
        merged = { ...only, name: `${merged.name}/${only.name}` };
      }
      folder.folders.set(key, compactFolders(merged));
    });
    return folder;
  }

  function renderTreeChildren(folder, depth) {
    const folders = Array.from(folder.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
    const files = folder.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    return folders.map((child) => renderFolder(child, depth)).join('') +
      files.map((item) => renderFileNode(item, depth)).join('');
  }

  function flattenFileTree(folder) {
    const folders = Array.from(folder.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
    const files = folder.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    return folders.flatMap(flattenFileTree).concat(files.map((item) => item.file));
  }

  function renderFolder(folder, depth) {
    const collapsed = state.collapsedFolders.has(folder.key);
    return `
      <div class="tree-folder">
        <button type="button" class="tree-folder-button${collapsed ? ' collapsed' : ''}" data-folder="${escapeAttr(folder.key)}"
          style="--tree-depth: ${depth}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${escapeAttr(folder.key)}">
          <span class="tree-name">${escapeHtml(folder.name)}</span>
          ${renderTreeCommentCount(folder.commentCount)}
        </button>
        ${collapsed ? '' : renderTreeChildren(folder, depth + 1)}
      </div>
    `;
  }

  function renderFileNode(item, depth) {
    const file = item.file;
    const viewed = isViewed(file);
    return `
      <a class="file-link${viewed ? ' viewed' : ''}" href="#file-${file.id}" style="--tree-depth: ${depth}" title="${escapeAttr(displayPath(file))}">
        <span class="path">${viewed ? '<span class="viewed-check" aria-label="Viewed">✓</span>' : ''}${escapeHtml(item.name)}</span>
        ${renderTreeCommentCount(item.commentCount)}
        <span class="stat"><span class="add">+${file.additions}</span> <span class="del">-${file.deletions}</span></span>
      </a>
    `;
  }

  function renderTreeCommentCount(count) {
    return count
      ? `<span class="tree-comment-count" title="${count} comment${count === 1 ? '' : 's'}">${count}</span>`
      : '';
  }

  function fileCommentCount(file) {
    return state.comments.filter((comment) => comment.path === commentPath(file, comment.side)).length;
  }

  function treePath(file) {
    return file.newPath || file.oldPath || displayPath(file);
  }

  // ---------------------------------------------------------------- content

  function renderContent() {
    if (!state.data) {
      return;
    }
    const saved = captureComposers();
    const files = getFilteredFiles();
    const ordered = files.length ? flattenFileTree(buildFileTree(files)) : [];
    el.content.innerHTML = renderDetails() +
      (ordered.length ? ordered.map(renderFile).join('') : '<div class="empty">No changes to show.</div>') +
      renderReviewPanel();
    prepareLinks(el.content);
    restoreComposers(saved);
    applyActiveHighlight();
  }

  function rerenderFile(file) {
    const node = file && document.getElementById(`file-${file.id}`);
    if (!node) {
      renderContent();
      return;
    }
    const saved = captureComposers();
    node.outerHTML = renderFile(file);
    prepareLinks(document.getElementById(`file-${file.id}`));
    restoreComposers(saved);
    applyActiveHighlight();
  }

  function rerenderFileById(id) {
    rerenderFile(state.files[id]);
  }

  function rerenderForComment(comment) {
    const file = comment && isPositioned(comment) ? fileForComment(comment) : null;
    if (file) {
      rerenderFile(file);
    } else {
      renderContent();
    }
  }

  function rerenderForDraft(id) {
    const reply = state.drafts.replies.find((item) => item.id === id);
    rerenderForComment(findComment(reply ? reply.threadId : id));
  }

  function refreshReviewPanel() {
    const node = document.getElementById('review-panel');
    if (node) {
      node.outerHTML = renderReviewPanel();
    }
    updateReviewJump();
    renderSummary();
  }

  // Keeps text typed into open composers when the markup around them re-renders.
  function captureComposers() {
    const saved = [];
    el.content.querySelectorAll('textarea[data-composer-key]').forEach((textarea) => {
      saved.push({
        key: textarea.getAttribute('data-composer-key'),
        value: textarea.value,
        focused: document.activeElement === textarea,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      });
    });
    return saved;
  }

  function restoreComposers(saved) {
    saved.forEach((item) => {
      const textarea = el.content.querySelector(`textarea[data-composer-key="${CSS.escape(item.key)}"]`);
      if (!textarea) {
        return;
      }
      textarea.value = item.value;
      if (item.focused) {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(item.start, item.end);
      }
    });
  }

  function focusFirst(selector) {
    window.requestAnimationFrame(() => {
      const node = el.content.querySelector(selector);
      if (node) {
        node.focus();
      }
    });
  }

  // ---------------------------------------------------------------- details

  function renderDetails() {
    const { pr, repo } = state.data;
    return `
      <section class="diff-metadata pr-details" aria-label="Pull request details">
        <div class="metadata-header">
          <div class="pr-header-left">${stateBadge(pr.state)}<span>${escapeHtml(repo.nameWithOwner)} #${pr.number}</span></div>
          <a class="external-link" href="${escapeAttr(pr.url)}" target="_blank" rel="noreferrer noopener">Open on GitHub ↗</a>
        </div>
        <div class="metadata-body">
          <h2 class="pr-title">${escapeHtml(pr.title)}</h2>
          ${renderRangeBanner()}
          <dl class="metadata-properties">
            ${property('Author', `${avatar(pr.author)} ${userLink(pr.author.login)} <span class="muted">opened ${time(pr.createdAt)}</span>`)}
            ${property('Branch', `<code>${escapeHtml(pr.headRefName)}</code> → <code>${escapeHtml(pr.baseRefName)}</code>`)}
            ${property('Reviewers', renderReviewers(pr.reviewers))}
            ${property('Status', renderStatus(pr))}
            ${property('Checks', renderChecks(pr.checks))}
            ${pr.labels.length ? property('Labels', pr.labels.map(renderLabel).join(' ')) : ''}
            ${property('Changes', renderChangesPicker(pr))}
          </dl>
          ${renderStackSection()}
          ${renderSummarySection(pr)}
          ${renderActivity(pr)}
          ${renderOutdated()}
        </div>
      </section>
    `;
  }

  function property(label, value) {
    return `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
  }

  function userLink(login) {
    return `<a class="user-link" href="https://github.com/${escapeAttr(login)}" target="_blank" rel="noreferrer noopener">${escapeHtml(login)}</a>`;
  }

  function renderReviewers(reviewers) {
    if (!reviewers.length) {
      return '<span class="muted">None</span>';
    }
    const labels = {
      APPROVED: ['✓', 'Accepted'],
      CHANGES_REQUESTED: ['✕', 'Requested changes'],
      COMMENTED: ['…', 'Commented'],
      DISMISSED: ['–', 'Dismissed'],
      REQUESTED: ['◦', 'Review requested'],
    };
    return `<span class="reviewer-list">${reviewers.map((reviewer) => {
      const [icon, label] = labels[reviewer.state] || labels.REQUESTED;
      return `<span class="reviewer reviewer-${reviewer.state.toLowerCase()}" title="${escapeAttr(`${reviewer.login}: ${label}`)}">
        ${reviewer.team ? '<span class="team-icon" aria-hidden="true">👥</span>' : avatar(reviewer, 18)}
        ${escapeHtml(reviewer.login)}<span class="reviewer-state" aria-label="${escapeAttr(label)}">${icon}</span>
      </span>`;
    }).join('')}</span>`;
  }

  function renderStatus(pr) {
    const parts = [];
    if (pr.state === 'OPEN' || pr.state === 'DRAFT') {
      parts.push(decisionChip(pr.reviewDecision) || '<span class="muted">No review required</span>');
    }
    if (pr.mergeable === 'CONFLICTING') {
      parts.push('<span class="decision-chip decision-changes">Merge conflicts</span>');
    }
    parts.push(`<span class="muted"><span class="add">+${pr.additions}</span> <span class="del">-${pr.deletions}</span> in ${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'} · ${pr.totalCommits} commit${pr.totalCommits === 1 ? '' : 's'}</span>`);
    return parts.join(' ');
  }

  function renderChecks(checks) {
    if (!checks) {
      return '<span class="muted">No checks</span>';
    }
    const counts = { SUCCESS: 0, FAILURE: 0, PENDING: 0, NEUTRAL: 0, CANCELLED: 0 };
    checks.contexts.forEach((item) => {
      counts[item.state] = (counts[item.state] || 0) + 1;
    });
    const summary = [
      counts.FAILURE ? `<span class="del">${counts.FAILURE} failed</span>` : '',
      counts.PENDING ? `${counts.PENDING} running` : '',
      counts.SUCCESS ? `${counts.SUCCESS} passed` : '',
      counts.CANCELLED ? `${counts.CANCELLED} cancelled` : '',
      counts.NEUTRAL ? `${counts.NEUTRAL} skipped` : '',
    ].filter(Boolean).join(' · ');
    const order = { FAILURE: 0, PENDING: 1, SUCCESS: 2, CANCELLED: 3, NEUTRAL: 4 };
    const items = checks.contexts.slice().sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
    const more = checks.total > checks.contexts.length
      ? `<li class="muted">${checks.total - checks.contexts.length} more on GitHub</li>`
      : '';
    const overall = ['FAILURE', 'PENDING', 'CANCELLED', 'SUCCESS', 'NEUTRAL'].find((key) => counts[key]) || checks.state;
    return `
      <details class="checks-details"${counts.FAILURE ? ' open' : ''}>
        <summary>${checksIcon(overall)} ${summary || 'No checks'}</summary>
        <ul class="checks-list">
          ${items.map((item) => `<li>${checksIcon(item.state)} ${item.url
            ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.name)}</a>`
            : escapeHtml(item.name)}</li>`).join('')}
          ${more}
        </ul>
      </details>
    `;
  }

  function renderLabel(label) {
    const color = /^[0-9a-f]{6}$/i.test(label.color) ? label.color : 'd8dde6';
    return `<span class="label-chip" style="--label-color: #${color}">${escapeHtml(label.name)}</span>`;
  }

  function renderChangesPicker(pr) {
    let current = '';
    if (RANGE && RANGE.commit) {
      current = `commit:${RANGE.commit}`;
    } else if (RANGE) {
      current = RANGE.from === pr.lastReviewedOid && RANGE.to === pr.headRefOid ? 'since' : 'custom';
    }
    const options = ['<option value="">All changes</option>'];
    if (pr.lastReviewedOid && pr.lastReviewedOid !== pr.headRefOid) {
      options.push(`<option value="since">Since your last review (${escapeHtml(pr.lastReviewedOid.slice(0, 7))})</option>`);
    }
    if (current === 'custom') {
      options.push(`<option value="custom">${escapeHtml(RANGE.from.slice(0, 7))}…${escapeHtml(RANGE.to.slice(0, 7))}</option>`);
    }
    const commits = pr.commits.slice().reverse();
    if (commits.length) {
      options.push(`<optgroup label="One commit${pr.totalCommits > commits.length ? ` (latest ${commits.length})` : ''}">`);
      commits.forEach((commit) => {
        options.push(`<option value="commit:${escapeAttr(commit.oid)}">${escapeHtml(commit.short)} ${escapeHtml(commit.headline.slice(0, 70))}${commit.isMerge ? ' (merge)' : ''}</option>`);
      });
      options.push('</optgroup>');
    }
    const html = options.join('').replace(`value="${escapeAttr(current)}"`, `value="${escapeAttr(current)}" selected`);
    return `<select class="range-select" data-range-select aria-label="Which changes to show">${html}</select>`;
  }

  function renderRangeBanner() {
    if (!RANGE) {
      return '';
    }
    const pr = state.data.pr;
    let label;
    if (RANGE.commit) {
      const commit = pr.commits.find((item) => item.oid === RANGE.commit);
      label = `the changes in commit <code>${escapeHtml(RANGE.commit.slice(0, 7))}</code>${commit ? ` · ${escapeHtml(commit.headline)}` : ''}`;
    } else if (RANGE.from === pr.lastReviewedOid) {
      label = `the changes since your last review (<code>${escapeHtml(RANGE.from.slice(0, 7))}</code> → <code>${escapeHtml(RANGE.to.slice(0, 7))}</code>)`;
    } else {
      label = `<code>${escapeHtml(RANGE.from.slice(0, 7))}</code> → <code>${escapeHtml(RANGE.to.slice(0, 7))}</code>`;
    }
    const mergedIn = !RANGE.commit && rangeHasMerge(pr) ? ' It includes everything merged in from the base branch.' : '';
    const commenting = headView()
      ? 'You can comment on the right side.'
      : 'Comments are read-only in this view.';
    return `
      <div class="range-banner">
        Showing ${label}. ${commenting}${mergedIn}
        <a href="${prPath(ROUTE.number)}">Back to all changes</a>
      </div>
    `;
  }

  function rangeHasMerge(pr) {
    const start = pr.commits.findIndex((commit) => commit.oid === RANGE.from);
    return start !== -1 && pr.commits.slice(start + 1).some((commit) => commit.isMerge);
  }

  function renderStackSection() {
    const stack = state.stack;
    const heading = (extra) => `
      <div class="metadata-section-heading">
        <div class="metadata-section-title"><span>Stack</span>${extra || ''}</div>
      </div>`;
    if (!stack) {
      return `<div class="metadata-section" id="stack-section">${heading()}<div class="muted stack-note">Finding the stack…</div></div>`;
    }
    if (stack.error) {
      return `<div class="metadata-section" id="stack-section">${heading()}<div class="muted stack-note">Couldn't load the stack: ${escapeHtml(stack.error)}</div></div>`;
    }
    if (stack.entries.length < 2) {
      return '<div id="stack-section" hidden></div>';
    }
    const position = stack.entries.findIndex((entry) => entry.number === stack.current) + 1;
    return `
      <div class="metadata-section" id="stack-section">
        ${heading(`<span class="section-count">${position} of ${stack.entries.length} from the bottom</span>`)}
        <ol class="stack-list">
          ${stack.entries.slice().reverse().map(renderStackRow).join('')}
          <li class="stack-row stack-trunk">
            <span class="stack-graph" aria-hidden="true"><span class="stack-dot"></span></span>
            <code>${escapeHtml(stack.trunk)}</code>
          </li>
        </ol>
      </div>
    `;
  }

  function renderStackRow(entry) {
    const current = entry.number === state.stack.current;
    const title = current
      ? `<span class="stack-title">${escapeHtml(entry.title)}</span>`
      : `<a class="stack-title" href="${prPath(entry.number)}">${escapeHtml(entry.title)}</a>`;
    return `
      <li class="stack-row${current ? ' current' : ''}" style="--lane: ${entry.lane}">
        <span class="stack-graph" aria-hidden="true"><span class="stack-dot"></span></span>
        <a class="stack-number" href="${prPath(entry.number)}"${current ? ' aria-current="page"' : ''}>#${entry.number}</a>
        ${title}
        ${entry.state === 'OPEN' ? '' : stateBadge(entry.state)}
        <span class="stack-author">${avatar(entry.author, 16)}${escapeHtml(entry.author.login)}</span>
        <span class="stack-decision">${decisionChip(entry.reviewDecision)}</span>
        <span class="stack-checks">${checksIcon(entry.checks)}</span>
        <span class="stat"><span class="add">+${entry.additions}</span> <span class="del">-${entry.deletions}</span></span>
      </li>
    `;
  }

  function renderSummarySection(pr) {
    const long = pr.bodyHTML && pr.bodyHTML.length > LONG_SUMMARY_CHARS;
    const clamped = long && !state.summaryExpanded;
    return `
      <div class="metadata-section">
        <div class="metadata-section-heading"><div class="metadata-section-title"><span>Summary</span></div></div>
        <div class="diff-description markdown-body${clamped ? ' clamped' : ''}">
          ${pr.bodyHTML || '<p class="muted">No description.</p>'}
        </div>
        ${long ? `<button type="button" class="link-button" data-summary-more>${clamped ? 'Show the full description' : 'Show less'}</button>` : ''}
      </div>
    `;
  }

  function renderActivity(pr) {
    const items = pr.timeline;
    if (!items.length) {
      return '';
    }
    const hidden = state.showAllActivity ? 0 : Math.max(0, items.length - ACTIVITY_VISIBLE);
    return `
      <div class="metadata-section metadata-activity">
        <div class="metadata-section-heading">
          <div class="metadata-section-title"><span>Activity</span><span class="section-count">${items.length}</span></div>
        </div>
        ${hidden ? `<button type="button" class="link-button activity-more" data-activity-more>Show ${hidden} earlier</button>` : ''}
        <ol class="activity-list">${items.slice(hidden).map(renderActivityItem).join('')}</ol>
      </div>
    `;
  }

  function renderActivityItem(item) {
    const actions = {
      APPROVED: 'accepted these changes',
      CHANGES_REQUESTED: 'requested changes',
      DISMISSED: 'reviewed (dismissed)',
      COMMENTED: 'reviewed',
    };
    const action = item.type === 'comment' ? 'commented' : actions[item.state] || 'reviewed';
    const tone = item.state === 'APPROVED' ? ' approved' : item.state === 'CHANGES_REQUESTED' ? ' changes' : '';
    const inline = item.inlineCount ? `<span class="activity-location">${item.inlineCount} inline</span>` : '';
    return `
      <li>
        <article class="activity-card${tone}">
          ${avatar(item.author, 28)}
          <div class="activity-main">
            <header class="activity-card-header">
              <div class="activity-headline">
                <span class="activity-user">${escapeHtml(item.author.login)}</span>
                <span class="activity-action">${action}</span>
                ${inline}
              </div>
              <a class="activity-time" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer noopener">${time(item.createdAt)}</a>
            </header>
            ${item.bodyHTML ? `<div class="markdown-body activity-body">${item.bodyHTML}</div>` : ''}
          </div>
        </article>
      </li>
    `;
  }

  function renderOutdated() {
    const loose = state.allComments.filter((comment) =>
      comment.kind === 'thread' && (comment.outdated || (comment.fileLevel && !fileForComment(comment))));
    if (!loose.length) {
      return '';
    }
    const unresolved = loose.filter((comment) => !comment.resolved).length;
    return `
      <div class="metadata-section">
        <details class="outdated-details" data-outdated-details${state.outdatedOpen ? ' open' : ''}>
          <summary class="metadata-section-title">
            <span>Outdated comments</span>
            <span class="section-count">${loose.length}${unresolved ? `, ${unresolved} unresolved` : ''}</span>
          </summary>
          <div class="outdated-list">${loose.map(renderOutdatedThread).join('')}</div>
        </details>
      </div>
    `;
  }

  function renderOutdatedThread(thread) {
    const where = thread.fileLevel ? 'file' : `${thread.side} line ${thread.endLine}`;
    return `
      <div class="outdated-thread">
        <div class="outdated-path"><code>${escapeHtml(thread.githubPath)}</code> <span class="muted">${escapeHtml(where)}</span></div>
        ${thread.diffHunk ? renderDiffHunk(thread.diffHunk) : ''}
        ${renderComment(thread)}
      </div>
    `;
  }

  function renderDiffHunk(hunk) {
    const lines = hunk.split('\n').filter((line) => !line.startsWith('@@')).slice(-6);
    return `<pre class="outdated-hunk">${lines.map((line) => {
      const tone = line.startsWith('+') ? 'new' : line.startsWith('-') ? 'old' : '';
      return `<span class="${tone}">${escapeHtml(line)}</span>`;
    }).join('\n')}</pre>`;
  }

  // ---------------------------------------------------------------- review panel

  function renderReviewPanel() {
    const { pr, viewer } = state.data;
    const ownPr = pr.author.login === viewer;
    const drafts = state.drafts.threads.concat(state.drafts.replies);
    const event = state.drafts.event;
    const events = [
      ['COMMENT', 'Comment', false],
      ['APPROVE', 'Accept', ownPr],
      ['REQUEST_CHANGES', 'Request changes', ownPr],
    ];
    const closed = pr.state === 'MERGED' || pr.state === 'CLOSED';
    return `
      <section class="review-panel" id="review-panel" aria-label="Submit review">
        <div class="metadata-header">
          <span>Review</span>
          <span class="muted">${drafts.length ? `${drafts.length} unsubmitted inline comment${drafts.length === 1 ? '' : 's'}` : 'No inline comments yet'}</span>
        </div>
        <div class="review-body">
          ${pr.hasPendingReview ? '<p class="review-note">Your pending review on GitHub goes out with this one.</p>' : ''}
          ${drafts.length ? `<ul class="draft-summary">${drafts.map(renderDraftSummary).join('')}</ul>` : ''}
          <textarea data-review-body data-composer-key="review-body" rows="4"
            placeholder="Leave a summary (Markdown). Inline comments stay drafts until you submit.">${escapeHtml(state.drafts.body)}</textarea>
          <div class="review-actions">
            <div class="segmented review-events" role="radiogroup" aria-label="Review action">
              ${events.map(([value, label, disabled]) => `
                <button type="button" role="radio" class="seg${event === value ? ' active' : ''}" data-review-event="${value}"
                  aria-checked="${event === value}"${disabled ? ' disabled title="Not available on your own pull request"' : ''}>${label}</button>
              `).join('')}
            </div>
            <span class="review-error" role="alert">${escapeHtml(state.submitError)}</span>
            <button type="button" class="primary-action" data-review-submit${state.submitting || closed ? ' disabled' : ''}>
              ${state.submitting ? 'Submitting…' : 'Submit review'}
            </button>
          </div>
          <div class="muted review-hint">⌘/Ctrl+Enter saves or submits · j/k next and previous file · [ and ] down and up the stack</div>
        </div>
      </section>
    `;
  }

  function renderDraftSummary(draft) {
    const thread = draft.threadId ? findComment(draft.threadId) : null;
    const anchor = thread || draft;
    const where = draft.threadId && !thread
      ? 'Reply to a thread that no longer exists'
      : anchor.fileLevel
        ? anchor.path
        : `${anchor.path}:${anchor.startLine === anchor.endLine ? anchor.endLine : `${anchor.startLine}-${anchor.endLine}`}`;
    return `
      <li${draft.error ? ' class="has-error"' : ''}>
        <a href="#" data-jump-comment="${escapeAttr(anchor.id)}">${escapeHtml(where)}</a>
        <span class="muted">${draft.threadId ? 'reply' : anchor.side === 'old' ? 'old side' : ''}</span>
        <span class="draft-snippet">${escapeHtml(draft.text.split('\n')[0].slice(0, 90))}</span>
        ${draft.error ? `<span class="draft-error">${escapeHtml(draft.error)}</span>` : ''}
      </li>
    `;
  }

  function setReviewEvent(eventName) {
    state.drafts.event = eventName;
    el.content.querySelectorAll('[data-review-event]').forEach((button) => {
      const active = button.getAttribute('data-review-event') === eventName;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
    window.clearTimeout(reviewBodyTimer);
    saveDraftPayload({ action: 'review', event: eventName, body: state.drafts.body }).catch(() => {});
  }

  async function submitReview() {
    if (state.submitting) {
      return;
    }
    window.clearTimeout(reviewBodyTimer);
    state.submitting = true;
    state.submitError = '';
    refreshReviewPanel();
    try {
      const result = await api(prApi('submit'), {
        body: { event: state.drafts.event, body: state.drafts.body },
      });
      state.submitting = false;
      if (!result.submitted) {
        setDrafts(result.drafts);
        const count = result.failures.length;
        state.submitError = `${count} comment${count === 1 ? '' : 's'} couldn't be posted. The others wait in your pending review on GitHub.`;
        renderContent();
        updateReviewJump();
        renderSummary();
        return;
      }
      const labels = { APPROVED: 'Accepted', CHANGES_REQUESTED: 'Requested changes', COMMENTED: 'Review submitted' };
      showToast(`${labels[result.review.state] || 'Review submitted'}. <a href="${escapeAttr(result.review.url)}" target="_blank" rel="noreferrer noopener">View on GitHub</a>`, 'success');
      await reloadAfterSubmit();
    } catch (err) {
      state.submitting = false;
      state.submitError = err.message;
      refreshReviewPanel();
    }
  }

  // ---------------------------------------------------------------- files

  function renderFile(file) {
    const collapsed = isFileCollapsed(file);
    const viewed = isViewed(file);
    let body = '';
    if (!collapsed) {
      const seen = { old: new Set(), new: new Set() };
      const hunks = file.binary
        ? `<div class="binary-note">${escapeHtml(file.binary)}</div>`
        : file.hunks.map((hunk) => renderHunk(file, hunk, seen)).join('');
      body = renderFileHeaders(file) + renderFileThreads(file) +
        (hunks || '<div class="binary-note">No textual changes.</div>');
    } else if (!viewed && isBulky(file) && !state.collapsedFiles.has(file.id)) {
      const reason = GENERATED_RE.test(githubPath(file)) ? 'Generated or lock file' : 'Large diff';
      body = `<div class="file-collapsed-note">${reason} hidden (${file.additions + file.deletions} lines). <button type="button" data-file-expand="${file.id}">Show diff</button></div>`;
    }
    return `
      <article class="file${collapsed ? ' collapsed' : ''}${viewed ? ' viewed' : ''}" id="file-${file.id}">
        <header class="file-header">
          <button type="button" class="file-collapse" data-file-toggle="${file.id}" aria-expanded="${!collapsed}"
            aria-label="${collapsed ? 'Expand' : 'Collapse'} file" title="${collapsed ? 'Expand' : 'Collapse'} file"></button>
          <div class="file-title" title="${escapeAttr(displayPath(file))}">${escapeHtml(displayPath(file))}</div>
          <div class="file-actions">
            ${fileStatusLabel(file)}
            <span class="file-meta"><span class="add">+${file.additions}</span> <span class="del">-${file.deletions}</span></span>
            ${githubFileLink(file)}
            ${RANGE ? '' : `<label class="viewed-toggle" title="Mark viewed on GitHub"><input type="checkbox" data-viewed="${file.id}"${viewed ? ' checked' : ''}> Viewed</label>`}
          </div>
        </header>
        ${body}
      </article>
    `;
  }

  function fileStatusLabel(file) {
    if (!file.oldPath) {
      return '<span class="file-status added">Added</span>';
    }
    if (!file.newPath) {
      return '<span class="file-status deleted">Deleted</span>';
    }
    if (file.oldPath !== file.newPath) {
      return '<span class="file-status renamed">Renamed</span>';
    }
    return '';
  }

  function githubFileLink(file) {
    if (!file.newPath) {
      return '';
    }
    const ref = state.refs.newRef || state.data.pr.headRefOid;
    const href = `https://github.com/${ROUTE.owner}/${ROUTE.repo}/blob/${ref}/${file.newPath.split('/').map(encodeURIComponent).join('/')}`;
    return `<a class="file-github-link" href="${escapeAttr(href)}" target="_blank" rel="noreferrer noopener" title="Open this version of the file on GitHub">↗</a>`;
  }

  function renderFileHeaders(file) {
    const shown = file.headers.filter((line) => /^(old mode|new mode)/.test(line));
    return shown.length ? `<pre class="headers">${escapeHtml(shown.join('\n'))}</pre>` : '';
  }

  function renderFileThreads(file) {
    const threads = state.allComments.filter((comment) =>
      comment.kind === 'thread' && comment.fileLevel && !comment.outdated && comment.path === commentPath(file, comment.side));
    if (!threads.length || !state.commentsVisible) {
      return '';
    }
    return `<div class="file-threads">${threads.map(renderComment).join('')}</div>`;
  }

  async function setViewed(fileId, viewed) {
    const file = state.files[fileId];
    const path = githubPath(file);
    const update = (value) => {
      state.data.pr.viewed[path] = value;
      state.collapsedFiles.delete(file.id);
      state.expandedFiles.delete(file.id);
      rerenderFile(file);
      renderFileList();
      renderSummary();
    };
    update(viewed);
    const article = document.getElementById(`file-${file.id}`);
    if (viewed && article && article.getBoundingClientRect().top < 64) {
      article.scrollIntoView({ block: 'start' });
    }
    try {
      await api(prApi('viewed'), { body: { path, viewed } });
    } catch (err) {
      update(!viewed);
      showToast(`Couldn't update the viewed state: ${escapeHtml(err.message)}`, 'error');
    }
  }

  function toggleFile(fileId) {
    const file = state.files[fileId];
    if (isFileCollapsed(file)) {
      state.collapsedFiles.delete(file.id);
      state.expandedFiles.add(file.id);
    } else {
      state.expandedFiles.delete(file.id);
      state.collapsedFiles.add(file.id);
    }
    rerenderFile(file);
    const article = document.getElementById(`file-${file.id}`);
    if (article && article.getBoundingClientRect().top < 64) {
      article.scrollIntoView({ block: 'start' });
    }
  }

  function renderHunk(file, hunk, seen) {
    const rows = filterSeenRows(decorateDeltaContextControls(
      file,
      hunk,
      rowsWithLoadedContext(file, hunk, visibleRows(hunk.rows, state.expanded.has(gapKey(file, hunk))))),
    seen);
    const table = state.mode === 'split'
      ? renderSplitTable(file, hunk, rows)
      : renderUnifiedTable(file, hunk, rows);
    return `
      <section class="hunk">
        <div class="hunk-title">${escapeHtml(hunk.header)}</div>
        ${table}
      </section>
    `;
  }

  function filterSeenRows(rows, seen) {
    return rows.filter((row) => {
      if (row.type === 'gap' || row.type === 'context-control' || row.type === 'meta') {
        return true;
      }
      const oldLine = lineForSide(row, 'old');
      const newLine = lineForSide(row, 'new');
      if ((oldLine && seen.old.has(oldLine)) || (newLine && seen.new.has(newLine))) {
        return false;
      }
      if (oldLine) {
        seen.old.add(oldLine);
      }
      if (newLine) {
        seen.new.add(newLine);
      }
      return true;
    });
  }

  function renderSplitTable(file, hunk, rows) {
    const body = buildSplitRows(rows).map((row) => {
      if (row.type === 'gap') {
        return gapRow(file, hunk, row.count, 4);
      }
      if (row.control) {
        return contextControlRow(row.control, 4);
      }
      if (row.meta) {
        return `<tr><td class="num"></td><td class="code meta-line" colspan="3">${escapeHtml(row.meta.text)}</td></tr>`;
      }
      const oldLine = lineForSide(row.left, 'old');
      const newLine = lineForSide(row.right, 'new');
      return `
        <tr>
          ${lineNumberCell(file, hunk, row.left, 'old')}
          <td class="code side ${row.left ? classFor(row.left) : 'empty-side'}${lineHighlightClass(file, 'old', oldLine)}"${lineDataAttrs(file, 'old', oldLine)}>${cellText(row.left)}</td>
          ${lineNumberCell(file, hunk, row.right, 'new')}
          <td class="code side ${row.right ? classFor(row.right) : 'empty-side'}${lineHighlightClass(file, 'new', newLine)}"${lineDataAttrs(file, 'new', newLine)}>${cellText(row.right)}</td>
        </tr>
        ${renderSideInlineRows(file, 'old', oldLine, 'split')}
        ${renderSideInlineRows(file, 'new', newLine, 'split')}
      `;
    }).join('');
    return `
      <table class="diff-table split">
        <colgroup><col class="line-col"><col class="code-col"><col class="line-col"><col class="code-col"></colgroup>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  function renderUnifiedTable(file, hunk, rows) {
    const body = rows.map((row) => {
      if (row.type === 'gap') {
        return gapRow(file, hunk, row.count, 3);
      }
      if (row.type === 'context-control') {
        return contextControlRow(row, 3);
      }
      const expanded = row.type === 'context-pair';
      const oldLine = expanded ? (row.old ? row.old.line : null) : row.oldLine;
      const newLine = expanded ? (row.new ? row.new.line : null) : row.newLine;
      return `
        <tr>
          ${lineNumberCell(file, hunk, { oldLine, expanded }, 'old')}
          ${lineNumberCell(file, hunk, { newLine, expanded }, 'new')}
          <td class="code ${classFor(row)}${lineHighlightClass(file, 'old', oldLine)}${lineHighlightClass(file, 'new', newLine)}"${unifiedLineDataAttrs(file, oldLine, newLine)}>${unifiedText(row)}</td>
        </tr>
        ${renderSideInlineRows(file, 'old', oldLine, 'unified')}
        ${renderSideInlineRows(file, 'new', newLine, 'unified')}
      `;
    }).join('');
    return `
      <table class="diff-table unified">
        <colgroup><col class="line-col"><col class="line-col"><col class="code-col"></colgroup>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  // GitHub takes review comments only on lines inside the pull request's hunks.
  function lineNumberCell(file, hunk, row, side) {
    const line = side === 'old' ? row && row.oldLine : row && row.newLine;
    if (!line) {
      return '<td class="num"></td>';
    }
    const label = canComment(side) && !row.expanded
      ? `<button type="button" class="line-select" data-line-handle data-line="${line}" data-side="${side}" data-file-id="${file.id}" data-hunk-id="${hunk.id}" title="Comment on ${side} line ${line} (drag for a range)">${line}</button>`
      : `<span class="line-plain">${line}</span>`;
    return `<td class="num${lineHighlightClass(file, side, line)}"${lineDataAttrs(file, side, line)}>${commentMarker(file, side, line)}${label}</td>`;
  }

  function renderSideInlineRows(file, side, line, mode) {
    if (!line) {
      return '';
    }
    const items = [];
    if (state.commentsVisible) {
      commentsForLine(file, side, line).forEach((comment) => {
        items.push(renderComment(comment));
      });
    }
    if (selectionEndsAt(file, side, line)) {
      items.push(renderCommentComposer(file, side));
    }
    return items.map((item) => inlineRow(item, side, mode)).join('');
  }

  function commentMarker(file, side, line) {
    const comments = commentsForLine(file, side, line);
    if (!comments.length) {
      return '';
    }
    const comment = comments[0];
    const hidden = isCommentCollapsed(comment) || !state.commentsVisible;
    const count = comments.length > 1 ? ` (${comments.length})` : '';
    const tone = comments.some((item) => item.kind === 'draft')
      ? ' draft'
      : comments.every((item) => item.resolved) ? ' resolved' : '';
    return `<button type="button" class="comment-marker${hidden ? ' hidden' : ''}${tone}" data-comment-marker="${escapeAttr(comment.id)}"
      title="${hidden ? 'Show' : 'Hide'} comment${count}" aria-label="${hidden ? 'Show' : 'Hide'} comment${count}"></button>`;
  }

  function inlineRow(content, side, mode) {
    if (mode === 'unified') {
      return `<tr class="comment-row"><td colspan="3">${content}</td></tr>`;
    }
    if (side === 'old') {
      return `<tr class="comment-row split-comment old-comment"><td colspan="2">${content}</td><td colspan="2"></td></tr>`;
    }
    return `<tr class="comment-row split-comment new-comment"><td colspan="2"></td><td colspan="2">${content}</td></tr>`;
  }

  function rangeLabel(comment) {
    if (comment.fileLevel) {
      return 'file';
    }
    return comment.startLine === comment.endLine
      ? `${comment.side} line ${comment.endLine}`
      : `${comment.side} lines ${comment.startLine}-${comment.endLine}`;
  }

  function renderComment(comment) {
    return comment.kind === 'draft' ? renderDraftThread(comment) : renderThread(comment);
  }

  function renderThread(thread) {
    const collapsed = isCommentCollapsed(thread);
    const first = thread.comments[0];
    const count = thread.comments.length + thread.draftReplies.length;
    const actions = [];
    if (!collapsed && thread.canReply && state.replyToId !== thread.id) {
      actions.push(`<button type="button" data-comment-reply="${escapeAttr(thread.id)}">Reply</button>`);
    }
    if (thread.resolved ? thread.canUnresolve : thread.canResolve) {
      actions.push(`<button type="button" data-resolve="${escapeAttr(thread.id)}" data-resolved="${!thread.resolved}">${thread.resolved ? 'Unresolve' : 'Resolve'}</button>`);
    }
    actions.push(`<button type="button" data-comment-toggle="${escapeAttr(thread.id)}">${collapsed ? 'Show' : 'Hide'}</button>`);
    if (first && first.url) {
      actions.push(`<a class="icon-link" href="${escapeAttr(first.url)}" target="_blank" rel="noreferrer noopener" title="Open on GitHub">↗</a>`);
    }
    return `
      <div class="inline-comment thread${thread.resolved ? ' resolved' : ''}${collapsed ? ' collapsed' : ''}" data-comment-id="${escapeAttr(thread.id)}" tabindex="0">
        <div class="comment-head">
          <span class="comment-title">
            ${first ? `${avatar(first.author, 18)}<strong>${escapeHtml(first.author.login)}</strong>` : ''}
            <span class="comment-range">${escapeHtml(rangeLabel(thread))}</span>
            ${thread.resolved ? `<span class="pill pill-resolved">Resolved${thread.resolvedBy ? ` by ${escapeHtml(thread.resolvedBy)}` : ''}</span>` : ''}
            ${collapsed && count > 1 ? `<span class="pill">${count} comments</span>` : ''}
            ${collapsed && first ? `<span class="comment-preview">${escapeHtml(first.body.split('\n')[0].slice(0, 120))}</span>` : ''}
          </span>
          <div class="comment-head-actions">${actions.join('')}</div>
        </div>
        ${collapsed ? '' : `
          <div class="thread-comments">
            ${thread.comments.map(renderThreadComment).join('')}
            ${thread.draftReplies.map(renderDraftReply).join('')}
          </div>
          ${state.replyToId === thread.id ? renderReplyComposer(thread) : ''}
        `}
      </div>
    `;
  }

  function renderThreadComment(comment) {
    return `
      <div class="thread-comment">
        <div class="thread-comment-meta">
          ${avatar(comment.author, 18)}
          <strong>${escapeHtml(comment.author.login)}</strong>
          <a class="muted" href="${escapeAttr(comment.url)}" target="_blank" rel="noreferrer noopener">${time(comment.createdAt)}</a>
          ${comment.pending ? '<span class="pill pill-pending">Pending</span>' : ''}
        </div>
        <div class="markdown-body comment-markdown">${comment.bodyHTML}</div>
      </div>
    `;
  }

  function renderDraftReply(reply) {
    const editing = state.editingId === reply.id;
    return `
      <div class="thread-comment draft-reply">
        <div class="thread-comment-meta">
          <span class="pill pill-draft">Unsubmitted</span>
          <strong>${escapeHtml(state.data.viewer)}</strong>
          ${editing ? '' : `<span class="draft-actions">${draftActions(reply.id)}</span>`}
        </div>
        ${editing ? renderDraftEditor(reply) : `<div class="draft-text">${escapeHtml(reply.text)}</div>`}
        ${reply.error ? `<div class="comment-error">${escapeHtml(reply.error)}</div>` : ''}
      </div>
    `;
  }

  function renderDraftThread(draft) {
    const editing = state.editingId === draft.id;
    return `
      <div class="inline-comment draft${draft.error ? ' has-error' : ''}" data-comment-id="${escapeAttr(draft.id)}" tabindex="0">
        <div class="comment-head">
          <span class="comment-title">
            <span class="pill pill-draft">Unsubmitted</span>
            <strong>${escapeHtml(state.data.viewer)}</strong>
            <span class="comment-range">${escapeHtml(rangeLabel(draft))}</span>
          </span>
          <div class="comment-head-actions">${editing ? '' : draftActions(draft.id)}</div>
        </div>
        ${editing ? renderDraftEditor(draft) : `<div class="comment-body draft-text">${escapeHtml(draft.text)}</div>`}
        ${draft.error ? `<div class="comment-error">${escapeHtml(draft.error)}</div>` : ''}
      </div>
    `;
  }

  function draftActions(id) {
    return `
      <button type="button" data-draft-edit="${escapeAttr(id)}">Edit</button>
      <button type="button" data-draft-delete="${escapeAttr(id)}">Delete</button>
    `;
  }

  function renderDraftEditor(draft) {
    return `
      <div class="draft-editor">
        <textarea data-draft-edit-text data-composer-key="edit:${escapeAttr(draft.id)}" rows="3">${escapeHtml(draft.text)}</textarea>
        <div class="comment-actions">
          <button type="button" data-draft-edit-cancel>Cancel</button>
          <button type="button" class="primary-action" data-draft-edit-save="${escapeAttr(draft.id)}">Save</button>
        </div>
      </div>
    `;
  }

  function renderReplyComposer(thread) {
    return `
      <div class="reply-composer">
        <textarea data-reply-text data-composer-key="reply:${escapeAttr(thread.id)}" rows="3" placeholder="Reply (Markdown). It stays a draft until you submit the review."></textarea>
        <div class="comment-actions">
          <button type="button" data-comment-cancel>Cancel</button>
          <button type="button" class="primary-action" data-reply-submit data-parent-id="${escapeAttr(thread.id)}">Save draft</button>
        </div>
      </div>
    `;
  }

  function renderCommentComposer(file, side) {
    const selection = state.selection;
    const start = Math.min(selection.startLine, selection.endLine);
    const end = Math.max(selection.startLine, selection.endLine);
    const label = start === end ? `${side} line ${start}` : `${side} lines ${start}-${end}`;
    return `
      <div class="comment-composer">
        <div class="comment-head">
          <span>New comment on ${escapeHtml(label)}</span>
          <button type="button" data-comment-cancel>Cancel</button>
        </div>
        <textarea data-comment-text data-composer-key="new:${file.id}:${side}:${start}-${end}" rows="3"
          placeholder="Comment (Markdown). It stays a draft until you submit the review."></textarea>
        <div class="comment-actions">
          <button type="button" class="primary-action" data-comment-submit data-file-id="${file.id}" data-side="${escapeAttr(side)}"
            data-start-line="${start}" data-end-line="${end}">Save draft</button>
        </div>
      </div>
    `;
  }

  function commentsForLine(file, side, line) {
    const path = commentPath(file, side);
    return state.comments.filter((comment) =>
      comment.side === side && comment.path === path && Number(comment.endLine) === Number(line));
  }

  function lineHighlightClass(file, side, line) {
    const classes = [];
    if (line && lineInSelection(file, side, line)) {
      classes.push('selected-line');
    }
    if (line && lineInActiveComment(file, side, line)) {
      classes.push('comment-covered-line');
    }
    return classes.length ? ` ${classes.join(' ')}` : '';
  }

  function lineInSelection(file, side, line) {
    const selection = state.selection;
    if (!selection || selection.fileId !== file.id || selection.side !== side) {
      return false;
    }
    return line >= Math.min(selection.startLine, selection.endLine) &&
      line <= Math.max(selection.startLine, selection.endLine);
  }

  function lineInActiveComment(file, side, line) {
    const comment = state.comments.find((item) => item.id === state.activeCommentId);
    if (!comment || isCommentCollapsed(comment) || comment.side !== side || comment.path !== commentPath(file, side)) {
      return false;
    }
    return line >= Number(comment.startLine) && line <= Number(comment.endLine);
  }

  function selectionEndsAt(file, side, line) {
    const selection = state.selection;
    if (state.rangeDrag || !selection || selection.fileId !== file.id || selection.side !== side) {
      return false;
    }
    return Math.max(selection.startLine, selection.endLine) === Number(line);
  }

  function lineDataAttrs(file, side, line) {
    return line ? ` data-line-cell data-file-id="${file.id}" data-side="${side}" data-line="${line}"` : '';
  }

  function unifiedLineDataAttrs(file, oldLine, newLine) {
    const attrs = [];
    if (oldLine) {
      attrs.push(`data-old-line="${oldLine}"`);
    }
    if (newLine) {
      attrs.push(`data-new-line="${newLine}"`);
    }
    return attrs.length ? ` data-file-id="${file.id}" ${attrs.join(' ')}` : '';
  }

  // Paints the lines a hovered comment covers without re-rendering the diff.
  function applyActiveHighlight() {
    el.content.querySelectorAll('.comment-covered-line').forEach((node) => node.classList.remove('comment-covered-line'));
    el.content.querySelectorAll('.inline-comment.active').forEach((node) => node.classList.remove('active'));
    const comment = state.activeCommentId && findComment(state.activeCommentId);
    if (!comment) {
      return;
    }
    const node = el.content.querySelector(`[data-comment-id="${CSS.escape(comment.id)}"]`);
    if (node) {
      node.classList.add('active');
    }
    if (!isCommentCollapsed(comment) && isPositioned(comment)) {
      paintLines(fileForComment(comment), comment.side, comment.startLine, comment.endLine, 'comment-covered-line');
    }
  }

  function paintLines(file, side, startLine, endLine, className) {
    const article = file && document.getElementById(`file-${file.id}`);
    if (!article) {
      return;
    }
    const start = Math.min(startLine, endLine);
    const end = Math.max(startLine, endLine);
    const paint = (cell, line) => {
      if (line >= start && line <= end) {
        cell.classList.add(className);
      }
    };
    article.querySelectorAll(`[data-line-cell][data-side="${side}"]`).forEach((cell) => {
      paint(cell, Number(cell.getAttribute('data-line')));
    });
    article.querySelectorAll(`[data-${side}-line]`).forEach((cell) => {
      paint(cell, Number(cell.getAttribute(`data-${side}-line`)));
    });
  }

  function setActiveComment(id) {
    const next = id || null;
    if (state.activeCommentId === next) {
      return;
    }
    state.activeCommentId = next;
    applyActiveHighlight();
  }

  function contextControlRow(row, colspan) {
    const item = state.context[row.key] || {};
    const label = item.loading
      ? 'Loading…'
      : row.direction === 'before' ? `+${row.count} before` : `+${row.count} after`;
    const error = item.error ? `<span class="context-error">${escapeHtml(item.error)}</span>` : '';
    return `
      <tr class="context-row">
        <td colspan="${colspan}">
          <button type="button" data-context="${escapeAttr(row.direction)}" data-context-key="${escapeAttr(row.key)}"
            data-file-id="${row.fileId}" data-old-path="${escapeAttr(row.oldPath || '')}" data-new-path="${escapeAttr(row.newPath || '')}"
            data-old-from="${row.oldFrom || ''}" data-old-to="${row.oldTo || ''}" data-new-from="${row.newFrom || ''}" data-new-to="${row.newTo || ''}">
            ${escapeHtml(label)}
          </button>
          ${error}
        </td>
      </tr>
    `;
  }

  function gapRow(file, hunk, count, colspan) {
    return `
      <tr class="gap-row">
        <td colspan="${colspan}">
          ${count} unchanged line${count === 1 ? '' : 's'} hidden
          <button type="button" data-expand="${escapeAttr(gapKey(file, hunk))}">Show context</button>
        </td>
      </tr>
    `;
  }

  function visibleRows(rows, expanded) {
    if (expanded) {
      return rows;
    }
    const changed = new Set();
    rows.forEach((row, index) => {
      if (row.type === 'add' || row.type === 'del') {
        for (let ii = index - 4; ii <= index + 4; ii++) {
          if (ii >= 0 && ii < rows.length) {
            changed.add(ii);
          }
        }
      }
    });
    if (!changed.size) {
      return rows;
    }
    const result = [];
    let gap = 0;
    rows.forEach((row, index) => {
      if (changed.has(index)) {
        if (gap) {
          result.push({ type: 'gap', count: gap });
          gap = 0;
        }
        result.push(row);
      } else {
        gap++;
      }
    });
    if (gap) {
      result.push({ type: 'gap', count: gap });
    }
    return result;
  }

  function rowsWithLoadedContext(file, hunk, rows) {
    const segments = loadedSegments(file);
    if (!segments.length) {
      return rows;
    }
    const out = [];
    rows.forEach((row, index) => {
      const previous = index ? rows[index - 1] : null;
      out.push(...dedupeRows(segmentsBetween(segments, previous, row), hunk));
      out.push(row);
    });
    out.push(...dedupeRows(segmentsAfter(segments, rows[rows.length - 1]), hunk));
    return out;
  }

  function dedupeRows(rows, hunk) {
    const seenOld = new Set(hunk.rows.map((row) => lineForSide(row, 'old')).filter(Boolean));
    const seenNew = new Set(hunk.rows.map((row) => lineForSide(row, 'new')).filter(Boolean));
    const out = [];
    rows.forEach((row) => {
      const oldLine = lineForSide(row, 'old');
      const newLine = lineForSide(row, 'new');
      if ((oldLine && seenOld.has(oldLine)) || (newLine && seenNew.has(newLine))) {
        return;
      }
      if (oldLine) {
        seenOld.add(oldLine);
      }
      if (newLine) {
        seenNew.add(newLine);
      }
      out.push(row);
    });
    return out;
  }

  function loadedSegments(file) {
    const rows = Array.from(fileContext(file).rows.values()).sort((a, b) => sortLine(a) - sortLine(b));
    const segments = [];
    let current = [];
    rows.forEach((row) => {
      const last = current.length ? current[current.length - 1] : null;
      if (last && !isAdjacentContext(last, row)) {
        segments.push(current);
        current = [];
      }
      current.push(row);
    });
    if (current.length) {
      segments.push(current);
    }
    return segments;
  }

  function segmentsBetween(segments, previous, next) {
    const previousOld = lineForSide(previous, 'old');
    const previousNew = lineForSide(previous, 'new');
    const nextOld = lineForSide(next, 'old');
    const nextNew = lineForSide(next, 'new');
    return segments
      .filter((segment) => sideFitsBetween(segment, previousOld, nextOld, 'old') &&
        sideFitsBetween(segment, previousNew, nextNew, 'new'))
      .flat();
  }

  function segmentsAfter(segments, previous) {
    const previousOld = lineForSide(previous, 'old');
    const previousNew = lineForSide(previous, 'new');
    return segments
      .filter((segment) => sideStartsAfter(segment, previousOld, 'old') && sideStartsAfter(segment, previousNew, 'new'))
      .flat();
  }

  function sideFitsBetween(segment, previous, next, side) {
    const first = firstLine(segment, side);
    const last = lastLine(segment, side);
    if (!first && !last) {
      return true;
    }
    if (!next || !first || !last || last >= next) {
      return false;
    }
    return previous ? first === previous + 1 : last === next - 1;
  }

  function sideStartsAfter(segment, previous, side) {
    const first = firstLine(segment, side);
    if (!first) {
      return true;
    }
    return Boolean(previous && first === previous + 1);
  }

  function isAdjacentContext(a, b) {
    return isAdjacentSide(a, b, 'old') && isAdjacentSide(a, b, 'new');
  }

  function isAdjacentSide(a, b, side) {
    const aLine = lineForSide(a, side);
    const bLine = lineForSide(b, side);
    if (!aLine || !bLine) {
      return true;
    }
    return bLine === aLine + 1;
  }

  function sortLine(row) {
    return lineForSide(row, 'old') || lineForSide(row, 'new') || 0;
  }

  function firstLine(segment, side) {
    for (const row of segment) {
      const line = lineForSide(row, side);
      if (line) {
        return line;
      }
    }
    return null;
  }

  function lastLine(segment, side) {
    for (let ii = segment.length - 1; ii >= 0; ii--) {
      const line = lineForSide(segment[ii], side);
      if (line) {
        return line;
      }
    }
    return null;
  }

  function decorateDeltaContextControls(file, hunk, rows) {
    if (file.binary) {
      return rows;
    }
    const groups = deltaRegions(rows);
    if (!groups.length) {
      return rows;
    }
    const out = [];
    let cursor = 0;
    groups.forEach((group) => {
      while (cursor < group.start) {
        out.push(rows[cursor]);
        cursor++;
      }
      const before = contextControlFor(file, hunk, rows, group, 'before');
      if (before) {
        appendContextOrControl(out, before);
      }
      while (cursor <= group.end) {
        out.push(rows[cursor]);
        cursor++;
      }
      const after = contextControlFor(file, hunk, rows, group, 'after');
      if (after) {
        appendContextOrControl(out, after);
      }
    });
    while (cursor < rows.length) {
      out.push(rows[cursor]);
      cursor++;
    }
    return out;
  }

  function appendContextOrControl(out, control) {
    const item = state.context[control.key];
    if (item && item.exhausted) {
      return;
    }
    if (item && item.rows) {
      out.push(...item.rows);
    } else {
      out.push(control);
    }
  }

  function deltaRegions(rows) {
    const groups = [];
    let start = null;
    let hasChange = false;
    rows.forEach((row, index) => {
      if (row.type === 'gap') {
        if (start !== null && hasChange) {
          groups.push({ start, end: index - 1 });
        }
        start = null;
        hasChange = false;
        return;
      }
      if (start === null) {
        start = index;
      }
      if (row.type === 'add' || row.type === 'del') {
        hasChange = true;
      }
    });
    if (start !== null && hasChange) {
      groups.push({ start, end: rows.length - 1 });
    }
    return groups;
  }

  function contextControlFor(file, hunk, rows, group, direction) {
    const oldRange = missingRange(file, rows, group, direction, 'old');
    const newRange = missingRange(file, rows, group, direction, 'new');
    if (!oldRange && !newRange) {
      return null;
    }
    const oldFrom = oldRange ? oldRange.from : '';
    const oldTo = oldRange ? oldRange.to : '';
    const newFrom = newRange ? newRange.from : '';
    const newTo = newRange ? newRange.to : '';
    return {
      type: 'context-control',
      direction,
      count: Math.max(
        oldRange ? oldRange.to - oldRange.from + 1 : 0,
        newRange ? newRange.to - newRange.from + 1 : 0),
      key: [file.id, hunk.id, direction, oldFrom, oldTo, newFrom, newTo].join(':'),
      oldPath: file.oldPath,
      newPath: file.newPath,
      fileId: file.id,
      oldFrom,
      oldTo,
      newFrom,
      newTo,
    };
  }

  function missingRange(file, rows, group, direction, side) {
    const groupLines = lineNumbers(rows.slice(group.start, group.end + 1), side);
    if (!groupLines.length) {
      return null;
    }
    const visibleLines = allVisibleLines(file, side);
    if (direction === 'before') {
      const first = Math.min(...groupLines);
      const previous = nearestVisibleLine(visibleLines, first, -1);
      const from = Math.max(previous === null ? first - 20 : previous + 1, first - 20, 1);
      const to = first - 1;
      return from <= to ? { from, to } : null;
    }
    const last = Math.max(...groupLines);
    const next = nearestVisibleLine(visibleLines, last, 1);
    const from = last + 1;
    const to = Math.min(next === null ? last + 20 : next - 1, last + 20);
    return from <= to ? { from, to } : null;
  }

  function allVisibleLines(file, side) {
    const lines = [];
    file.hunks.forEach((hunk) => {
      visibleRows(hunk.rows, state.expanded.has(gapKey(file, hunk))).forEach((row) => {
        const line = lineForSide(row, side);
        if (line) {
          lines.push(line);
        }
      });
    });
    loadedSegments(file).forEach((segment) => {
      segment.forEach((row) => {
        const line = lineForSide(row, side);
        if (line) {
          lines.push(line);
        }
      });
    });
    return Array.from(new Set(lines)).sort((a, b) => a - b);
  }

  function nearestVisibleLine(lines, target, direction) {
    if (direction < 0) {
      for (let ii = lines.length - 1; ii >= 0; ii--) {
        if (lines[ii] < target) {
          return lines[ii];
        }
      }
      return null;
    }
    for (const line of lines) {
      if (line > target) {
        return line;
      }
    }
    return null;
  }

  function lineNumbers(rows, side) {
    return rows.map((row) => lineForSide(row, side)).filter(Boolean);
  }

  function lineForSide(row, side) {
    if (!row || row.type === 'gap' || row.type === 'meta' || row.type === 'context-control') {
      return null;
    }
    if (row.type === 'context-pair') {
      const item = side === 'old' ? row.old : row.new;
      return item ? item.line : null;
    }
    return side === 'old' ? row.oldLine : row.newLine;
  }

  function lineKey(row) {
    const oldLine = lineForSide(row, 'old') || '';
    const newLine = lineForSide(row, 'new') || '';
    if (!oldLine && !newLine) {
      return null;
    }
    return `${oldLine}:${newLine}`;
  }

  function buildSplitRows(rows) {
    const out = [];
    for (let ii = 0; ii < rows.length; ii++) {
      const row = rows[ii];
      if (row.type === 'gap') {
        out.push(row);
        continue;
      }
      if (row.type === 'context-control') {
        out.push({ control: row });
        continue;
      }
      if (row.type === 'context-pair') {
        out.push({
          left: row.old ? contextPairSide(row.old, 'old') : null,
          right: row.new ? contextPairSide(row.new, 'new') : null,
        });
        continue;
      }
      if (row.type === 'meta') {
        out.push({ meta: row });
        continue;
      }
      if (row.type !== 'del') {
        out.push({
          left: row.type === 'context' ? row : null,
          right: row.type === 'context' || row.type === 'add' ? row : null,
        });
        continue;
      }
      const dels = [];
      const adds = [];
      while (ii < rows.length && rows[ii].type === 'del') {
        dels.push(rows[ii]);
        ii++;
      }
      while (ii < rows.length && rows[ii].type === 'add') {
        adds.push(rows[ii]);
        ii++;
      }
      ii--;
      const count = Math.max(dels.length, adds.length);
      for (let jj = 0; jj < count; jj++) {
        const left = dels[jj] || null;
        const right = adds[jj] || null;
        if (left && right) {
          const pair = intraline(left.text, right.text);
          left.html = pair.left;
          right.html = pair.right;
        }
        out.push({ left, right });
      }
    }
    return out;
  }

  function cellText(row) {
    if (!row) {
      return '';
    }
    if (row.type === 'context') {
      return escapeHtml(row.text);
    }
    return row.html || escapeHtml(row.text);
  }

  function unifiedText(row) {
    if (row.type === 'context-pair') {
      return `<span class="line-prefix"> </span>${escapeHtml((row.new || row.old || {}).text || '')}`;
    }
    const prefix = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
    return `<span class="line-prefix">${prefix}</span>${escapeHtml(row.text)}`;
  }

  function classFor(row) {
    if (!row) {
      return '';
    }
    if (row.type === 'add') {
      return 'new';
    }
    if (row.type === 'del') {
      return 'old';
    }
    return '';
  }

  // ---------------------------------------------------------------- comment actions

  function startRangeSelection(button, event) {
    const file = state.files[Number(button.getAttribute('data-file-id'))];
    const side = button.getAttribute('data-side');
    const line = Number(button.getAttribute('data-line'));
    if (!file || !side || !line) {
      return;
    }
    event.preventDefault();
    const previous = state.selection;
    state.rangeDrag = {
      fileId: file.id,
      hunkId: Number(button.getAttribute('data-hunk-id')),
      side,
      startLine: line,
      endLine: line,
    };
    state.selection = { ...state.rangeDrag };
    if (previous) {
      rerenderFileById(previous.fileId);
    }
    paintSelection();
  }

  function updateRangeSelectionFromPoint(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    const lineButton = target ? target.closest('[data-line-handle]') : null;
    const drag = state.rangeDrag;
    if (!lineButton || !drag) {
      return;
    }
    const fileId = Number(lineButton.getAttribute('data-file-id'));
    const hunkId = Number(lineButton.getAttribute('data-hunk-id'));
    const side = lineButton.getAttribute('data-side');
    const line = Number(lineButton.getAttribute('data-line'));
    if (fileId !== drag.fileId || hunkId !== drag.hunkId || side !== drag.side || !line || drag.endLine === line) {
      return;
    }
    state.rangeDrag = { ...drag, endLine: line };
    state.selection = { ...state.rangeDrag };
    paintSelection();
  }

  function paintSelection() {
    el.content.querySelectorAll('.selected-line').forEach((node) => node.classList.remove('selected-line'));
    const selection = state.selection;
    if (selection) {
      paintLines(state.files[selection.fileId], selection.side, selection.startLine, selection.endLine, 'selected-line');
    }
  }

  function finishRangeSelection() {
    if (!state.rangeDrag) {
      return;
    }
    const drag = state.rangeDrag;
    state.rangeDrag = null;
    state.selection = {
      ...drag,
      startLine: Math.min(drag.startLine, drag.endLine),
      endLine: Math.max(drag.startLine, drag.endLine),
    };
    rerenderFileById(drag.fileId);
    focusFirst('[data-comment-text]');
  }

  function cancelRangeSelection() {
    if (!state.rangeDrag) {
      return;
    }
    const fileId = state.rangeDrag.fileId;
    state.rangeDrag = null;
    state.selection = null;
    rerenderFileById(fileId);
  }

  async function saveDraftPayload(payload) {
    const drafts = await api(prApi('drafts'), { body: payload });
    setDrafts(drafts);
    return drafts;
  }

  function afterDraftChange() {
    updateCommentsToggle();
    renderFileList();
    refreshReviewPanel();
  }

  async function saveComment(button) {
    const composer = button.closest('.comment-composer');
    const textarea = composer.querySelector('[data-comment-text]');
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }
    const file = state.files[Number(button.getAttribute('data-file-id'))];
    const side = button.getAttribute('data-side');
    button.disabled = true;
    try {
      await saveDraftPayload({
        action: 'add-thread',
        side,
        path: commentPath(file, side),
        startLine: Number(button.getAttribute('data-start-line')),
        endLine: Number(button.getAttribute('data-end-line')),
        text,
      });
    } catch (err) {
      button.disabled = false;
      showComposerError(composer, err.message);
      return;
    }
    state.selection = null;
    rerenderFile(file);
    afterDraftChange();
  }

  async function saveReply(button) {
    const composer = button.closest('.reply-composer');
    const textarea = composer.querySelector('[data-reply-text]');
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }
    const threadId = button.getAttribute('data-parent-id');
    button.disabled = true;
    try {
      await saveDraftPayload({ action: 'add-reply', threadId, text });
    } catch (err) {
      button.disabled = false;
      showComposerError(composer, err.message);
      return;
    }
    state.replyToId = null;
    rerenderForComment(findComment(threadId));
    afterDraftChange();
  }

  async function saveDraftEdit(button) {
    const id = button.getAttribute('data-draft-edit-save');
    const editor = button.closest('.draft-editor');
    const text = editor.querySelector('[data-draft-edit-text]').value.trim();
    if (!text) {
      return;
    }
    try {
      await saveDraftPayload({ action: 'update', id, text });
    } catch (err) {
      showComposerError(editor, err.message);
      return;
    }
    state.editingId = null;
    rerenderForDraft(id);
    afterDraftChange();
  }

  async function deleteDraft(id) {
    const reply = state.drafts.replies.find((item) => item.id === id);
    const anchor = findComment(reply ? reply.threadId : id);
    const file = anchor && isPositioned(anchor) ? fileForComment(anchor) : null;
    try {
      await saveDraftPayload({ action: 'delete', id });
    } catch (err) {
      showToast(`Couldn't delete the draft: ${escapeHtml(err.message)}`, 'error');
      return;
    }
    if (file) {
      rerenderFile(file);
    } else {
      renderContent();
    }
    afterDraftChange();
  }

  async function resolveThread(id, resolved) {
    try {
      await api(prApi('resolve'), { body: { threadId: id, resolved } });
    } catch (err) {
      showToast(`Couldn't ${resolved ? 'resolve' : 'unresolve'} the thread: ${escapeHtml(err.message)}`, 'error');
      return;
    }
    const thread = state.threads.find((item) => item.id === id);
    Object.assign(thread, {
      resolved,
      resolvedBy: resolved ? state.data.viewer : null,
      canResolve: !resolved,
      canUnresolve: resolved,
    });
    state.openComments.delete(id);
    state.closedComments.delete(id);
    refreshComments();
    rerenderForComment(findComment(id));
    renderSummary();
  }

  function showComposerError(composer, message) {
    let error = composer.querySelector('.comment-error');
    if (!error) {
      error = document.createElement('div');
      error.className = 'comment-error';
      composer.appendChild(error);
    }
    error.textContent = message;
  }

  function toggleComment(id) {
    const comment = findComment(id);
    if (!comment) {
      return;
    }
    if (isCommentCollapsed(comment)) {
      state.closedComments.delete(id);
      state.openComments.add(id);
    } else {
      state.openComments.delete(id);
      state.closedComments.add(id);
    }
    rerenderForComment(comment);
  }

  function toggleCommentMarker(id) {
    if (!state.commentsVisible) {
      state.commentsVisible = true;
      updateCommentsToggle();
      state.closedComments.delete(id);
      state.openComments.add(id);
      renderContent();
      return;
    }
    toggleComment(id);
  }

  async function fetchContext(button) {
    const key = button.getAttribute('data-context-key');
    const fileId = Number(button.getAttribute('data-file-id'));
    state.context[key] = { ...(state.context[key] || {}), loading: true, error: '' };
    rerenderFileById(fileId);
    try {
      const params = new URLSearchParams({
        oldPath: button.getAttribute('data-old-path') || '',
        newPath: button.getAttribute('data-new-path') || '',
        oldFrom: button.getAttribute('data-old-from') || '',
        oldTo: button.getAttribute('data-old-to') || '',
        newFrom: button.getAttribute('data-new-from') || '',
        newTo: button.getAttribute('data-new-to') || '',
        newRef: state.refs.newRef,
      });
      if (state.refs.oldRef) {
        params.set('oldRef', state.refs.oldRef);
      } else {
        params.set('base', state.data.pr.baseRefOid);
      }
      const payload = await api(prApi('context', params.toString()));
      const rows = contextRows(payload);
      state.context[key] = {
        ...(state.context[key] || {}),
        loading: false,
        error: rows.length ? '' : 'No extra context found.',
        exhausted: !rows.length,
      };
      const fileState = fileContext(state.files[fileId]);
      rows.forEach((row) => fileState.rows.set(lineKey(row), row));
    } catch (err) {
      state.context[key] = { ...(state.context[key] || {}), loading: false, error: err.message || 'Context request failed.' };
    }
    rerenderFileById(fileId);
  }

  function contextRows(payload) {
    const oldRows = payload.old || [];
    const newRows = payload.new || [];
    const count = Math.max(oldRows.length, newRows.length);
    const rows = [];
    for (let ii = 0; ii < count; ii++) {
      rows.push({ type: 'context-pair', old: oldRows[ii] || null, new: newRows[ii] || null });
    }
    return rows;
  }

  function fileContext(file) {
    if (!state.context[file.id]) {
      state.context[file.id] = { rows: new Map() };
    }
    return state.context[file.id];
  }

  function contextPairSide(row, side) {
    return {
      type: 'context',
      expanded: true,
      oldLine: side === 'old' ? row.line : null,
      newLine: side === 'new' ? row.line : null,
      text: row.text,
    };
  }

  // ---------------------------------------------------------------- patch parsing

  // Hunk headers carry line counts; a hunk ends when both run out, so nothing after it
  // (the patch's trailing newline included) is mistaken for a row.
  function parsePatch(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const files = [];
    let file = null;
    let hunk = null;
    let oldLine = 0;
    let newLine = 0;
    let oldLeft = 0;
    let newLeft = 0;

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        const paths = parseDiffGitLine(line);
        file = newFile(files.length, paths.oldPath, paths.newPath);
        files.push(file);
        hunk = null;
        oldLeft = 0;
        newLeft = 0;
        continue;
      }
      if (!file) {
        continue;
      }
      const hunkMatch = line.match(HUNK_RE);
      if (hunkMatch) {
        oldLine = Number(hunkMatch[1]);
        newLine = Number(hunkMatch[3]);
        oldLeft = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
        newLeft = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
        hunk = { id: file.hunks.length, header: line, rows: [] };
        file.hunks.push(hunk);
        continue;
      }
      if (hunk && (oldLeft > 0 || newLeft > 0)) {
        if (line.startsWith('+')) {
          hunk.rows.push({ type: 'add', oldLine: null, newLine: newLine++, text: line.slice(1) });
          file.additions++;
          newLeft--;
        } else if (line.startsWith('-')) {
          hunk.rows.push({ type: 'del', oldLine: oldLine++, newLine: null, text: line.slice(1) });
          file.deletions++;
          oldLeft--;
        } else if (line.startsWith('\\')) {
          hunk.rows.push({ type: 'meta', oldLine: null, newLine: null, text: line });
        } else {
          hunk.rows.push({ type: 'context', oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
          oldLeft--;
          newLeft--;
        }
        continue;
      }
      if (hunk && line.startsWith('\\')) {
        hunk.rows.push({ type: 'meta', oldLine: null, newLine: null, text: line });
      } else if (!hunk && applyHeaderLine(file, line)) {
        continue;
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.binary = line;
      } else if (line.length && !hunk) {
        file.headers.push(line);
      }
    }
    return files;
  }

  function newFile(id, oldPath, newPath) {
    return { id, oldPath, newPath, headers: [], hunks: [], binary: null, additions: 0, deletions: 0 };
  }

  function intraline(oldText, newText) {
    const prefix = commonPrefix(oldText, newText);
    const suffix = commonSuffix(oldText.slice(prefix), newText.slice(prefix));
    const oldMid = oldText.slice(prefix, oldText.length - suffix);
    const newMid = newText.slice(prefix, newText.length - suffix);
    return {
      left: escapeHtml(oldText.slice(0, prefix)) + mark(oldMid) + escapeHtml(oldText.slice(oldText.length - suffix)),
      right: escapeHtml(newText.slice(0, prefix)) + mark(newMid) + escapeHtml(newText.slice(newText.length - suffix)),
    };
  }

  function commonPrefix(a, b) {
    const end = Math.min(a.length, b.length);
    let ii = 0;
    while (ii < end && a[ii] === b[ii]) {
      ii++;
    }
    return ii;
  }

  function commonSuffix(a, b) {
    const end = Math.min(a.length, b.length);
    let ii = 0;
    while (ii < end && a[a.length - 1 - ii] === b[b.length - 1 - ii]) {
      ii++;
    }
    return ii;
  }

  function mark(text) {
    return text ? `<span class="mark">${escapeHtml(text)}</span>` : '';
  }

  function getFilteredFiles() {
    if (!state.filter) {
      return state.files;
    }
    return state.files.filter((file) => displayPath(file).toLowerCase().includes(state.filter));
  }

  function displayPath(file) {
    if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
      return `${file.oldPath} → ${file.newPath}`;
    }
    return file.newPath || file.oldPath || '(unknown file)';
  }

  function commentPath(file, side) {
    if (!file) {
      return '';
    }
    return side === 'old' ? file.oldPath || file.newPath || '' : file.newPath || file.oldPath || '';
  }

  function gapKey(file, hunk) {
    return `${file.id}:${hunk.id}`;
  }

  function sum(values) {
    return values.reduce((total, value) => total + value, 0);
  }
}());

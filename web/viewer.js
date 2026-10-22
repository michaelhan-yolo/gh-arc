'use strict';

// The diff engine (patch parsing, split/unified tables, context expansion, range selection)
// comes from local-arc (MIT, Emerson Ding). The GitHub layer around it is gh-arc's.
(function () {
  const { api, avatar, checksIcon, diffPath, escapeHtml, homeRepo, onGitHub, prepareLinks, stateBadge, statusChip, statusInfo, statusMark, time } = window.GhArc;
  const { applyHeaderLine, parseDiffGitLine } = window.GhArcPatchPaths;
  const escapeAttr = escapeHtml;
  const LARGE_FILE_LINES = 1500;
  const GENERATED_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|uv\.lock)$|\.min\.(js|css)$|(^|\/)(__generated__|generated)\/|\.snap$/;
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const ACTIVITY_VISIBLE = 12;
  const LONG_SUMMARY_CHARS = 2500;
  // The pull request on screen. Links between pull requests switch it in place (see navigate),
  // so these change without a page load.
  let ROUTE = parseRoute();
  let RANGE = parseRange();
  // Counts page switches; an answer that arrives after its page was left is dropped.
  let pageLoad = 0;

  const state = {
    mode: readPreference('ghArcMode', 'split'),
    commentsVisible: true,
    inbox: null,
    ...pageState(),
  };

  // Everything that belongs to one pull request's page, fresh for each switch.
  function pageState() {
    return {
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
      botsOpen: false,
      submitting: false,
      submitError: '',
      fullContext: false,
      fileNotes: {},
      versionPick: { from: 'base', to: null },
      stackMenuOpen: false,
      versionsMenuOpen: false,
      statusOpen: false,
      statusEdit: { picked: null, more: '', running: null, error: '' },
      ship: { method: null, deleteBranch: null, running: false, progress: {}, errors: {} },
    };
  }

  const el = {
    content: document.getElementById('content'),
    sidebarStack: document.getElementById('sidebar-stack'),
    filesHeading: document.getElementById('files-heading'),
    fileList: document.getElementById('file-list'),
    heading: document.getElementById('pr-heading'),
    subheading: document.getElementById('pr-subheading'),
    filter: document.getElementById('file-filter'),
    split: document.getElementById('mode-split'),
    unified: document.getElementById('mode-unified'),
    commentsToggle: document.getElementById('comments-toggle'),
    reviewJump: document.getElementById('review-jump'),
    statusNav: document.getElementById('status-nav'),
    stackNav: document.getElementById('stack-nav'),
    versionsNav: document.getElementById('versions-nav'),
    resizer: document.getElementById('sidebar-resizer'),
    splitHandle: document.getElementById('sidebar-split'),
    toast: document.getElementById('toast'),
  };

  boot();

  // ---------------------------------------------------------------- data

  function parseRoute() {
    const route = window.GhArcRoutes.parseDiffPath(window.location.pathname, homeRepo);
    const [owner, repo] = route.repo.split('/');
    return { owner, repo, number: route.number };
  }

  function parseRange() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('commit')) {
      return { commit: params.get('commit') };
    }
    const diff = (params.get('diff') || '').split('..');
    if (diff.length === 2 && diff[0] && diff[1]) {
      return { diff: params.get('diff'), from: diff[0], to: diff[1] };
    }
    return null;
  }

  function rangeQuery() {
    if (!RANGE) {
      return '';
    }
    return RANGE.commit ? `commit=${encodeURIComponent(RANGE.commit)}` : `diff=${encodeURIComponent(RANGE.diff)}`;
  }

  function versionsUrl(from, to) {
    const pr = state.data.pr;
    if (from === 'base' && to === pr.headRefOid) {
      return prPath(ROUTE.number);
    }
    return `${prPath(ROUTE.number)}?diff=${from}..${to}`;
  }

  function versionLabel(oid) {
    const version = state.data.pr.versions.find((item) => item.oid === oid);
    return version ? `V${version.number}` : String(oid).slice(0, 7);
  }

  function prApi(action, query) {
    return `/api/pr/${ROUTE.owner}/${ROUTE.repo}/${ROUTE.number}/${action}${query ? `?${query}` : ''}`;
  }

  function prPath(number) {
    return diffPath(`${ROUTE.owner}/${ROUTE.repo}`, number);
  }

  async function boot() {
    bindControls();
    bindNavigation();
    setMode(state.mode, true);
    el.content.innerHTML = '<div class="empty">Loading pull request…</div>';
    loadInbox();
    loadPage(true);
  }

  // Loads the pull request the address bar names. The page on screen stays (dimmed) until the
  // new one's data is in, then everything per pull request starts fresh.
  async function loadPage(initial) {
    const load = ++pageLoad;
    ROUTE = parseRoute();
    RANGE = parseRange();
    const previousStack = state.stack;
    const stackRequest = api(prApi('stack')).catch((err) => ({ error: err.message }));
    el.content.classList.add('is-loading');
    try {
      const [data, patch, threads] = await Promise.all([
        api(prApi('pr')),
        api(prApi('patch', rangeQuery())),
        api(prApi('threads')),
      ]);
      if (load !== pageLoad) {
        return;
      }
      Object.assign(state, pageState(), {
        data,
        refs: { oldRef: patch.oldRef, newRef: patch.newRef || data.pr.headRefOid },
        fullContext: Boolean(patch.fullContext),
        fileNotes: patch.notes || {},
        files: parsePatch(patch.patch),
        stack: stackAround(previousStack, ROUTE.number),
      });
      state.versionPick = initialVersionPick(data.pr);
      applyThreads(threads);
      document.title = `#${data.pr.number} ${data.pr.title}`;
      el.filter.value = '';
      render();
      if (window.location.hash) {
        jumpToHash();
      } else if (!initial) {
        window.scrollTo(0, 0);
      }
    } catch (err) {
      if (load !== pageLoad) {
        return;
      }
      renderFatal(err);
    } finally {
      if (load === pageLoad) {
        el.content.classList.remove('is-loading');
      }
    }
    const stack = await stackRequest;
    if (load !== pageLoad) {
      return;
    }
    state.stack = stack;
    renderStackNav();
    if (state.data) {
      renderSidebar();
      renderStatusNav();
    }
  }

  // While a pull request's own stack loads, the stack it came from still describes it when it
  // is part of that stack, so the stack bar and sidebar hold still.
  function stackAround(stack, number) {
    if (!stack || stack.error || !stack.entries.some((entry) => entry.number === number)) {
      return null;
    }
    const entry = stack.entries.find((item) => item.number === number);
    return {
      ...stack,
      current: number,
      parent: entry.parent,
      children: stack.entries.filter((item) => item.parent === number).map((item) => item.number),
    };
  }

  async function refreshStack() {
    const load = pageLoad;
    const stack = await api(prApi('stack')).catch((err) => ({ error: err.message }));
    if (load !== pageLoad) {
      return;
    }
    state.stack = stack;
    renderStackNav();
    renderSidebar();
    renderStatusNav();
  }

  // Links to another pull request (or another view of this one) switch the page in place.
  function bindNavigation() {
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const link = event.target.closest('a[href]');
      if (!link || link.target === '_blank') {
        return;
      }
      const url = new URL(link.href, window.location.href);
      const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
      if (url.origin !== window.location.origin || (samePage && url.hash) ||
          !window.GhArcRoutes.parseDiffPath(url.pathname, homeRepo)) {
        return;
      }
      event.preventDefault();
      link.classList.add('pending');
      navigate(`${url.pathname}${url.search}${url.hash}`);
    });
    window.addEventListener('popstate', () => loadPage(false));
  }

  function navigate(path) {
    if (!readyToLeave()) {
      return;
    }
    flushReviewBody();
    window.history.pushState(null, '', path);
    loadPage(false);
  }

  function readyToLeave() {
    if (state.ship.running || state.submitting) {
      showToast('Wait for this to finish before leaving.', 'error');
      return false;
    }
    const typing = Array.from(el.content.querySelectorAll('textarea[data-comment-text], textarea[data-reply-text], textarea[data-draft-edit-text]'))
      .some((textarea) => textarea.value.trim());
    return !typing || window.confirm('Leave this pull request? The comment you are writing is not saved.');
  }

  async function loadInbox() {
    try {
      state.inbox = await api('/api/inbox');
    } catch (err) {
      state.inbox = { error: err.message };
    }
    if (state.data) {
      renderSidebar();
    }
  }

  async function reloadAfterSubmit() {
    const load = pageLoad;
    const [data, threads] = await Promise.all([api(prApi('pr')), api(prApi('threads'))]);
    if (load !== pageLoad) {
      return;
    }
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
    bindSidebarSplit();
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
    el.stackNav.addEventListener('click', (event) => {
      if (event.target.closest('[data-stack-menu-toggle]')) {
        setStackMenu(!state.stackMenuOpen);
      }
    });
    el.versionsNav.addEventListener('click', (event) => {
      if (event.target.closest('[data-versions-menu-toggle]')) {
        setVersionsMenu(!state.versionsMenuOpen);
      } else if (event.target.closest('[data-versions-show]')) {
        navigate(versionsUrl(state.versionPick.from, state.versionPick.to));
      } else if (event.target.closest('[data-versions-since]')) {
        navigate(versionsUrl(state.data.pr.lastReviewedOid, state.data.pr.headRefOid));
      }
    });
    el.versionsNav.addEventListener('change', (event) => {
      if (event.target.matches('[data-version-pick]')) {
        state.versionPick[event.target.getAttribute('data-version-pick')] = event.target.value;
        renderVersionsNav();
      }
    });
    el.statusNav.addEventListener('click', (event) => {
      const method = event.target.closest('[data-ship-method]');
      if (event.target.closest('[data-status-toggle]')) {
        setStatusPopover(!state.statusOpen);
      } else if (method) {
        state.ship.method = method.getAttribute('data-ship-method');
        renderStatusNav();
      } else if (event.target.closest('[data-ship-confirm]')) {
        shipStack();
      } else if (event.target.closest('[data-status-change]')) {
        changeStatus(event.target.closest('[data-status-change]').getAttribute('data-status-change'));
      }
    });
    el.statusNav.addEventListener('change', (event) => {
      if (event.target.matches('[data-ship-delete]')) {
        state.ship.deleteBranch = event.target.checked;
      } else if (event.target.matches('[data-status-reviewer]')) {
        const login = event.target.getAttribute('data-status-reviewer');
        const picked = pickedReviewers();
        if (event.target.checked) {
          picked.add(login);
        } else {
          picked.delete(login);
        }
      }
    });
    el.statusNav.addEventListener('input', (event) => {
      if (event.target.matches('[data-status-more]')) {
        state.statusEdit.more = event.target.value;
      }
    });
    el.statusNav.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches('[data-status-more]')) {
        event.preventDefault();
        changeStatus('review');
      }
    });
    document.addEventListener('click', (event) => {
      if (!event.target.isConnected) {
        return;
      }
      if (state.statusOpen && !el.statusNav.contains(event.target)) {
        setStatusPopover(false, false);
      }
      if (state.stackMenuOpen && !el.stackNav.contains(event.target)) {
        setStackMenu(false, false);
      }
      if (state.versionsMenuOpen && !el.versionsNav.contains(event.target)) {
        setVersionsMenu(false, false);
      }
    });
    el.content.addEventListener('click', onContentClick);
    el.content.addEventListener('change', onContentChange);
    el.content.addEventListener('input', onContentInput);
    el.content.addEventListener('keydown', onContentKeydown);
    el.content.addEventListener('toggle', (event) => {
      if (event.target.matches('[data-outdated-details]')) {
        state.outdatedOpen = event.target.open;
      } else if (event.target.matches('[data-bot-details]')) {
        state.botsOpen = event.target.open;
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
    } else if (match('[data-show-bots]')) {
      state.botsOpen = true;
      renderContent();
      document.getElementById('bot-comments').scrollIntoView({ block: 'start' });
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
      const pr = state.data.pr;
      if (value.startsWith('commit:')) {
        navigate(`${prPath(ROUTE.number)}?commit=${value.slice('commit:'.length)}`);
      } else if (value === 'since') {
        navigate(versionsUrl(pr.lastReviewedOid, pr.headRefOid));
      } else if (value === '') {
        navigate(prPath(ROUTE.number));
      }
    }
  }

  let reviewBodyTimer = null;

  // Saves the review summary now if a save is waiting; runs before leaving the page, while the
  // routes still name this pull request.
  function flushReviewBody() {
    if (reviewBodyTimer === null) {
      return;
    }
    window.clearTimeout(reviewBodyTimer);
    reviewBodyTimer = null;
    saveDraftPayload({ action: 'review', body: state.drafts.body }).catch(() => {});
  }

  function onContentInput(event) {
    if (event.target.matches('[data-review-body]')) {
      state.drafts.body = event.target.value;
      window.clearTimeout(reviewBodyTimer);
      reviewBodyTimer = window.setTimeout(flushReviewBody, 600);
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
    if (state.statusOpen && event.key === 'Escape') {
      event.preventDefault();
      setStatusPopover(false);
      return;
    }
    if (state.versionsMenuOpen && event.key === 'Escape') {
      event.preventDefault();
      setVersionsMenu(false);
      return;
    }
    if (state.stackMenuOpen && ['Escape', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') {
        setStackMenu(false);
      } else {
        stepStackMenu(event.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) {
      return;
    }
    if (event.key === 's') {
      event.preventDefault();
      setStackMenu(!state.stackMenuOpen);
    } else if (event.key === 'v' && state.data && state.data.pr.versions.length) {
      event.preventDefault();
      setVersionsMenu(!state.versionsMenuOpen);
    } else if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      stepFile(event.key === 'j' ? 1 : -1);
    } else if (event.key === '[' || event.key === ']') {
      const stack = state.stack;
      const target = stack && !stack.error && (event.key === '[' ? stack.parent : stack.children[0]);
      if (target) {
        navigate(prPath(target));
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

  // The handle between your stacks and the file list; its place is kept as a share of the sidebar.
  function bindSidebarSplit() {
    const sidebar = el.splitHandle.parentElement;
    const DEFAULT_SHARE = 0.66;
    const apply = (share) => {
      sidebar.style.setProperty('--stacks-share', `${(share * 100).toFixed(1)}%`);
      el.splitHandle.setAttribute('aria-valuenow', String(Math.round(share * 100)));
    };
    const save = (share) => {
      apply(share);
      writePreference('ghArcStacksShare', String(share));
    };
    const shareAt = (clientY) => {
      const box = sidebar.getBoundingClientRect();
      const stacks = clamp(clientY - box.top, 80, box.height - 44);
      return stacks / box.height;
    };
    const saved = Number(readPreference('ghArcStacksShare', 0));
    apply(saved > 0 && saved < 1 ? saved : DEFAULT_SHARE);

    let dragging = false;
    el.splitHandle.addEventListener('pointerdown', (event) => {
      dragging = true;
      document.body.classList.add('resizing-split');
      el.splitHandle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    el.splitHandle.addEventListener('pointermove', (event) => {
      if (dragging) {
        save(shareAt(event.clientY));
      }
    });
    const stop = () => {
      dragging = false;
      document.body.classList.remove('resizing-split');
    };
    el.splitHandle.addEventListener('pointerup', stop);
    el.splitHandle.addEventListener('pointercancel', stop);
    el.splitHandle.addEventListener('dblclick', () => save(DEFAULT_SHARE));
    el.splitHandle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return;
      }
      event.preventDefault();
      const box = el.sidebarStack.getBoundingClientRect();
      save(shareAt(box.bottom + (event.key === 'ArrowDown' ? 24 : -24)));
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
    renderVersionsNav();
    renderStatusNav();
    updateCommentsToggle();
    updateReviewJump();
    renderSidebar();
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
    el.subheading.innerHTML = `${escapeHtml(repo.nameWithOwner)} · <code>${escapeHtml(pr.headRefName)}</code> → <code>${escapeHtml(pr.baseRefName)}</code> · <a class="github-link" href="${escapeAttr(onGitHub(pr.url))}">GitHub</a>`;
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
      <div class="stack-nav-group">
        ${parent
          ? `<a class="stack-step" href="${prPath(parent)}" title="Down the stack: #${parent} ( [ )">‹ #${parent}</a>`
          : '<span class="stack-step disabled" title="Bottom of the stack">‹</span>'}
        <button type="button" class="stack-position" data-stack-menu-toggle aria-haspopup="menu" aria-expanded="${state.stackMenuOpen}"
          title="Pick a pull request in this stack (s)">Stack ${position}/${stack.entries.length} <span aria-hidden="true">▾</span></button>
        ${child
          ? `<a class="stack-step" href="${prPath(child)}" title="Up the stack: #${child} ( ] )">#${child} ›</a>`
          : '<span class="stack-step disabled" title="Top of the stack">›</span>'}
      </div>
      ${state.stackMenuOpen ? renderStackMenu() : ''}
    `;
  }

  function renderStackMenu() {
    const stack = state.stack;
    const items = stack.entries.slice().reverse().map((entry) => {
      const current = entry.number === stack.current;
      return `
        <a class="stack-menu-item${current ? ' current' : ''}" role="menuitem" href="${prPath(entry.number)}" style="--lane: ${entry.lane}"${current ? ' aria-current="page"' : ''}>
          <span class="stack-graph" aria-hidden="true"><span class="stack-dot"></span></span>
          <span class="stack-number">#${entry.number}</span>
          <span class="stack-title">${escapeHtml(entry.title)}</span>
          <span class="stack-menu-badges">${statusChip(entry.reviewStatus)}${checksIcon(entry.checks)}</span>
        </a>
      `;
    }).join('');
    return `
      <div class="stack-menu" role="menu" aria-label="Pull requests in this stack">
        ${items}
        <div class="stack-menu-item stack-menu-trunk">
          <span class="stack-graph" aria-hidden="true"><span class="stack-dot"></span></span>
          <code>${escapeHtml(stack.trunk)}</code>
        </div>
      </div>
    `;
  }

  function setStackMenu(open, refocus = true) {
    if (!state.stack || state.stack.error || state.stack.entries.length < 2) {
      return;
    }
    if (open && state.versionsMenuOpen) {
      setVersionsMenu(false, false);
    }
    if (open && state.statusOpen) {
      setStatusPopover(false, false);
    }
    state.stackMenuOpen = open;
    renderStackNav();
    const target = open
      ? el.stackNav.querySelector('.stack-menu-item.current')
      : refocus && el.stackNav.querySelector('[data-stack-menu-toggle]');
    if (target) {
      target.focus();
    }
  }

  function stepStackMenu(direction) {
    const items = Array.from(el.stackNav.querySelectorAll('a.stack-menu-item'));
    const index = items.indexOf(document.activeElement);
    const next = items[Math.max(0, Math.min(items.length - 1, (index === -1 ? 0 : index) + direction))];
    if (next) {
      next.focus();
    }
  }

  function renderSummary() {
    const files = state.files.length;
    const add = sum(state.files.map((file) => file.additions));
    const del = sum(state.files.map((file) => file.deletions));
    const unresolved = state.threads.filter((thread) => !thread.resolved).length;
    const drafts = state.drafts.threads.length + state.drafts.replies.length;
    const viewed = RANGE ? 0 : state.files.filter(isViewed).length;
    const node = document.getElementById('summary');
    if (!node) {
      return;
    }
    node.innerHTML = [
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

  function isOwnPr() {
    return state.data.pr.author.login === state.data.viewer;
  }

  function updateReviewJump() {
    el.reviewJump.hidden = isOwnPr();
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

  // ---------------------------------------------------------------- status and shipping

  const MERGE_BLOCKERS = {
    DIRTY: 'has merge conflicts',
    BEHIND: 'is behind its base; update the branch first',
    BLOCKED: 'is blocked by branch protection (required checks or reviews)',
    UNKNOWN: 'is still being checked by GitHub; reload in a moment',
    DRAFT: 'is a draft',
  };
  const METHOD_LABELS = { MERGE: 'Merge commit', SQUASH: 'Squash', REBASE: 'Rebase' };
  const STATUS_NOTES = {
    UNDER_REVIEW: 'Ship it shows up here once a reviewer accepts.',
    CHANGES_REQUESTED: 'A reviewer asked for changes. Push them, then ask for another look.',
    DRAFT: 'Not ready for review yet.',
    MERGED: 'Shipped.',
    CLOSED: 'Closed without merging.',
  };

  function prApiFor(number, action) {
    return `/api/pr/${ROUTE.owner}/${ROUTE.repo}/${number}/${action}`;
  }

  // What a ship lands: the stack below this pull request, bottom first, then this one.
  function shipPath() {
    const pr = state.data.pr;
    const self = {
      number: pr.number,
      title: pr.title,
      reviewStatus: pr.reviewStatus,
      baseRefName: pr.baseRefName,
      headRefOid: pr.headRefOid,
      mergeStateStatus: pr.mergeStateStatus,
    };
    const stack = state.stack && !state.stack.error ? state.stack : null;
    if (!stack) {
      return [self];
    }
    const byNumber = new Map(stack.entries.map((entry) => [entry.number, entry]));
    const path = [self];
    let parent = byNumber.has(pr.number) ? byNumber.get(pr.number).parent : null;
    while (parent && byNumber.has(parent)) {
      const entry = byNumber.get(parent);
      path.unshift(entry);
      parent = entry.parent;
    }
    return path;
  }

  // Rebasing rewrites the commits the pull requests above depend on, so a stack ships by merge
  // commit or squash.
  function shipMethods(path) {
    return state.data.repo.mergeMethods.filter((method) => path.length === 1 || method !== 'REBASE');
  }

  function currentShipMethod(methods) {
    const preferred = state.ship.method || state.data.repo.defaultMergeMethod;
    return methods.includes(preferred) ? preferred : methods[0];
  }

  function shipState() {
    const { repo } = state.data;
    const path = shipPath();
    const bottom = path[0];
    const base = repo.defaultBranch;
    const children = state.stack && !state.stack.error ? state.stack.children : [];
    const waiting = path.filter((entry) => entry.reviewStatus !== 'ACCEPTED');
    let reason = '';
    if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.viewerPermission)) {
      reason = "You don't have write access to this repository.";
    } else if (!state.stack && bottom.baseRefName !== base) {
      reason = 'Finding the stack below it…';
    } else if (state.stack && state.stack.error && bottom.baseRefName !== base) {
      reason = "Couldn't load the stack below it.";
    } else if (waiting.length) {
      reason = `Waiting on ${waiting.map((entry) => `#${entry.number}`).join(', ')} to be accepted.`;
    } else if (bottom.baseRefName === base && MERGE_BLOCKERS[bottom.mergeStateStatus]) {
      reason = `#${bottom.number} ${MERGE_BLOCKERS[bottom.mergeStateStatus]}.`;
    } else if (!shipMethods(path).length) {
      reason = 'This repository allows no merge method that keeps a stack intact.';
    }
    return { path, ready: !reason, reason, children, base };
  }

  // Under review, changes requested and the rest show as a status button; accepted turns it into
  // Ship it. Either opens the popover with reviewers, checks and, once accepted, the ship plan.
  function renderStatusNav() {
    const pr = state.data.pr;
    const { label, tone } = statusInfo(pr.reviewStatus);
    const ship = pr.reviewStatus === 'ACCEPTED' ? shipState() : null;
    const button = ship
      ? `<button type="button" class="ship-it${ship.ready ? '' : ' blocked'}" data-status-toggle aria-haspopup="dialog"
          aria-expanded="${state.statusOpen}" title="${escapeAttr(ship.ready ? `Ship into ${ship.base}` : `Accepted. ${ship.reason}`)}">Ship it${ship.path.length > 1 ? ` <span class="ship-count">${ship.path.length}</span>` : ''}</button>`
      : `<button type="button" class="status-button status-${tone}" data-status-toggle aria-haspopup="dialog"
          aria-expanded="${state.statusOpen}" title="Review status">${escapeHtml(label)}</button>`;
    el.statusNav.innerHTML = button +
      (state.statusOpen ? `<div class="status-popover" role="dialog" aria-label="Review status">${renderStatusPopover(ship)}</div>` : '');
  }

  function renderStatusPopover(ship) {
    const pr = state.data.pr;
    const checks = pr.checks ? checksSummary(pr.checks) : null;
    return `
      <div class="status-popover-head">${statusChip(pr.reviewStatus)}<span class="muted">#${pr.number} by ${escapeHtml(pr.author.login)}</span></div>
      <dl class="status-facts">
        <dt>Reviewers</dt><dd>${renderReviewers(pr.reviewers)}</dd>
        <dt>Checks</dt><dd>${checks ? `${checksIcon(checks.overall)} ${checks.text || 'None'}` : '<span class="muted">No checks</span>'}</dd>
      </dl>
      ${ship ? renderShipSection(ship) : `<p class="muted status-note">${STATUS_NOTES[pr.reviewStatus] || ''}</p>`}
      ${renderStatusActions()}
    `;
  }

  const STATUS_ACTIONS = {
    review: ['Request review', 'Asking…'],
    ready: ['Ready for review', 'Publishing…'],
    draft: ['Convert to draft', 'Converting…'],
    close: ['Close', 'Closing…'],
    reopen: ['Reopen', 'Reopening…'],
  };

  // The author changes status here, as in Phabricator: ask for review, go back to a draft, close
  // or reopen. Reviewers change it by reviewing.
  function renderStatusActions() {
    const { pr, viewer } = state.data;
    if (pr.author.login !== viewer || pr.merged) {
      return '';
    }
    const { running, error } = state.statusEdit;
    const button = (action, label, primary) => {
      const [idle, busy] = STATUS_ACTIONS[label];
      return `<button type="button"${primary ? ' class="primary-action"' : ''} data-status-change="${action}"${running ? ' disabled' : ''}>${running === action ? busy : idle}</button>`;
    };
    const closed = pr.state === 'CLOSED';
    const buttons = [];
    if (!closed && pr.viewerCanUpdate) {
      buttons.push(button('review', pr.isDraft ? 'ready' : 'review', true));
      if (!pr.isDraft) {
        buttons.push(button('draft', 'draft'));
      }
    }
    if (!closed && pr.viewerCanClose) {
      buttons.push(button('close', 'close'));
    }
    if (closed && pr.viewerCanReopen) {
      buttons.push(button('reopen', 'reopen'));
    }
    if (!buttons.length) {
      return '';
    }
    return `
      <div class="status-actions">
        <div class="status-actions-heading">Change status</div>
        ${!closed && pr.viewerCanUpdate ? renderReviewerPicks() : ''}
        <div class="status-action-buttons">${buttons.join('')}</div>
        ${error ? `<p class="status-error">${escapeHtml(error)}</p>` : ''}
      </div>
    `;
  }

  // Everyone who has reviewed and isn't asked already. Asking one of them again is GitHub's
  // re-request; whoever is blocking starts ticked.
  function reviewCandidates() {
    const pr = state.data.pr;
    const people = new Map();
    pr.reviewers.forEach((reviewer) => {
      if (!reviewer.team) {
        people.set(reviewer.login, reviewer);
      }
    });
    pr.timeline.forEach((item) => {
      if (item.type === 'review' && !people.has(item.author.login)) {
        people.set(item.author.login, { ...item.author, state: 'COMMENTED' });
      }
    });
    return Array.from(people.values())
      .filter((person) => !person.bot && person.state !== 'REQUESTED' && person.login !== pr.author.login);
  }

  function pickedReviewers() {
    if (!state.statusEdit.picked) {
      state.statusEdit.picked = new Set(reviewCandidates()
        .filter((person) => person.state === 'CHANGES_REQUESTED')
        .map((person) => person.login));
    }
    return state.statusEdit.picked;
  }

  function renderReviewerPicks() {
    const picked = pickedReviewers();
    const disabled = state.statusEdit.running ? ' disabled' : '';
    const people = reviewCandidates().map((person) => {
      const [icon, label] = REVIEWER_STATES[person.state] || REVIEWER_STATES.COMMENTED;
      return `
        <label class="reviewer review-pick reviewer-${person.state.toLowerCase()}" title="${escapeAttr(`${person.login}: ${label}`)}">
          <input type="checkbox" data-status-reviewer="${escapeAttr(person.login)}"${picked.has(person.login) ? ' checked' : ''}${disabled}>
          ${avatar(person, 18)}${escapeHtml(person.login)}<span class="reviewer-state" aria-label="${escapeAttr(label)}">${icon}</span>
        </label>
      `;
    }).join('');
    return `
      <div class="review-picks">
        ${people}
        <input type="text" class="review-more" data-status-more value="${escapeAttr(state.statusEdit.more)}"
          placeholder="Add reviewers by login" aria-label="More reviewers, by GitHub login" autocomplete="off" spellcheck="false"${disabled}>
      </div>
    `;
  }

  async function changeStatus(action) {
    const load = pageLoad;
    const pr = state.data.pr;
    const edit = state.statusEdit;
    if (edit.running) {
      return;
    }
    const typed = edit.more.split(/[\s,]+/).map((login) => login.replace(/^@/, '')).filter(Boolean);
    const reviewers = action === 'review' ? Array.from(new Set([...pickedReviewers(), ...typed])) : [];
    if (action === 'review' && !pr.isDraft && !reviewers.length) {
      edit.error = 'Pick someone to ask for a review.';
      renderStatusNav();
      return;
    }
    edit.running = action;
    edit.error = '';
    renderStatusNav();
    try {
      await api(prApi('status'), { body: { action, reviewers } });
    } catch (err) {
      if (load === pageLoad) {
        edit.running = null;
        edit.error = err.message;
        renderStatusNav();
        await refreshAfterChange();
      }
      return;
    }
    if (load !== pageLoad) {
      return;
    }
    const names = reviewers.map(escapeHtml).join(', ');
    const done = {
      review: pr.isDraft
        ? `#${pr.number} is ready for review${names ? `; asked ${names}` : ''}.`
        : `Asked ${names} for a review.`,
      draft: `#${pr.number} is a draft.`,
      close: `Closed #${pr.number}.`,
      reopen: `Reopened #${pr.number}.`,
    };
    showToast(done[action], 'success');
    state.statusEdit = { picked: null, more: '', running: null, error: '' };
    state.statusOpen = false;
    await refreshAfterChange();
  }

  function renderShipSection(ship) {
    const { repo, pr } = state.data;
    const methods = shipMethods(ship.path);
    const method = currentShipMethod(methods);
    const deleteBranch = state.ship.deleteBranch === null ? repo.deleteBranchOnMerge : state.ship.deleteBranch;
    const running = state.ship.running;
    const many = ship.path.length > 1;
    const icons = { running: '◐', done: '✓', failed: '✕' };
    const rows = ship.path.map((entry) => {
      const progress = state.ship.progress[entry.number];
      const error = state.ship.errors[entry.number];
      return `
        <li class="ship-item${progress ? ` ship-${progress}` : ''}">
          <span class="ship-progress" aria-hidden="true">${icons[progress] || '○'}</span>
          ${statusMark(entry.reviewStatus)}
          <a class="side-stack-number" href="${prPath(entry.number)}">#${entry.number}</a>
          <span class="ship-title" title="${escapeAttr(entry.title)}">${escapeHtml(entry.title)}</span>
          ${entry.number === pr.number ? '<span class="muted">this one</span>' : ''}
          ${error ? `<span class="ship-error">${escapeHtml(error)}</span>` : ''}
        </li>
      `;
    }).join('');
    const bottom = ship.path[0];
    const base = `<code>${escapeHtml(ship.base)}</code>`;
    const notes = [
      bottom.baseRefName !== ship.base
        ? `#${bottom.number} sits on <code>${escapeHtml(bottom.baseRefName)}</code>; it moves onto ${base} first if that branch's pull request has merged.`
        : '',
      many ? `Each one moves onto ${base} once the one below it lands.` : '',
      ship.children.length
        ? `Afterwards ${ship.children.map((number) => `#${number}`).join(', ')} ${ship.children.length === 1 ? 'moves' : 'move'} onto ${base}.`
        : '',
    ].filter(Boolean);
    return `
      <div class="ship-section">
        <div class="ship-heading">Ship ${many ? `${ship.path.length} pull requests, bottom first,` : `#${pr.number}`} into ${base}</div>
        <ol class="ship-list">${rows}</ol>
        ${notes.length ? `<p class="muted ship-notes">${notes.join(' ')}</p>` : ''}
        <div class="ship-options">
          <div class="segmented" role="radiogroup" aria-label="Merge method">
            ${methods.map((value) => `<button type="button" role="radio" class="seg${value === method ? ' active' : ''}" data-ship-method="${value}"
              aria-checked="${value === method}"${running ? ' disabled' : ''}>${METHOD_LABELS[value]}</button>`).join('')}
          </div>
          ${pr.fromFork ? '' : `<label class="ship-delete"><input type="checkbox" data-ship-delete${deleteBranch ? ' checked' : ''}${running ? ' disabled' : ''}> Delete ${many ? 'each branch' : 'the branch'} once it ships</label>`}
        </div>
        ${ship.reason ? `<p class="ship-blocked">${escapeHtml(ship.reason)}</p>` : ''}
        <div class="ship-actions">
          <button type="button" class="ship-it" data-ship-confirm${ship.ready && !running ? '' : ' disabled'}>${running
            ? 'Shipping…'
            : `Ship ${many ? `all ${ship.path.length}` : `#${pr.number}`} into ${escapeHtml(ship.base)}`}</button>
        </div>
      </div>
    `;
  }

  function setStatusPopover(open, refocus = true) {
    if (!open && state.ship.running) {
      return;
    }
    if (open) {
      setStackMenu(false, false);
      if (state.versionsMenuOpen) {
        setVersionsMenu(false, false);
      }
    }
    state.statusOpen = open;
    renderStatusNav();
    const target = el.statusNav.querySelector(open ? '[data-ship-confirm]:not([disabled]), .status-popover' : '[data-status-toggle]');
    if (target && (open || refocus)) {
      target.focus();
    }
  }

  // Lands the plan bottom first: each pull request moves onto the default branch (the server
  // allows that only once the one below has merged) and merges; the first failure stops it.
  async function shipStack() {
    const ship = shipState();
    if (!ship.ready || state.ship.running) {
      return;
    }
    const { repo } = state.data;
    const method = currentShipMethod(shipMethods(ship.path));
    const deleteBranch = state.ship.deleteBranch === null ? repo.deleteBranchOnMerge : state.ship.deleteBranch;
    state.ship = { ...state.ship, running: true, progress: {}, errors: {} };
    renderStatusNav();
    const shipped = [];
    for (const entry of ship.path) {
      state.ship.progress[entry.number] = 'running';
      renderStatusNav();
      try {
        if (entry.baseRefName !== ship.base) {
          await api(prApiFor(entry.number, 'retarget'), { body: {} });
        }
        await api(prApiFor(entry.number, 'merge'), { body: { method, deleteBranch, expectedHeadOid: entry.headRefOid } });
        state.ship.progress[entry.number] = 'done';
        shipped.push(entry.number);
      } catch (err) {
        state.ship.progress[entry.number] = 'failed';
        state.ship.errors[entry.number] = err.message;
        break;
      }
    }
    const complete = shipped.length === ship.path.length;
    if (complete) {
      await Promise.all(ship.children.map((number) => api(prApiFor(number, 'retarget'), { body: {} }).catch(() => null)));
    }
    state.ship.running = false;
    if (shipped.length) {
      const list = shipped.map((number) => `#${number}`).join(', ');
      showToast(complete ? `Shipped ${list} into ${escapeHtml(ship.base)}.` : `Shipped ${list}; the next one failed.`, complete ? 'success' : 'error');
    }
    if (complete) {
      state.statusOpen = false;
    }
    await refreshAfterChange();
  }

  async function refreshAfterChange() {
    const load = pageLoad;
    try {
      const data = await api(prApi('pr'));
      if (load !== pageLoad) {
        return;
      }
      state.data = data;
    } catch (err) {
      showToast(`Couldn't reload the pull request: ${escapeHtml(err.message)}`, 'error');
    }
    state.stack = null;
    renderStatusNav();
    await Promise.all([refreshStack(), loadInbox()]);
    render();
  }

  // ---------------------------------------------------------------- sidebar

  // The sidebar's top panel lists your open stacks, one row each, named by the bottom pull
  // request it opens; pull requests outside any stack are left out. The stack on screen is
  // highlighted with your place in it, under "Viewing" when it isn't yours. Its pull requests are
  // in the top bar's stack menu. The bottom panel holds this pull request's files.
  function renderSidebar() {
    const stacks = sidebarStacks();
    const current = stacks.find((stack) => stack.current) || null;
    const mine = stacks.filter((stack) => stack.mine);
    let note = '';
    if (!state.inbox) {
      note = '<div class="muted side-stack-note">Finding your stacks…</div>';
    } else if (state.inbox.error) {
      note = `<div class="muted side-stack-note">Couldn't load your stacks: ${escapeHtml(state.inbox.error)}</div>`;
    } else if (!mine.length) {
      note = '<div class="muted side-stack-note">No open stacks.</div>';
    }
    const heading = (label, count) =>
      `<div class="side-stack-heading metadata-section-title"><span>${label}</span>${count ? `<span class="section-count">${count}</span>` : ''}</div>`;
    const viewing = current && !current.mine ? heading('Viewing') + renderStackEntry(current) : '';
    el.sidebarStack.innerHTML = viewing + heading('Your stacks', mine.length) + mine.map(renderStackEntry).join('') + note;
    revealCurrentStackRow();
    el.filesHeading.innerHTML = `<span>Files in #${ROUTE.number}</span><span class="section-count">${state.files.length}</span>`;
    renderSummary();
    renderFileList();
  }

  // Scrolls the stacks panel, not the page, to keep the stack on screen in view.
  function revealCurrentStackRow() {
    const row = el.sidebarStack.querySelector('.side-stack-entry.current');
    if (!row) {
      return;
    }
    const panel = el.sidebarStack.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top < panel.top) {
      el.sidebarStack.scrollTop -= panel.top - box.top + 8;
    } else if (box.bottom > panel.bottom) {
      el.sidebarStack.scrollTop += box.bottom - panel.bottom + 8;
    }
  }

  // Stacks of two or more, each top first: the one on screen (from the stack lookup) and your
  // others (from the inbox), without listing one twice.
  function sidebarStacks() {
    const pr = state.data.pr;
    const repo = `${ROUTE.owner}/${ROUTE.repo}`;
    const stack = state.stack && !state.stack.error ? state.stack : null;
    const section = state.inbox && !state.inbox.error
      ? state.inbox.sections.find((item) => item.key === 'mine')
      : null;
    const groups = section ? section.groups : [];
    const listed = groups.find((group) => group.repo === repo && group.items.some((item) => item.pr.number === pr.number));
    const items = stack ? stack.entries.slice().reverse() : listed ? listed.items.map((item) => item.pr) : [];
    const numbers = new Set(items.map((item) => item.number).concat(pr.number));
    const overlaps = (group) => group.repo === repo && group.items.some((item) => numbers.has(item.pr.number));
    const current = {
      repo,
      items,
      current: true,
      mine: pr.author.login === state.data.viewer || groups.some(overlaps),
    };
    return [current].concat(groups.filter((group) => !overlaps(group)).map((group) => ({
      repo: group.repo,
      items: group.items.map((item) => item.pr),
      current: false,
      mine: true,
    }))).filter((entry) => entry.items.length > 1);
  }

  // One glyph for the stack as a whole: accepted when every pull request is, blocked when any
  // has changes requested.
  function stackStatus(items) {
    if (items.some((item) => item.reviewStatus === 'CHANGES_REQUESTED')) {
      return statusMark('CHANGES_REQUESTED');
    }
    return items.every((item) => item.reviewStatus === 'ACCEPTED' || item.reviewStatus === 'MERGED')
      ? statusMark('ACCEPTED')
      : '';
  }

  function renderStackEntry(stack) {
    const bottom = stack.items[stack.items.length - 1];
    const repoName = stack.repo === `${ROUTE.owner}/${ROUTE.repo}` ? '' : `<span class="side-group-repo">${escapeHtml(stack.repo.split('/')[1])}</span>`;
    const position = stack.items.length - stack.items.findIndex((item) => item.number === ROUTE.number);
    const count = stack.current ? `${position}/${stack.items.length}` : String(stack.items.length);
    const body = `
      <span class="side-stack-dot" aria-hidden="true"></span>
      <span class="side-group-label">${escapeHtml(bottom.title)}</span>
      ${repoName}
      ${stackStatus(stack.items)}
      <span class="side-group-count">${count}</span>
    `;
    if (stack.current) {
      return `<div class="side-stack-entry current" aria-current="true" title="${escapeAttr(`You're on #${ROUTE.number}, ${position} of ${stack.items.length} from the bottom`)}">${body}</div>`;
    }
    return `<a class="side-stack-entry" href="${escapeAttr(diffPath(stack.repo, bottom.number))}"
      title="${escapeAttr(`Stack of ${stack.items.length}; opens #${bottom.number} at the bottom`)}">${body}</a>`;
  }

  function renderFileList() {
    const node = document.getElementById('file-list');
    if (!node) {
      return;
    }
    const filtered = getFilteredFiles();
    node.innerHTML = filtered.length
      ? renderTreeChildren(buildFileTree(filtered), 0)
      : '<div class="muted">No matching files.</div>';
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
      (ordered.length ? ordered.map(renderFile).join('') : renderNoChanges()) +
      renderBotComments() +
      renderReviewPanel();
    prepareLinks(el.content);
    restoreComposers(saved);
    applyActiveHighlight();
  }

  function renderNoChanges() {
    if (state.filter) {
      return '<div class="empty">No files match the filter.</div>';
    }
    if (RANGE && RANGE.diff && RANGE.from !== 'base') {
      return `<div class="empty">${escapeHtml(versionLabel(RANGE.from))} and ${escapeHtml(versionLabel(RANGE.to))} differ only by what was merged in from the base.</div>`;
    }
    return '<div class="empty">No changes to show.</div>';
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
          <a class="external-link" href="${escapeAttr(onGitHub(pr.url))}" target="_blank" rel="noreferrer noopener">Open on GitHub ↗</a>
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
          ${renderSummarySection(pr)}
          ${renderDiscussion(pr)}
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

  const REVIEWER_STATES = {
    APPROVED: ['✓', 'Accepted'],
    CHANGES_REQUESTED: ['✕', 'Requested changes'],
    COMMENTED: ['…', 'Commented'],
    DISMISSED: ['–', 'Dismissed'],
    REQUESTED: ['◦', 'Review requested'],
  };

  function renderReviewers(reviewers) {
    if (!reviewers.length) {
      return '<span class="muted">None</span>';
    }
    return `<span class="reviewer-list">${reviewers.map((reviewer) => {
      const [icon, label] = REVIEWER_STATES[reviewer.state] || REVIEWER_STATES.REQUESTED;
      return `<span class="reviewer reviewer-${reviewer.state.toLowerCase()}" title="${escapeAttr(`${reviewer.login}: ${label}`)}">
        ${reviewer.team ? '<span class="team-icon" aria-hidden="true">👥</span>' : avatar(reviewer, 18)}
        ${escapeHtml(reviewer.login)}<span class="reviewer-state" aria-label="${escapeAttr(label)}">${icon}</span>
      </span>`;
    }).join('')}</span>`;
  }

  function renderStatus(pr) {
    const parts = [statusChip(pr.reviewStatus)];
    if (pr.reviewStatus === 'ACCEPTED') {
      const ship = shipState();
      parts.push(ship.ready
        ? `<span class="muted">Ready to ship${ship.path.length > 1 ? ` with the ${ship.path.length - 1} below it` : ''}</span>`
        : `<span class="muted">${escapeHtml(ship.reason)}</span>`);
    }
    if (pr.mergeable === 'CONFLICTING') {
      parts.push('<span class="status-chip status-changes">Merge conflicts</span>');
    }
    parts.push(`<span class="muted"><span class="add">+${pr.additions}</span> <span class="del">-${pr.deletions}</span> in ${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'} · ${pr.totalCommits} commit${pr.totalCommits === 1 ? '' : 's'}</span>`);
    return parts.join(' ');
  }

  function checksSummary(checks) {
    const counts = { SUCCESS: 0, FAILURE: 0, PENDING: 0, NEUTRAL: 0, CANCELLED: 0 };
    checks.contexts.forEach((item) => {
      counts[item.state] = (counts[item.state] || 0) + 1;
    });
    const text = [
      counts.FAILURE ? `<span class="del">${counts.FAILURE} failed</span>` : '',
      counts.PENDING ? `${counts.PENDING} running` : '',
      counts.SUCCESS ? `${counts.SUCCESS} passed` : '',
      counts.CANCELLED ? `${counts.CANCELLED} cancelled` : '',
      counts.NEUTRAL ? `${counts.NEUTRAL} skipped` : '',
    ].filter(Boolean).join(' · ');
    const overall = ['FAILURE', 'PENDING', 'CANCELLED', 'SUCCESS', 'NEUTRAL'].find((key) => counts[key]) || checks.state;
    return { counts, text, overall };
  }

  function renderChecks(checks) {
    if (!checks) {
      return '<span class="muted">No checks</span>';
    }
    const { counts, text: summary, overall } = checksSummary(checks);
    const order = { FAILURE: 0, PENDING: 1, SUCCESS: 2, CANCELLED: 3, NEUTRAL: 4 };
    const items = checks.contexts.slice().sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
    const more = checks.total > checks.contexts.length
      ? `<li class="muted">${checks.total - checks.contexts.length} more on GitHub</li>`
      : '';
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
      current = RANGE.from === pr.lastReviewedOid && RANGE.to === pr.headRefOid ? 'since' : 'versions';
    }
    const options = ['<option value="">All changes</option>'];
    if (pr.lastReviewedOid && pr.lastReviewedOid !== pr.headRefOid) {
      options.push(`<option value="since">Since your last review (${escapeHtml(versionLabel(pr.lastReviewedOid))})</option>`);
    }
    if (current === 'versions') {
      const from = RANGE.from === 'base' ? 'base' : versionLabel(RANGE.from);
      options.push(`<option value="versions">${escapeHtml(from)} → ${escapeHtml(versionLabel(RANGE.to))}</option>`);
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
    const version = (oid) => `${escapeHtml(versionLabel(oid))} (<code>${escapeHtml(oid.slice(0, 7))}</code>)`;
    let label;
    let note = '';
    if (RANGE.commit) {
      const commit = pr.commits.find((item) => item.oid === RANGE.commit);
      label = `the changes in commit <code>${escapeHtml(RANGE.commit.slice(0, 7))}</code>${commit ? ` · ${escapeHtml(commit.headline)}` : ''}`;
    } else if (RANGE.from === 'base') {
      label = `the pull request as of ${version(RANGE.to)}, against its base`;
    } else {
      const since = RANGE.from === pr.lastReviewedOid ? ', since your last review' : '';
      label = `what changed from ${version(RANGE.from)} to ${version(RANGE.to)}${since}`;
      const mixed = Object.values(state.fileNotes).filter((value) => value === 'mixed').length;
      note = ' Changes merged in from the base in between are left out' +
        (mixed ? `, except in ${mixed} file${mixed === 1 ? '' : 's'} where they touch the same lines.` : '.');
    }
    const commenting = headView()
      ? ' You can comment on the right side.'
      : ' Comments are read-only in this view.';
    return `
      <div class="range-banner">
        Showing ${label}.${note}${commenting}
        <a href="${prPath(ROUTE.number)}">Back to all changes</a>
      </div>
    `;
  }

  function initialVersionPick(pr) {
    if (RANGE && RANGE.diff) {
      return { from: RANGE.from, to: RANGE.to };
    }
    return { from: 'base', to: pr.headRefOid };
  }

  function viewLabel() {
    const pr = state.data.pr;
    if (RANGE && RANGE.commit) {
      return `Commit ${RANGE.commit.slice(0, 7)}`;
    }
    if (RANGE) {
      return `${RANGE.from === 'base' ? 'Base' : versionLabel(RANGE.from)} → ${versionLabel(RANGE.to)}`;
    }
    return `Base → ${pr.versions.length ? `V${pr.versions.length}` : 'head'}`;
  }

  // The top-bar button names the changes on screen and opens the version picker.
  function renderVersionsNav() {
    const pr = state.data && state.data.pr;
    if (!pr || !pr.versions.length) {
      el.versionsNav.hidden = true;
      return;
    }
    const wrap = el.versionsNav.querySelector('.versions-wrap');
    const scrollTop = wrap ? wrap.scrollTop : null;
    const focused = el.versionsNav.contains(document.activeElement) && document.activeElement.matches('[data-version-pick]')
      ? `[data-version-pick="${document.activeElement.getAttribute('data-version-pick')}"][value="${CSS.escape(document.activeElement.value)}"]`
      : null;
    el.versionsNav.hidden = false;
    el.versionsNav.innerHTML = `
      <button type="button" class="versions-toggle${RANGE ? ' is-range' : ''}" data-versions-menu-toggle aria-haspopup="dialog"
        aria-expanded="${state.versionsMenuOpen}" title="Compare versions of this pull request (v)">
        <span class="versions-toggle-caption">Versions</span>
        <span class="versions-toggle-label">${escapeHtml(viewLabel())}</span>
        <span aria-hidden="true">▾</span>
      </button>
      ${state.versionsMenuOpen ? `<div class="versions-menu" role="dialog" aria-label="Compare versions">${renderVersionsPicker()}</div>` : ''}
    `;
    const fresh = el.versionsNav.querySelector('.versions-wrap');
    if (fresh && scrollTop !== null) {
      fresh.scrollTop = scrollTop;
    }
    const refocus = focused && el.versionsNav.querySelector(focused);
    if (refocus) {
      refocus.focus();
    }
  }

  function setVersionsMenu(open, refocus = true) {
    if (open && state.stackMenuOpen) {
      setStackMenu(false, false);
    }
    if (open && state.statusOpen) {
      setStatusPopover(false, false);
    }
    state.versionsMenuOpen = open;
    renderVersionsNav();
    if (open) {
      revealVersionPick();
      const checked = el.versionsNav.querySelector('[data-version-pick="to"]:checked');
      if (checked) {
        checked.focus();
      }
    } else if (refocus) {
      el.versionsNav.querySelector('[data-versions-menu-toggle]').focus();
    }
  }

  // The newest versions sit at the bottom of a scrolling table; bring the picked one into view.
  function revealVersionPick() {
    const wrap = el.versionsNav.querySelector('.versions-wrap');
    const row = wrap && wrap.querySelector('tr.is-to');
    if (!row) {
      return;
    }
    const overflow = row.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom;
    if (overflow > 0) {
      wrap.scrollTop += overflow + 4;
    }
  }

  // Phabricator's update history: pick an old and a new version and compare them.
  function renderVersionsPicker() {
    const pr = state.data.pr;
    const versions = pr.versions;
    const pick = state.versionPick;
    const order = (oid) => (oid === 'base' ? 0 : versions.findIndex((item) => item.oid === oid) + 1);
    const fromOrder = order(pick.from);
    const toOrder = order(pick.to);
    const shown = RANGE && RANGE.diff ? `${RANGE.from}..${RANGE.to}` : `base..${pr.headRefOid}`;
    const picked = `${pick.from}..${pick.to}`;
    const radio = (name, value, rowOrder) => {
      const disabled = name === 'from' ? rowOrder >= toOrder : rowOrder <= fromOrder;
      const checked = name === 'from' ? pick.from === value : pick.to === value;
      return `<input type="radio" name="version-${name}" value="${escapeAttr(value)}" data-version-pick="${name}"
        aria-label="${name === 'from' ? 'Old' : 'New'}"${checked ? ' checked' : ''}${disabled && !checked ? ' disabled' : ''}>`;
    };
    const rows = versions.map((version, index) => {
      const badges = [
        index === versions.length - 1 ? '<span class="pill">latest</span>' : '',
        version.forcePushed ? '<span class="pill" title="Replaced by a force push">force-pushed</span>' : '',
        version.reviewedByYou ? '<span class="pill pill-reviewed">you reviewed</span>' : '',
      ].join('');
      return `
        <tr class="${order(version.oid) === fromOrder ? 'is-from' : ''}${order(version.oid) === toOrder ? ' is-to' : ''}">
          <td class="version-radio">${radio('from', version.oid, index + 1)}</td>
          <td class="version-radio">${radio('to', version.oid, index + 1)}</td>
          <td class="version-name">V${version.number}${badges}</td>
          <td><a class="version-commit" href="https://github.com/${ROUTE.owner}/${ROUTE.repo}/commit/${escapeAttr(version.oid)}" target="_blank" rel="noreferrer noopener">${escapeHtml(version.short)}</a></td>
          <td class="version-date">${time(version.date)}</td>
          <td class="version-headline" title="${escapeAttr(version.headline)}">${version.isMerge ? '<span class="pill">merge</span>' : ''}${escapeHtml(version.headline)}</td>
        </tr>
      `;
    }).join('');
    const since = pr.lastReviewedOid && pr.lastReviewedOid !== pr.headRefOid
      ? `<button type="button" data-versions-since>Since your last review (${escapeHtml(versionLabel(pr.lastReviewedOid))} → V${versions.length})</button>`
      : '';
    return `
        <div class="versions-menu-head">
          <div class="metadata-section-title"><span>Versions</span><span class="section-count">${versions.length}, one per push</span></div>
          ${since}
        </div>
        <div class="versions-wrap">
          <table class="versions-table">
            <thead><tr><th>Old</th><th>New</th><th>Version</th><th>Commit</th><th>Pushed</th><th>Last commit</th></tr></thead>
            <tbody>
              <tr class="${fromOrder === 0 ? 'is-from' : ''}">
                <td class="version-radio">${radio('from', 'base', 0)}</td>
                <td class="version-radio"></td>
                <td class="version-name">Base</td>
                <td colspan="3" class="muted">The base branch, <code>${escapeHtml(pr.baseRefName)}</code></td>
              </tr>
              ${rows}
            </tbody>
          </table>
        </div>
        <div class="versions-actions">
          <button type="button" class="primary-action" data-versions-show${picked === shown ? ' disabled' : ''}>Compare ${escapeHtml(pick.from === 'base' ? 'Base' : versionLabel(pick.from))} → ${escapeHtml(versionLabel(pick.to))}</button>
          <span class="muted">Comparing two versions leaves out what was merged in from the base between them.</span>
        </div>
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

  // What people said, oldest first, before the code: comments, reviews, and every inline review
  // comment with the line it is on. Bots (Linear, github-actions, Graphite) go after the code.
  function renderDiscussion(pr) {
    const threads = state.threads
      .filter((thread) => thread.comments.length && !thread.comments[0].author.bot)
      .map((thread) => ({ type: 'thread', thread, createdAt: thread.comments[0].createdAt }));
    const items = pr.timeline.filter((item) => !item.author.bot).concat(threads)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    const bots = pr.timeline.filter((item) => item.author.bot).length;
    if (!items.length && !bots) {
      return '';
    }
    const hidden = state.showAllActivity ? 0 : Math.max(0, items.length - ACTIVITY_VISIBLE);
    const botNote = bots
      ? `<button type="button" class="link-button bot-note" data-show-bots>${bots} bot comment${bots === 1 ? '' : 's'} after the code</button>`
      : '';
    return `
      <div class="metadata-section metadata-activity" id="discussion">
        <div class="metadata-section-heading">
          <div class="metadata-section-title"><span>Discussion</span><span class="section-count">${items.length}</span></div>
          ${botNote}
        </div>
        ${items.length ? '' : '<p class="muted discussion-empty">No one has commented yet.</p>'}
        ${hidden ? `<button type="button" class="link-button activity-more" data-activity-more>Show ${hidden} earlier</button>` : ''}
        <ol class="activity-list">${items.slice(hidden).map((item) => (item.type === 'thread' ? renderDiscussionThread(item.thread) : renderActivityItem(item))).join('')}</ol>
      </div>
    `;
  }

  function renderDiscussionThread(thread) {
    const [first, ...replies] = thread.comments;
    const where = thread.fileLevel ? thread.githubPath : `${thread.githubPath}:${thread.endLine}`;
    const last = replies[replies.length - 1];
    const replyNote = replies.length
      ? `<a href="#" class="thread-replies-note" data-jump-comment="${escapeAttr(thread.id)}">${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}, last from ${escapeHtml(last.author.login)}</a>`
      : '';
    return `
      <li>
        <article class="activity-card thread-card${thread.resolved ? ' resolved' : ''}">
          ${avatar(first.author, 28)}
          <div class="activity-main">
            <header class="activity-card-header">
              <div class="activity-headline">
                <span class="activity-user">${escapeHtml(first.author.login)}</span>
                <span class="activity-action">commented on</span>
                <a href="#" class="activity-file" data-jump-comment="${escapeAttr(thread.id)}" title="Show it in the code">${escapeHtml(where)}</a>
                ${thread.resolved ? '<span class="pill pill-resolved">Resolved</span>' : ''}
                ${thread.outdated ? '<span class="pill">Outdated</span>' : ''}
              </div>
              <a class="activity-time" href="${escapeAttr(onGitHub(first.url))}" target="_blank" rel="noreferrer noopener">${time(first.createdAt)}</a>
            </header>
            ${thread.diffHunk ? renderDiffHunk(thread.diffHunk, 3) : ''}
            <div class="markdown-body activity-body">${first.bodyHTML}</div>
            ${replyNote}
          </div>
        </article>
      </li>
    `;
  }

  function renderBotComments() {
    const items = state.data.pr.timeline.filter((item) => item.author.bot);
    if (!items.length) {
      return '';
    }
    const names = Array.from(new Set(items.map((item) => item.author.login))).join(', ');
    return `
      <section class="bot-comments" id="bot-comments">
        <details data-bot-details${state.botsOpen ? ' open' : ''}>
          <summary><span class="metadata-section-title"><span>Bot comments</span><span class="section-count">${items.length} · ${escapeHtml(names)}</span></span></summary>
          <ol class="activity-list">${items.map(renderActivityItem).join('')}</ol>
        </details>
      </section>
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
              <a class="activity-time" href="${escapeAttr(onGitHub(item.url))}" target="_blank" rel="noreferrer noopener">${time(item.createdAt)}</a>
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

  function renderDiffHunk(hunk, count = 6) {
    const lines = hunk.split('\n').filter((line) => !line.startsWith('@@')).slice(-count);
    return `<pre class="outdated-hunk">${lines.map((line) => {
      const tone = line.startsWith('+') ? 'new' : line.startsWith('-') ? 'old' : '';
      return `<span class="${tone}">${escapeHtml(line)}</span>`;
    }).join('\n')}</pre>`;
  }

  // ---------------------------------------------------------------- review panel

  // On your own pull request there is nothing to accept or block, so the panel only posts comments.
  function renderReviewPanel() {
    const { pr } = state.data;
    const own = isOwnPr();
    const drafts = state.drafts.threads.concat(state.drafts.replies);
    const event = state.drafts.event;
    const events = [
      ['COMMENT', 'Comment'],
      ['APPROVE', 'Accept'],
      ['REQUEST_CHANGES', 'Request changes'],
    ];
    const closed = pr.state === 'MERGED' || pr.state === 'CLOSED';
    const submitLabel = own ? 'Post comments' : 'Submit review';
    return `
      <section class="review-panel" id="review-panel" aria-label="${own ? 'Post comments' : 'Submit review'}">
        <div class="metadata-header">
          <span>${own ? 'Comments' : 'Review'}</span>
          <span class="muted">${drafts.length ? `${drafts.length} unsubmitted inline comment${drafts.length === 1 ? '' : 's'}` : 'No inline comments yet'}</span>
        </div>
        <div class="review-body">
          ${pr.hasPendingReview ? '<p class="review-note">Your pending review on GitHub goes out with this one.</p>' : ''}
          ${drafts.length ? `<ul class="draft-summary">${drafts.map(renderDraftSummary).join('')}</ul>` : ''}
          <textarea data-review-body data-composer-key="review-body" rows="4"
            placeholder="${own ? 'Reply to your reviewers (Markdown). Inline replies stay drafts until you post them.' : 'Leave a summary (Markdown). Inline comments stay drafts until you submit.'}">${escapeHtml(state.drafts.body)}</textarea>
          <div class="review-actions">
            ${own ? '' : `<div class="segmented review-events" role="radiogroup" aria-label="Review action">
              ${events.map(([value, label]) => `
                <button type="button" role="radio" class="seg${event === value ? ' active' : ''}" data-review-event="${value}"
                  aria-checked="${event === value}">${label}</button>
              `).join('')}
            </div>`}
            <span class="review-error" role="alert">${escapeHtml(state.submitError)}</span>
            <button type="button" class="primary-action" data-review-submit${state.submitting || closed ? ' disabled' : ''}>
              ${state.submitting ? 'Posting…' : submitLabel}
            </button>
          </div>
          <div class="muted review-hint">⌘/Ctrl+Enter saves or submits · j/k next and previous file · [ and ] down and up the stack · s picks from the stack · v compares versions</div>
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
        body: { event: isOwnPr() ? 'COMMENT' : state.drafts.event, body: state.drafts.body },
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
      showToast(`${labels[result.review.state] || 'Review submitted'}. <a href="${escapeAttr(onGitHub(result.review.url))}" target="_blank" rel="noreferrer noopener">View on GitHub</a>`, 'success');
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
    const note = state.fileNotes[file.newPath || file.oldPath];
    if (note === 'mixed') {
      return '<span class="file-status mixed" title="Base changes merged in between the versions touch the same lines as this pull request, so they are shown here too">Includes base changes</span>';
    }
    if (note === 'rebased') {
      return '<span class="file-status rebased" title="Base changes merged in between the versions are left out of this file">Base changes left out</span>';
    }
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
    const load = pageLoad;
    try {
      await api(prApi('viewed'), { body: { path, viewed } });
    } catch (err) {
      if (load !== pageLoad) {
        return;
      }
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
      actions.push(`<a class="icon-link" href="${escapeAttr(onGitHub(first.url))}" target="_blank" rel="noreferrer noopener" title="Open on GitHub">↗</a>`);
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
          <a class="muted" href="${escapeAttr(onGitHub(comment.url))}" target="_blank" rel="noreferrer noopener">${time(comment.createdAt)}</a>
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
    if (file.binary || state.fullContext) {
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
    const load = pageLoad;
    const drafts = await api(prApi('drafts'), { body: payload });
    if (load === pageLoad) {
      setDrafts(drafts);
    }
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
    const load = pageLoad;
    try {
      await api(prApi('resolve'), { body: { threadId: id, resolved } });
      if (load !== pageLoad) {
        return;
      }
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
    const load = pageLoad;
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
      if (load !== pageLoad) {
        return;
      }
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
      if (load !== pageLoad) {
        return;
      }
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

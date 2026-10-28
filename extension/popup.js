'use strict';

(async function () {
  const T = window.GhArcTakeover;
  const $ = (id) => document.getElementById(id);
  let settings = T.withDefaults(await chrome.storage.sync.get(null));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pull = await tabPull(tab);

  $('enabled').checked = settings.enabled;
  $('server').value = settings.server;
  if (pull) {
    $('pull').hidden = false;
    $('repo-name').textContent = `${pull.owner}/${pull.repo}`;
    $('pull-name').textContent = `#${pull.number}`;
    $('repo-enabled').checked = T.takesOver({ ...settings, enabled: true }, pull);
  }
  showStatus();

  $('enabled').addEventListener('change', () => save({ enabled: $('enabled').checked }));
  $('repo-enabled').addEventListener('change', () => {
    save({ disabledRepos: T.setRepo(settings, pull, $('repo-enabled').checked) });
  });
  $('open').addEventListener('click', async () => {
    const found = await chrome.tabs.sendMessage(tab.id, { type: 'open' }).catch(() => null);
    if (found && found.base) {
      window.close();
    } else {
      say(`Phabricade isn't running at ${settings.server}. Start it with gh arc serve.`);
    }
  });
  $('server-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const server = T.normalizeServer($('server').value);
    if (!server) {
      say('Use http://localhost:<port>, http://127.0.0.1:<port> or http://diffs.');
      return;
    }
    $('server').value = server;
    await save({ server });
    showStatus();
  });

  // The pull request the active tab shows on GitHub, from the content script there, or null.
  async function tabPull(active) {
    if (!active || !active.id) {
      return null;
    }
    const answer = await chrome.tabs.sendMessage(active.id, { type: 'state' }).catch(() => null);
    return answer && answer.pull;
  }

  async function save(change) {
    await chrome.storage.sync.set(change);
    settings = T.withDefaults({ ...settings, ...change });
    say('');
  }

  async function showStatus() {
    const status = $('status');
    status.textContent = 'Checking…';
    status.className = 'status';
    const found = await chrome.runtime.sendMessage({ type: 'locate' }).catch(() => null);
    const up = Boolean(found && found.base);
    status.textContent = up ? `Running ${found.version}` : 'Not running';
    status.title = up ? found.base : `Nothing answers at ${settings.server}; start it with gh arc serve.`;
    status.className = `status ${up ? 'up' : 'down'}`;
  }

  function say(text) {
    $('message').textContent = text;
    $('message').hidden = !text;
  }
}());

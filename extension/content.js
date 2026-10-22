'use strict';

// Runs on github.com. A pull request page hands its tab to gh-arc, unless the page asked to
// stay on GitHub, the takeover is off for it, or the server isn't running.
(function () {
  const T = window.GhArcTakeover;
  // Pull requests this tab chose to see on GitHub; sessionStorage is per tab and per origin.
  const SKIP_KEY = 'gh-arc-skip';
  // The last hand-off, so landing back on the same pull request right away stays on GitHub
  // instead of bouncing again.
  const LAST_KEY = 'gh-arc-last';
  const BOUNCE_MS = 3000;
  // How long a fresh pull request page stays blank while the server answers.
  const HIDE_MS = 1500;
  const NOTICE_MS = 12000;
  let considered = null;

  consider(true);
  if (window.navigation) {
    window.navigation.addEventListener('navigatesuccess', () => consider(false));
  }
  window.addEventListener('popstate', () => consider(false));
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      considered = null;
      consider(false);
    }
  });
  chrome.runtime.onMessage.addListener(onMessage);

  async function consider(firstLoad) {
    const href = window.location.href;
    if (href === considered) {
      return;
    }
    considered = href;
    const pull = T.parsePullUrl(href);
    if (!pull) {
      return;
    }
    const key = T.pullKey(pull);
    if (pull.skip || bounced(key)) {
      setSkipped(key, true);
      return;
    }
    if (skipped(key)) {
      return;
    }
    const unhide = firstLoad ? hide() : () => {};
    let leaving = false;
    try {
      const settings = T.withDefaults(await chrome.storage.sync.get(null));
      if (!T.takesOver(settings, pull)) {
        return;
      }
      const found = await chrome.runtime.sendMessage({ type: 'locate' });
      if (window.location.href !== href) {
        return;
      }
      if (found && found.base) {
        leaving = true;
        handOff(found.base, pull);
      } else {
        showNotice(found ? found.server : T.DEFAULT_SERVER);
      }
    } catch (err) {
      // An extension reload orphans this script; GitHub's page carries on as usual.
    } finally {
      if (!leaving) {
        unhide();
      }
    }
  }

  // replace, not assign, so Back skips the GitHub page instead of landing on it and bouncing.
  function handOff(base, pull) {
    write(LAST_KEY, { key: T.pullKey(pull), at: Date.now() });
    window.location.replace(T.takeoverUrl(base, pull));
  }

  function bounced(key) {
    const last = read(LAST_KEY, null);
    return Boolean(last && last.key === key && Date.now() - last.at < BOUNCE_MS);
  }

  function skipped(key) {
    return read(SKIP_KEY, []).includes(key);
  }

  function setSkipped(key, skip) {
    const others = read(SKIP_KEY, []).filter((each) => each !== key);
    write(SKIP_KEY, skip ? [...others, key] : others);
  }

  function read(name, fallback) {
    try {
      return JSON.parse(window.sessionStorage.getItem(name)) || fallback;
    } catch (err) {
      return fallback;
    }
  }

  function write(name, value) {
    try {
      window.sessionStorage.setItem(name, JSON.stringify(value));
    } catch (err) {
      // Storage blocked: the takeover still works, it just can't remember choices.
    }
  }

  function hide() {
    const style = document.createElement('style');
    style.textContent = 'html { visibility: hidden !important; }';
    document.documentElement.append(style);
    const timer = setTimeout(() => style.remove(), HIDE_MS);
    return () => {
      clearTimeout(timer);
      style.remove();
    };
  }

  function showNotice(server) {
    document.getElementById('gh-arc-notice')?.remove();
    const host = document.createElement('div');
    host.id = 'gh-arc-notice';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .notice {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 360px;
          display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px;
          font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #1f2328; background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
          box-shadow: 0 8px 24px rgba(140, 149, 159, 0.3);
        }
        code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
        .actions { display: flex; gap: 6px; margin-top: 8px; }
        button { font: inherit; padding: 2px 10px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; color: inherit; cursor: pointer; }
        .close { padding: 0 6px; border: 0; background: none; font-size: 16px; line-height: 1; color: #59636e; }
        @media (prefers-color-scheme: dark) {
          .notice { color: #e6edf3; background: #161b22; border-color: #30363d; box-shadow: none; }
          button { background: #21262d; border-color: #30363d; }
          .close { color: #8d96a0; }
        }
      </style>
      <div class="notice" role="status">
        <div>
          <div><b>gh-arc isn't running</b> at <code></code>, so this is GitHub's page.</div>
          <div>Start it with <code>gh arc serve</code>.</div>
          <div class="actions"><button type="button" class="retry">Try again</button></div>
        </div>
        <button type="button" class="close" aria-label="Dismiss">×</button>
      </div>`;
    shadow.querySelector('code').textContent = server.replace(/^http:\/\//, '');
    shadow.querySelector('.close').addEventListener('click', () => host.remove());
    shadow.querySelector('.retry').addEventListener('click', () => {
      host.remove();
      considered = null;
      consider(false);
    });
    document.documentElement.append(host);
    setTimeout(() => host.remove(), NOTICE_MS);
  }

  // The popup asks what this tab shows, and can send it to gh-arc on request.
  function onMessage(message, sender, sendResponse) {
    const pull = T.parsePullUrl(window.location.href);
    if (message.type === 'state') {
      sendResponse({ pull: pull && { owner: pull.owner, repo: pull.repo, number: pull.number } });
      return false;
    }
    if (message.type === 'open' && pull) {
      chrome.runtime.sendMessage({ type: 'locate' }).then((found) => {
        if (found && found.base) {
          setSkipped(T.pullKey(pull), false);
          handOff(found.base, pull);
        }
        sendResponse(found);
      });
      return true;
    }
    return false;
  }
}());

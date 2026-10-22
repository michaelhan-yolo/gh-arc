'use strict';

// Finds the local gh-arc server for the content script. Pages can't reach it themselves (the
// server sends no CORS headers), so the ping goes through here, with the extension's host
// permissions for the loopback names.

importScripts('takeover.js');

const { withDefaults } = self.GhArcTakeover;
const PING_TIMEOUT_MS = 1500;
const ALIAS_TIMEOUT_MS = 600;
const ALIAS_TTL_MS = 60 * 1000;
let aliasCheck = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'locate') {
    locate().then(sendResponse);
    return true;
  }
  return false;
});

// { base, version } for the running server, or { down: true, server } when nothing answers.
async function locate() {
  const { server } = withDefaults(await chrome.storage.sync.get(null));
  const info = await ping(server, PING_TIMEOUT_MS);
  if (!info) {
    return { down: true, server };
  }
  const base = await aliasFor(server, info) || server;
  return { base, version: info.version, homeRepo: info.homeRepo || null };
}

async function ping(origin, timeout) {
  try {
    const res = await fetch(`${origin}/api/ping`, { signal: AbortSignal.timeout(timeout), cache: 'no-store' });
    const info = await res.json();
    return info && info.app === 'gh-arc' ? info : null;
  } catch (err) {
    return null;
  }
}

// http://diffs, when gh arc setup forwards it to this same server, for the shorter URLs.
async function aliasFor(server, info) {
  const host = new URL(server).hostname;
  if (host === 'diffs' || !info.forwardPort) {
    return null;
  }
  if (!aliasCheck || aliasCheck.build !== info.build || Date.now() - aliasCheck.at > ALIAS_TTL_MS) {
    const alias = await ping('http://diffs', ALIAS_TIMEOUT_MS);
    aliasCheck = { at: Date.now(), build: info.build, reaches: Boolean(alias && alias.build === info.build) };
  }
  return aliasCheck.reaches ? 'http://diffs' : null;
}

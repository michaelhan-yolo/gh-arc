'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

function homeDir() {
  return process.env.GH_ARC_HOME || path.join(os.homedir(), '.gh-arc');
}

function draftsPath(owner, repo, number) {
  const safe = (value) => String(value).replace(/[^\w.-]/g, '_');
  return path.join(homeDir(), 'drafts', `${safe(owner)}__${safe(repo)}__${Number(number)}.json`);
}

function emptyDrafts() {
  return { version: 1, threads: [], replies: [], body: '', event: 'COMMENT' };
}

function readDrafts(owner, repo, number) {
  try {
    const parsed = JSON.parse(fs.readFileSync(draftsPath(owner, repo, number), 'utf8'));
    return {
      ...emptyDrafts(),
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      replies: Array.isArray(parsed.replies) ? parsed.replies : [],
      body: typeof parsed.body === 'string' ? parsed.body : '',
      event: EVENTS.includes(parsed.event) ? parsed.event : 'COMMENT',
    };
  } catch (err) {
    return emptyDrafts();
  }
}

function writeDrafts(owner, repo, number, drafts) {
  const filePath = draftsPath(owner, repo, number);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const empty = !drafts.threads.length && !drafts.replies.length && !drafts.body;
  if (empty) {
    fs.rmSync(filePath, { force: true });
  } else {
    fs.writeFileSync(filePath, `${JSON.stringify(drafts, null, 2)}\n`);
  }
  return drafts;
}

function newId() {
  return `draft-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function requireText(payload) {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    throw new Error('Comment text is required.');
  }
  return text;
}

function applyDraftChange(drafts, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Draft payload is required.');
  }
  const now = new Date().toISOString();
  const next = {
    ...drafts,
    threads: drafts.threads.slice(),
    replies: drafts.replies.slice(),
  };

  if (payload.action === 'add-thread') {
    const side = payload.side === 'old' ? 'old' : payload.side === 'new' ? 'new' : '';
    const startLine = Number(payload.startLine);
    const endLine = Number(payload.endLine);
    if (!side || typeof payload.path !== 'string' || !payload.path ||
        !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
      throw new Error('A draft comment needs a side, path, startLine and endLine.');
    }
    next.threads.push({
      id: newId(),
      side,
      path: payload.path,
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
      text: requireText(payload),
      createdAt: now,
    });
  } else if (payload.action === 'add-reply') {
    if (typeof payload.threadId !== 'string' || !payload.threadId) {
      throw new Error('A draft reply needs a threadId.');
    }
    next.replies.push({ id: newId(), threadId: payload.threadId, text: requireText(payload), createdAt: now });
  } else if (payload.action === 'update') {
    const text = requireText(payload);
    const item = next.threads.find((draft) => draft.id === payload.id) ||
      next.replies.find((draft) => draft.id === payload.id);
    if (!item) {
      throw new Error('Draft was not found.');
    }
    Object.assign(item, { text, updatedAt: now });
  } else if (payload.action === 'delete') {
    next.threads = next.threads.filter((draft) => draft.id !== payload.id);
    next.replies = next.replies.filter((draft) => draft.id !== payload.id);
  } else if (payload.action === 'review') {
    if (typeof payload.body === 'string') {
      next.body = payload.body;
    }
    if (EVENTS.includes(payload.event)) {
      next.event = payload.event;
    }
  } else {
    throw new Error(`Unknown draft action "${payload.action}".`);
  }
  return next;
}

module.exports = {
  EVENTS,
  applyDraftChange,
  draftsPath,
  emptyDrafts,
  homeDir,
  readDrafts,
  writeDrafts,
};

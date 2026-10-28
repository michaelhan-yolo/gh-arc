'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

let server;
let github;
let reply;
let requests;

test.before(async () => {
  server = http.createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(reply.status, { 'Content-Type': reply.type });
    res.end(reply.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.GH_ARC_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GH_ARC_TOKEN = 'test-token';
  github = require('../../lib/github');
});

test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => { requests = 0; });

test('GitHub HTML and plain-text server errors become readable messages with their status', async () => {
  for (const [status, type, body] of [
    [500, 'text/html', '<!DOCTYPE html><!-- Hello future GitHubber! --><html><title>Unicorn! &middot; GitHub</title></html>'],
    [502, 'text/html', '<html>Bad gateway</html>'],
    [503, 'text/plain', 'Service unavailable'],
  ]) {
    reply = { status, type, body };
    await assert.rejects(github.fetchPullRequestDiff('octo', 'widgets', 2), {
      status,
      message: `GitHub is temporarily unavailable (HTTP ${status}). Try again in a moment.`,
    });
  }
  assert.equal(requests, 3);
});

test('structured GitHub errors keep authentication and validation details', async () => {
  for (const [status, body, message] of [
    [401, { message: 'Bad credentials' }, 'Bad credentials'],
    [422, { message: 'Validation Failed', errors: [{ message: 'must be part of the diff' }] }, 'Validation Failed: must be part of the diff'],
  ]) {
    reply = { status, type: 'application/json', body: JSON.stringify(body) };
    await assert.rejects(github.fetchPullRequestDiff('octo', 'widgets', 2), { status, message });
  }
});

test('non-JSON client errors do not expose an HTML document', async () => {
  reply = { status: 404, type: 'text/html', body: '<html>Not Found</html>' };
  await assert.rejects(github.fetchPullRequestDiff('octo', 'widgets', 2), {
    status: 404, message: 'GitHub request failed (HTTP 404).',
  });
});

test('successful raw diff responses are preserved', async () => {
  reply = { status: 200, type: 'text/plain', body: 'diff --git a/index.html b/index.html\n+<!DOCTYPE html>\n' };
  assert.equal(await github.fetchPullRequestDiff('octo', 'widgets', 2), reply.body);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const setup = require('../../lib/setup');

test('hosts parsing finds the alias only where it points at 127.0.0.1', () => {
  assert.equal(setup.hostsMapsAlias('127.0.0.1\tlocalhost\n127.0.0.1\tdiffs\t# gh-arc\n'), true);
  assert.equal(setup.hostsMapsAlias('127.0.0.1 localhost diffs'), true);
  assert.equal(setup.hostsMapsAlias('10.0.0.5 diffs\n127.0.0.1 diffs'), false);
  assert.equal(setup.hostsMapsAlias('# 127.0.0.1 diffs\n127.0.0.1 diffsx'), false);
  assert.equal(setup.hostsWithoutAlias('127.0.0.1\tlocalhost\n127.0.0.1\tdiffs\t# gh-arc\n::1 localhost'), '127.0.0.1\tlocalhost\n::1 localhost');
});

test('the pf rule forwards loopback port 80 and the startup job runs only pfctl on root files', () => {
  assert.match(setup.anchorRules(7799), /^rdr pass on lo0 inet proto tcp from any to 127\.0\.0\.1 port 80 -> 127\.0\.0\.1 port 7799$/m);
  const plist = setup.daemonPlist();
  assert.match(plist, /<string>dev\.gh-arc\.diffs<\/string>/);
  assert.match(plist, /\/sbin\/pfctl -a com\.apple\/gh-arc -f \/etc\/pf\.anchors\/gh-arc/);
  assert.doesNotMatch(plist, /node|\/Users\//);
});

test('setup plans only the steps still open, and removal undoes every piece', () => {
  const none = setup.installSteps({ hosts: false, rules: false, daemon: false, forward: false }, 7799);
  assert.deepEqual(none.map((step) => step.command.join(' ')), [
    'tee -a /etc/hosts',
    'tee /etc/pf.anchors/gh-arc',
    'chmod 644 /etc/pf.anchors/gh-arc',
    'tee /Library/LaunchDaemons/dev.gh-arc.diffs.plist',
    'chown root:wheel /Library/LaunchDaemons/dev.gh-arc.diffs.plist',
    'chmod 644 /Library/LaunchDaemons/dev.gh-arc.diffs.plist',
    'launchctl bootout system/dev.gh-arc.diffs',
    'launchctl bootstrap system /Library/LaunchDaemons/dev.gh-arc.diffs.plist',
    'pfctl -a com.apple/gh-arc -f /etc/pf.anchors/gh-arc',
    "sh -c pfctl -s info | grep -q 'Status: Enabled' || pfctl -E",
    'dscacheutil -flushcache',
    'killall -HUP mDNSResponder',
  ]);
  assert.equal(none[0].input, '\n127.0.0.1\tdiffs\t# gh-arc\n');
  assert.deepEqual(setup.installSteps({ hosts: true, rules: true, daemon: true, forward: true }, 7799), []);
  assert.deepEqual(setup.installSteps({ hosts: true, rules: true, daemon: true, forward: false }, 7799).map((step) => step.command[0]), ['pfctl', 'sh']);
  const removal = setup.removeSteps().map((step) => step.command.join(' '));
  assert.ok(removal.includes('launchctl bootout system/dev.gh-arc.diffs'));
  assert.ok(removal.includes('rm -f /Library/LaunchDaemons/dev.gh-arc.diffs.plist /etc/pf.anchors/gh-arc'));
  assert.ok(removal.includes('pfctl -a com.apple/gh-arc -F all'));
  assert.ok(removal.includes('tee /etc/hosts'));
});

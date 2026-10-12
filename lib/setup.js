'use strict';

// gh arc setup: makes http://diffs/<number> reach gh-arc on this Mac. Two system pieces, both
// installed with sudo and both removable with gh arc setup --remove:
//   - /etc/hosts maps the name "diffs" to 127.0.0.1;
//   - a pf rule forwards 127.0.0.1:80 to gh-arc's forward port (see ports.js), loaded into
//     Apple's com.apple/* anchor point (so /etc/pf.conf is left alone) and reloaded at startup by
//     a LaunchDaemon that runs only /sbin/pfctl on root-owned files.

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');

const { ALIAS_HOST } = require('../web/routes');
const { DEFAULT_PORT, FORWARD_PORT } = require('./ports');

const HOSTS_FILE = '/etc/hosts';
const HOSTS_MARK = '# gh-arc';
const ANCHOR = 'com.apple/gh-arc';
const ANCHOR_FILE = '/etc/pf.anchors/gh-arc';
const DAEMON_LABEL = 'dev.gh-arc.diffs';
const DAEMON_FILE = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;

function hostsLine() {
  return `127.0.0.1\t${ALIAS_HOST}\t${HOSTS_MARK}`;
}

// Whether a hosts file sends the alias to 127.0.0.1 (and nowhere else first).
function hostsMapsAlias(text) {
  for (const raw of String(text).split('\n')) {
    const [address, ...names] = raw.replace(/#.*/, '').trim().split(/\s+/);
    if (names.includes(ALIAS_HOST)) {
      return address === '127.0.0.1';
    }
  }
  return false;
}

function hostsWithoutAlias(text) {
  return String(text).split('\n').filter((line) => !line.includes(HOSTS_MARK)).join('\n');
}

function anchorRules(port) {
  return [
    `# gh-arc: http://${ALIAS_HOST}/ (port 80 on this Mac) reaches gh-arc on port ${port}.`,
    `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${port}`,
    '',
  ].join('\n');
}

// At startup, after Apple's com.apple.pfctl job loads /etc/pf.conf, reload the rule and make
// sure pf is on; pf counts enable references, so turning it on leaves other users of it alone.
function daemonPlist() {
  const script = [
    'sleep 5',
    `/sbin/pfctl -a ${ANCHOR} -f ${ANCHOR_FILE}`,
    "/sbin/pfctl -s info | /usr/bin/grep -q 'Status: Enabled' || /sbin/pfctl -E",
  ].join('; ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${script}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    return null;
  }
}

function get(host, port, headers) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/ping', headers, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

// Asks port 80 for gh-arc's ping, through the alias when it resolves. Only forwarded traffic
// reaches the forward port, so with nothing answering there a stand-in listens on it for the
// length of the check.
async function forwardWorks(viaAlias) {
  const ask = async () => {
    const answer = await get(viaAlias ? ALIAS_HOST : '127.0.0.1', 80, { Host: ALIAS_HOST });
    return Boolean(answer && answer.app === 'gh-arc');
  };
  if (await ask()) {
    return true;
  }
  const standIn = http.createServer((req, res) => res.end(JSON.stringify({ app: 'gh-arc', standIn: true })));
  const listening = await new Promise((resolve) => {
    standIn.once('error', () => resolve(false));
    standIn.listen(FORWARD_PORT, '127.0.0.1', () => resolve(true));
  });
  if (!listening) {
    return false;
  }
  const works = await ask();
  await new Promise((resolve) => standIn.close(resolve));
  return works;
}

async function check() {
  const anchor = readFile(ANCHOR_FILE);
  const status = {
    hosts: hostsMapsAlias(readFile(HOSTS_FILE) || ''),
    rules: anchor === anchorRules(FORWARD_PORT),
    daemon: readFile(DAEMON_FILE) === daemonPlist(),
  };
  status.forward = status.rules && await forwardWorks(false);
  status.alias = status.hosts && status.forward ? await forwardWorks(true) : false;
  return status;
}

// The sudo steps that close what check() found open, as { label, command, input }.
function installSteps(status, port) {
  const steps = [];
  if (!status.hosts) {
    steps.push({ label: `Map ${ALIAS_HOST} to 127.0.0.1 in ${HOSTS_FILE}`, command: ['tee', '-a', HOSTS_FILE], input: `\n${hostsLine()}\n` });
  }
  if (!status.rules) {
    steps.push({ label: `Write the port 80 → ${port} rule to ${ANCHOR_FILE}`, command: ['tee', ANCHOR_FILE], input: anchorRules(port) });
    steps.push({ label: '', command: ['chmod', '644', ANCHOR_FILE] });
  }
  if (!status.daemon) {
    steps.push({ label: `Reload the rule at startup (${DAEMON_FILE})`, command: ['tee', DAEMON_FILE], input: daemonPlist() });
    steps.push({ label: '', command: ['chown', 'root:wheel', DAEMON_FILE] });
    steps.push({ label: '', command: ['chmod', '644', DAEMON_FILE] });
    steps.push({ label: '', command: ['launchctl', 'bootout', `system/${DAEMON_LABEL}`], mayFail: true });
    steps.push({ label: '', command: ['launchctl', 'bootstrap', 'system', DAEMON_FILE] });
  }
  if (!status.forward || !status.rules) {
    steps.push({ label: 'Load the rule now and turn pf on', command: ['pfctl', '-a', ANCHOR, '-f', ANCHOR_FILE], quiet: true });
    steps.push({ label: '', command: ['sh', '-c', "pfctl -s info | grep -q 'Status: Enabled' || pfctl -E"], quiet: true });
  }
  if (!status.hosts) {
    steps.push({ label: 'Clear the DNS cache so the name takes effect', command: ['dscacheutil', '-flushcache'] });
    steps.push({ label: '', command: ['killall', '-HUP', 'mDNSResponder'], mayFail: true });
  }
  return steps;
}

function removeSteps() {
  return [
    { label: 'Stop reloading the rule at startup', command: ['launchctl', 'bootout', `system/${DAEMON_LABEL}`], mayFail: true },
    { label: '', command: ['rm', '-f', DAEMON_FILE, ANCHOR_FILE] },
    { label: 'Remove the port 80 rule', command: ['pfctl', '-a', ANCHOR, '-F', 'all'], mayFail: true, quiet: true },
    { label: `Remove ${ALIAS_HOST} from ${HOSTS_FILE}`, command: ['tee', HOSTS_FILE], input: hostsWithoutAlias(readFile(HOSTS_FILE) || '') },
    { label: 'Clear the DNS cache', command: ['dscacheutil', '-flushcache'] },
    { label: '', command: ['killall', '-HUP', 'mDNSResponder'], mayFail: true },
  ];
}

function shellWord(arg) {
  return /[\s|'"&;<>]/.test(arg) ? `"${arg}"` : arg;
}

function describe(steps) {
  return steps.map((step) => `  sudo ${step.command.map(shellWord).join(' ')}${step.input !== undefined ? '   (contents below)' : ''}`).join('\n');
}

function runSteps(steps) {
  for (const step of steps) {
    if (step.label) {
      console.log(`• ${step.label}`);
    }
    const result = childProcess.spawnSync('sudo', step.command, {
      input: step.input,
      stdio: [
        step.input !== undefined ? 'pipe' : 'inherit',
        step.input !== undefined || step.quiet ? 'ignore' : 'inherit',
        step.quiet || step.mayFail ? 'ignore' : 'inherit',
      ],
    });
    if (result.status !== 0 && !step.mayFail) {
      throw new Error(`sudo ${step.command.join(' ')} failed.`);
    }
  }
}

function askYesNo(question) {
  let fd = null;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
    fs.writeSync(fd, question);
    const buffer = Buffer.alloc(256);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length);
    return /^y(es)?$/i.test(buffer.toString('utf8', 0, bytes).trim());
  } catch (err) {
    return false;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function printStatus(status) {
  const mark = (ok) => (ok ? '✓' : '✗');
  console.log(`${mark(status.hosts)} ${ALIAS_HOST} points at 127.0.0.1 (${HOSTS_FILE})`);
  console.log(`${mark(status.forward)} port 80 on 127.0.0.1 reaches gh-arc on ${FORWARD_PORT} (pf rule in ${ANCHOR})`);
  console.log(`${mark(status.rules && status.daemon)} the rule reloads at startup (${DAEMON_FILE})`);
}

// A gh-arc already running from before the forward port existed needs a restart to answer on it.
async function runningServerNote() {
  const running = await get('127.0.0.1', DEFAULT_PORT, { Host: `127.0.0.1:${DEFAULT_PORT}` });
  if (running && running.app === 'gh-arc' && !running.forwardPort) {
    return `\nThe gh-arc running on ${DEFAULT_PORT} predates this; restart it (Ctrl-C in its terminal, then gh arc) so http://${ALIAS_HOST}/ reaches it.`;
  }
  return '';
}

async function runSetup({ remove, dryRun }) {
  if (process.platform !== 'darwin') {
    console.log(`gh arc setup handles macOS. Elsewhere: map ${ALIAS_HOST} to 127.0.0.1 in your hosts file and forward 127.0.0.1:80 to ${FORWARD_PORT}.`);
    return;
  }
  if (remove) {
    const steps = removeSteps();
    console.log(`This removes http://${ALIAS_HOST}/ and runs:\n${describe(steps)}`);
    if (dryRun || !askYesNo('\nGo ahead? sudo will ask for your password. [y/N] ')) {
      return;
    }
    runSteps(steps);
    console.log(`Removed. gh arc goes back to http://localhost:${DEFAULT_PORT}/diffs/<number>.`);
    return;
  }

  const status = await check();
  printStatus(status);
  if (status.alias && status.rules && status.daemon) {
    console.log(`\nAll set: http://${ALIAS_HOST}/<number> opens a pull request.${await runningServerNote()}`);
    return;
  }
  const steps = installSteps(status, FORWARD_PORT);
  console.log(`\nTo make http://${ALIAS_HOST}/<number> work, gh arc setup runs:\n${describe(steps)}`);
  steps.filter((step) => step.input !== undefined).forEach((step) => {
    console.log(`\n${step.command[step.command.length - 1]}${step.command.includes('-a') ? ' (appended)' : ''}:\n${step.input.trim().split('\n').map((line) => `  ${line}`).join('\n')}`);
  });
  console.log(`\nThe rule sends everything on 127.0.0.1 port 80 to gh-arc; gh arc setup --remove undoes all of it.`);
  if (dryRun || !askYesNo('\nGo ahead? sudo will ask for your password. [y/N] ')) {
    return;
  }
  runSteps(steps);
  const after = await check();
  console.log('');
  printStatus(after);
  console.log(after.alias
    ? `\nDone. Open http://${ALIAS_HOST}/<number>, or type ${ALIAS_HOST}/<number> in the address bar.${await runningServerNote()}`
    : '\nSomething did not take; run gh arc setup again to see what is still open.');
}

// An older gh arc setup forwarded port 80 to the direct port itself, which pf makes unreachable.
function staleRuleNote(port) {
  const rules = readFile(ANCHOR_FILE) || '';
  return rules.includes(`-> 127.0.0.1 port ${port}`)
    ? `Port ${port} can't be reached: an older gh arc setup forwards port 80 to it. Run gh arc setup to move that forward to ${FORWARD_PORT}.`
    : '';
}

module.exports = {
  ALIAS_HOST,
  staleRuleNote,
  anchorRules,
  check,
  daemonPlist,
  hostsMapsAlias,
  hostsWithoutAlias,
  installSteps,
  removeSteps,
  runSetup,
};

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const routes = require('../web/routes');
const { homeDir } = require('./drafts');
const { runSetup } = require('./setup');
const { APP, BUILD, VERSION, createServer } = require('./server');

const DEFAULT_PORT = 7799;

function usage() {
  return `
gh arc — review GitHub pull requests and stacks side by side, Phabricator style.

Usage:
  gh arc                      Open the current branch's pull request (or your inbox)
  gh arc <number>             Open a pull request in the current repository
  gh arc <owner>/<repo>#<n>   Open a pull request in any repository
  gh arc <url>                Open a github.com pull request URL
  gh arc <branch>             Open the pull request for a branch
  gh arc inbox                Open your review inbox: needs review, yours, reviewed
  gh arc serve                Start the server without opening a page
  gh arc setup                Make http://diffs/<number> work on this Mac (asks for sudo once)
  gh arc setup --remove       Undo gh arc setup

Options:
  -R, --repo <owner/repo>     Repository for a bare number or branch
  --dry-run                   With setup: show what it would change, change nothing
  -p, --port <port>           Port to serve on (default ${DEFAULT_PORT})
  --no-open                   Print the URL instead of opening a browser
  -h, --help                  Show this help

Pages live at http://diffs/<number> once gh arc setup has run (else
http://localhost:${DEFAULT_PORT}/diffs/<number>) for the repository you run gh arc in, which
it remembers, and at .../<owner>/<repo>/<number> for any other.
One server serves every pull request; running gh arc again reuses it. A github.com pull
request URL also works with the host swapped: localhost:${DEFAULT_PORT}/o/r/pull/12 redirects.
`.trim();
}

function parseArgs(argv) {
  const opts = { _: [], port: DEFAULT_PORT, open: true, repo: null, help: false, remove: false, dryRun: false };
  for (let ii = 0; ii < argv.length; ii++) {
    const arg = argv[ii];
    if (arg === '--port' || arg === '-p') {
      opts.port = Number(argv[++ii]);
      if (!Number.isInteger(opts.port) || opts.port < 1) {
        throw new Error('--port needs a number.');
      }
    } else if (arg === '--repo' || arg === '-R') {
      opts.repo = argv[++ii];
      if (!opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
        throw new Error('--repo needs owner/repo.');
      }
    } else if (arg === '--no-open') {
      opts.open = false;
    } else if (arg === '--remove') {
      opts.remove = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '-h' || arg === '--help' || arg === 'help') {
      opts.help = true;
    } else {
      opts._.push(arg);
    }
  }
  if (opts._[0] === 'pr') {
    opts._.shift();
  }
  return opts;
}

function runGh(args) {
  const result = childProcess.spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || `gh ${args.join(' ')} failed`).trim());
  }
  return result.stdout.trim();
}

// The repository gh resolves for the working directory, or null outside a GitHub checkout.
function checkoutRepo() {
  try {
    return runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']) || null;
  } catch (err) {
    return null;
  }
}

function configPath() {
  return path.join(homeDir(), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    return {};
  }
}

// The repository whose pull requests get the short /diffs/<number> pages: the checkout gh arc
// runs in, else the last one it ran in.
function homeRepoFor(checkout) {
  const config = readConfig();
  if (checkout && checkout !== config.homeRepo) {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(configPath(), `${JSON.stringify({ ...config, homeRepo: checkout }, null, 2)}\n`);
  }
  return checkout || config.homeRepo || null;
}

// The pull request to open, as { repo, number }, or null for the inbox.
function resolveTarget(opts, checkout) {
  const [first] = opts._;
  const repoArgs = opts.repo ? ['-R', opts.repo] : [];
  if (first === 'serve' || first === 'inbox' || first === 'home') {
    return null;
  }
  if (!first) {
    try {
      return routes.parseReference(runGh(['pr', 'view', ...repoArgs, '--json', 'url', '-q', '.url']));
    } catch (err) {
      return null;
    }
  }
  const reference = routes.parseReference(first);
  if (reference) {
    return reference;
  }
  const number = first.match(/^#?(\d+)$/);
  if (number) {
    const repo = opts.repo || checkout;
    if (!repo) {
      throw new Error('Not in a GitHub checkout; pass -R owner/repo.');
    }
    return { repo, number: Number(number[1]) };
  }
  const resolved = routes.parseReference(runGh(['pr', 'view', first, ...repoArgs, '--json', 'url', '-q', '.url']));
  if (!resolved) {
    throw new Error(`No pull request found for "${first}".`);
  }
  return resolved;
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 400 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.app === APP ? info : null);
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

// Whether http://diffs/ reaches this build of gh-arc, so its short URLs can be handed out.
function aliasReaches() {
  return new Promise((resolve) => {
    const req = http.get({ host: routes.ALIAS_HOST, port: 80, path: '/api/ping', headers: { Host: routes.ALIAS_HOST }, timeout: 600 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(info.app === APP && info.build === BUILD);
        } catch (err) {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function pageUrl(port, home, target) {
  const alias = port === DEFAULT_PORT && await aliasReaches();
  const page = target ? routes.diffPath(target.repo, target.number, home, alias) : '/';
  return { url: alias ? `http://${routes.ALIAS_HOST}${page}` : `http://localhost:${port}${page}`, alias };
}

async function findRunningServers(port) {
  const servers = [];
  for (let candidate = port; candidate < port + 20; candidate++) {
    const info = await ping(candidate);
    if (info) {
      servers.push({ port: candidate, build: info.build, homeRepo: info.homeRepo || null });
    }
  }
  return servers;
}

function openUrl(target) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  const child = childProcess.spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      console.log(usage());
      return;
    }
    if (opts._[0] === 'setup') {
      await runSetup({ port: DEFAULT_PORT, remove: opts.remove, dryRun: opts.dryRun });
      return;
    }
    const checkout = checkoutRepo();
    const homeRepo = homeRepoFor(checkout);
    const target = resolveTarget(opts, checkout);
    const servers = await findRunningServers(opts.port);
    const current = servers.find((server) => server.build === BUILD);
    if (current) {
      const { url } = await pageUrl(current.port, current.homeRepo, target);
      console.log(url);
      if (opts.open && opts._[0] !== 'serve') {
        openUrl(url);
      }
      return;
    }
    servers.forEach((server) => {
      console.error(`gh-arc on port ${server.port} runs older code; starting a fresh server. Stop the old one with Ctrl-C in its terminal.`);
    });
    const app = createServer({ homeRepo });
    const port = await app.listen(opts.port);
    if (target || homeRepo) {
      const [owner, repo] = (target ? target.repo : homeRepo).split('/');
      app.prewarm(owner, repo);
    }
    const { url, alias } = await pageUrl(port, homeRepo, target);
    const origin = alias ? `http://${routes.ALIAS_HOST}` : `http://localhost:${port}`;
    console.log(`gh-arc ${VERSION} serving ${origin}${homeRepo ? `  ·  ${alias ? '' : '/diffs'}/<n> is ${homeRepo}` : ''}  (Ctrl-C to stop)`);
    if (!alias && port === DEFAULT_PORT && process.platform === 'darwin') {
      console.log(`Tip: gh arc setup makes this http://${routes.ALIAS_HOST}/<n>.`);
    }
    console.log(url);
    if (opts.open && opts._[0] !== 'serve') {
      openUrl(url);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
  resolveTarget,
  usage,
};

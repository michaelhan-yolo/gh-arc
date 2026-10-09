'use strict';

const childProcess = require('child_process');
const http = require('http');

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

Options:
  -R, --repo <owner/repo>     Repository for a bare number or branch
  -p, --port <port>           Port to serve on (default ${DEFAULT_PORT})
  --no-open                   Print the URL instead of opening a browser
  -h, --help                  Show this help

One server serves every pull request; running gh arc again reuses it.
Any github.com pull request URL works with the host swapped:
  https://github.com/o/r/pull/12  ->  http://127.0.0.1:${DEFAULT_PORT}/o/r/pull/12
`.trim();
}

function parseArgs(argv) {
  const opts = { _: [], port: DEFAULT_PORT, open: true, repo: null, help: false };
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

function prPathFromUrl(value) {
  const match = String(value).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  return match ? `/${match[1]}/${match[2]}/pull/${match[3]}` : null;
}

function currentRepo(opts) {
  return opts.repo || runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
}

function resolveTarget(opts) {
  const [first] = opts._;
  const repoArgs = opts.repo ? ['-R', opts.repo] : [];
  if (!first || first === 'serve') {
    if (first === 'serve') {
      return '/';
    }
    try {
      return prPathFromUrl(runGh(['pr', 'view', ...repoArgs, '--json', 'url', '-q', '.url'])) || '/';
    } catch (err) {
      return '/';
    }
  }
  if (first === 'inbox' || first === 'home') {
    return '/';
  }
  const fromUrl = prPathFromUrl(first);
  if (fromUrl) {
    return fromUrl;
  }
  const qualified = first.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (qualified) {
    return `/${qualified[1]}/${qualified[2]}/pull/${qualified[3]}`;
  }
  const number = first.match(/^#?(\d+)$/);
  if (number) {
    return `/${currentRepo(opts)}/pull/${number[1]}`;
  }
  const url = runGh(['pr', 'view', first, ...repoArgs, '--json', 'url', '-q', '.url']);
  const resolved = prPathFromUrl(url);
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

async function findRunningServers(port) {
  const servers = [];
  for (let candidate = port; candidate < port + 20; candidate++) {
    const info = await ping(candidate);
    if (info) {
      servers.push({ port: candidate, build: info.build });
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
    const target = resolveTarget(opts);
    const servers = await findRunningServers(opts.port);
    const current = servers.find((server) => server.build === BUILD);
    if (current) {
      const url = `http://127.0.0.1:${current.port}${target}`;
      console.log(url);
      if (opts.open && opts._[0] !== 'serve') {
        openUrl(url);
      }
      return;
    }
    servers.forEach((server) => {
      console.error(`gh-arc on port ${server.port} runs older code; starting a fresh server. Stop the old one with Ctrl-C in its terminal.`);
    });
    const app = createServer();
    const port = await app.listen(opts.port);
    const prTarget = target.match(/^\/([^/]+)\/([^/]+)\/pull\//);
    if (prTarget) {
      app.prewarm(prTarget[1], prTarget[2]);
    }
    const url = `http://127.0.0.1:${port}${target}`;
    console.log(`gh-arc ${VERSION} serving http://127.0.0.1:${port}  (Ctrl-C to stop)`);
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
  prPathFromUrl,
  resolveTarget,
  usage,
};

# Phabricade

Review GitHub pull requests and stacks side by side, the way Phabricator's Differential did. Phabricade is a `gh` extension that serves a local review page for any pull request: the stack it sits in, its existing review threads, draft inline comments, and one submitted review.

The diff viewer comes from [local-arc](https://github.com/emersonding/local-arc) (MIT, Emerson Ding); Phabricade puts GitHub behind it. The existing repository, `gh arc` command, local settings, and `diffs/…` links keep their names for compatibility.

## Install

```sh
gh extension install michaelhan-yolo/gh-arc
```

To work on it, install from a clone instead; edits take effect on the next `gh arc`:

```sh
git clone https://github.com/michaelhan-yolo/gh-arc ~/gh-arc   # the folder name must start with gh-
cd ~/gh-arc && gh extension install .
```

It needs Node 18+ and a logged-in `gh` (`gh auth login`). There are no runtime dependencies.

## Use

```sh
gh arc                      # the current branch's pull request, or your inbox
gh arc 11530                # a pull request in the current repository
gh arc octo/widgets#12      # any repository
gh arc https://github.com/octo/widgets/pull/12/files
gh arc my-branch            # the pull request for a branch
gh arc inbox                # needs your review, yours, reviewed by you
gh arc serve                # start the server only
```

Pages live at `http://localhost:7799/diffs/11505` for the repository you run `gh arc` in, which it remembers for next time, and at `/diffs/<owner>/<repo>/<number>` for any other. Run `gh arc setup` once and they live at **`http://diffs/11505`** instead, so typing `diffs/11505` in the address bar opens the pull request. One server serves every pull request, and running `gh arc` again reuses it. A GitHub pull request URL also works with the host swapped: `localhost:7799/o/r/pull/12` redirects to its `/diffs/` page. Options: `-R owner/repo`, `-p <port>`, `--no-open`.

## What you get

- **Your stacks in the sidebar**: every open pull request of yours, grouped into stacks and drawn top first over the trunk; the stack on screen opens first, and one you're only viewing sits above them. The file list for the pull request on screen sits below, behind a handle you can drag (double-click resets it).
- **Progressive loading**: the diff, PR details, comments and stack load independently. A failed section has its own Retry button, so you can keep reading the code. Review controls wait for the data they need.
- **Large diffs**: distant file bodies render as you approach them; file and thread jumps render their destination immediately.
- **Syntax colors**: common languages have syntax highlighting in both layouts and themes, alongside word-level change highlights. Highlighting uses the changed hunks; unknown languages and very large hunks remain plain text.
- **Thread browser**: the **Threads** button (or `c`) opens a sidebar grouped by file, with author, resolved-status and text filters. Jump to current, outdated or draft threads without losing an open composer.
- **Quicker navigation**: adjacent stack PRs preload when the page is idle; hovering over or focusing a PR link also preloads it. Up to two PRs preload at once, with a reserve of 20% of GitHub’s rate budget (at least 50 requests/points) for your actions. Warm metadata is reused once within 15 seconds and invalidated by writes.
- **Side by side or unified diffs**, with intraline highlights, a file filter, and context that expands 20 lines at a time from the merge base and head.
- **The stack**: pull requests chained by base branch, drawn as a graph from the top of the stack down to the trunk, with each one's review state, checks and size. In the top bar, `‹ #n` and `#m ›` (or `[` and `]`) move down and up, and the stack button between them (`2/7`, or `s`) opens the whole stack to jump to any pull request in it.
- **Versions**, Phabricator's update history: one version per push, including heads a force push replaced. The `Versions · Base → V9` button in the top bar (or `v`) opens them; pick an old and a new version to see what changed between them. The comparison replays the old version's changes onto the new version's base, so a lower pull request merged up the stack in between drops out. Where base changes and the pull request touch the same lines, the file says so and shows both.
- **Existing threads inline**, with resolve, unresolve and reply. Resolved threads start collapsed; outdated ones sit under the details with the hunk they were left on.
- **Review status and Ship it**: the top bar says where a pull request stands: yellow *Under review*, red *Changes requested*, and once accepted, a green **Ship it**. Shipping a pull request higher in a stack lands the whole stack below it in one go, bottom first: each one merges into the trunk and the next moves onto the trunk before it merges, with every one required to be accepted, and the pull requests above move onto the trunk afterwards. The server moves a pull request onto the trunk only after the one below it has merged, so nothing unreviewed rides along. The sidebar, stack menu and inbox show the same status on every pull request.
- **Phabricator-style review**: inline comments and replies stay drafts (saved in `~/.gh-arc/drafts`, so they survive a reload) until you submit them in one review as Comment, Accept or Request changes. A pending review you started on github.com goes out with it.
- **Image files** (PNG, JPEG, GIF, WebP, SVG, ICO) show as pictures, before and after: side by side, a swipe between the two, or a flip. An added or deleted image shows its one side, and an SVG keeps its text diff below.
- **Viewed files** sync with GitHub's checkbox and collapse. Lock files, generated files and diffs over 1,500 lines start collapsed.
- **Narrower views**: one commit, or everything since your last review. You can comment on the right side when it's the head commit; other views are read-only.
- **Details**: author, branches, reviewers, checks, labels, the description and the conversation, rendered by GitHub. Links to other pull requests open here.
- **Inbox**: needs your review, your pull requests, and the ones you've reviewed, grouped into stacks. **Landed diffs** lists your merged pull requests, newest merge first, with a shortcut in the diff page's left rail. The sidebar shows one section at a time or all of them, and the chips under the search bar narrow it to one repository.
- Choose **System**, **Light** or **Dark** in the diff toolbar or inbox sidebar. Your choice is remembered across pages and reloads; System follows your device's appearance.

Keys: `j` and `k` step through files, `[` and `]` walk the stack, `s` opens the stack menu, `v` the versions, `c` the thread browser, Escape closes it, and ⌘/Ctrl+Enter saves a comment or submits the review.

## How it works

`gh arc` starts a Node server listening on 127.0.0.1 only (`localhost` reaches it). The server reads your token once from `gh auth token` and calls GitHub's GraphQL and REST APIs; the token never reaches the page. Diffs come from the pull request diff endpoint, which falls back to the files API past GitHub's size limit. The stack comes from your repository's open pull requests, cached for a minute.

GitHub keeps no log of pushes, but CI checks run only on the commit at the tip of each push, so commits with check suites mark the versions; force-pushed-away heads come from the pull request's timeline. A comparison between versions A and B fetches each changed file at A, B and both versions' merge bases, merges A's changes onto B's base, and diffs that against B.

On your own pull requests there is nothing to accept or block: the Review button goes away and the panel posts your replies as comments.

Submitting a review gets or creates your pending review on GitHub, adds each draft as a thread or reply, and then submits it with the action you chose. If GitHub rejects a draft (a line outside the diff, say), the draft stays local with the error, the rest wait in the pending review, and nothing is submitted until you resubmit.

Images uploaded to a private repository's descriptions and comments come back from GitHub as links signed for five minutes, so a page left open would lose them. The server points them at `/api/image/<id>` instead and fetches each one itself: from the signed link while it lasts, and after that from `github.com/user-attachments` with your token, following redirects only to GitHub's own hosts and never sending the token to its storage. Commit-pinned images linked from GitHub repositories in descriptions and comments also load through the authenticated server, including private media branches. It serves a file only if its bytes are an image, and the browser keeps it, since asset ids and commits never change.

The server acts with your GitHub credentials, so it only answers requests addressed to `127.0.0.1` or `localhost`. Writes also need a token that is minted per server and embedded in the page, and the page runs under a CSP that allows only its own scripts.

## `http://diffs/`

`gh arc setup` (macOS) checks the machine, shows exactly what it will change, and asks before running anything with `sudo`:

- `/etc/hosts` maps the name `diffs` to 127.0.0.1.
- A packet-filter rule forwards 127.0.0.1 port 80 to gh-arc's port 7799. macOS won't let a normal program take port 80 on 127.0.0.1, and gh-arc won't listen on every interface, since it acts with your GitHub login. The rule goes into Apple's `com.apple/*` anchor point, so `/etc/pf.conf` is untouched.
- A LaunchDaemon reloads the rule at startup. It runs only `/sbin/pfctl` on root-owned files; nothing from your home folder runs as root.

`gh arc setup --dry-run` shows the plan and changes nothing; `gh arc setup --remove` undoes all of it. The rule sends everything on 127.0.0.1 port 80 to gh-arc. Under `diffs`, paths drop the `/diffs` prefix (`/11505`, `/<owner>/<repo>/<number>`); `localhost:7799/diffs/…` keeps working. `gh arc` prints `http://diffs/…` URLs once the name reaches it, and the `localhost` form otherwise.

## Chrome extension

`extension/` is a Chrome extension that opens github.com pull requests in Phabricade. Opening `github.com/<owner>/<repo>/pull/<n>`, or its Files, Commits or Checks tab, lands on that pull request's Phabricade page instead; a commit from the Commits tab opens as that one commit. The extension only finds the gh-arc server on your machine and hands the tab to it, so your token stays in the server.

To install it:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder of gh-arc: your clone, or `~/.local/share/gh/extensions/gh-arc/extension` after `gh extension install`.
3. Keep a server running with `gh arc serve` (any `gh arc` starts one).

Then:

- **Back to GitHub**: the **GitHub** link after the branches in the top bar, and every other link from gh-arc to a pull request on GitHub, adds `?gh-arc=off`. That pull request then stays on GitHub in that tab until the tab closes.
- **Off switches**: the extension's toolbar button turns the takeover off everywhere, or only for the repository on screen. On a pull request you kept on GitHub, **Open #n in Phabricade** goes back.
- **No server**: if nothing answers, GitHub's page stays, with a notice saying how to start gh-arc.
- **Where pages open**: `http://diffs/` once `gh arc setup` has run, `http://localhost:7799` otherwise. For a server on another port (`gh arc serve -p 7800`), set the address under **Server** in the toolbar button.
- **Back** returns to the page before the pull request, not to GitHub's copy of it. Landing on the same pull request again within a few seconds of opening it in Phabricade keeps GitHub's page, so nothing can bounce back and forth.

It asks for three permissions:

- `https://github.com/*`, as a content script: to notice pull request pages, including the ones GitHub opens without a page load. It reads only the address. It changes GitHub's page only to keep a new pull request blank for up to a second and a half while it checks for the server, and to show the notice when nothing answers.
- `http://localhost/*`, `http://127.0.0.1/*` and `http://diffs/*`: to check gh-arc's `/api/ping`. GitHub's page can't reach the server itself, so the check runs in the extension.
- `storage`: to remember the off switches and the server address.

## Limits

- GitHub accepts review comments only on lines inside a pull request's hunks, so lines from expanded context can't take comments.
- A range comment stays within one hunk.
- The details show the latest 100 commits, reviews and conversation comments.
- github.com only; GitHub Enterprise isn't wired up.

## Develop

```sh
npm install
npm run vendor:syntax     # refresh the checked-in syntax bundle after updating its pinned package
npm test                  # unit and API tests against an in-memory GitHub
npx playwright test       # the review page and the extension in Chromium, same fake GitHub
```

`tests/support/fake-github.js` stands in for GitHub (`GH_ARC_API_URL`, `GH_ARC_TOKEN`, `GH_ARC_HOME` point gh-arc at it), so no test touches a real pull request.

Syntax highlighting uses the public [highlight.js](https://highlightjs.org/) browser bundle (BSD-3-Clause). Its pinned source package is a development dependency; the vendored bundle and license are in `web/vendor/`, so running Phabricade still needs no runtime packages.

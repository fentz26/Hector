# Hector

A sidebar for GitHub, GitLab and Bitbucket. Browse repositories with an IDE-like code tree, review pull and merge request changes, follow CI/CD runs and their logs, and bookmark what matters. **Every feature is free.** There are no accounts, paid tiers, or tracking.

## Features

- **Code tree** for any repository, branch, tag, or commit. Branch names with slashes are handled.
- **Pull / merge request tree** shows the changed files with their status (A/M/D/R) and +/− counts. Click a file to jump to its diff.
- **Branch graph**: open the Branches tab and click **Graph** to toggle recent commit ancestry, merge lines, and clickable branch labels. Loads up to 30 commits for each of eight branches (default and current first); filter branches to change the selection. Dotted lines mark history beyond the loaded window. Uses GitHub/Primer and GitLab/Pajamas host theme tokens.
- **Fuzzy file search**: type in the sidebar to filter. Use ↑/↓ and Enter to open, Esc to clear.
- **Keyboard navigation**: arrows expand and collapse folders, and Home/End jump to the first and last row.
- **Bookmarks** for repos, PRs, files, and folders, with JSON import and export.
- **Sign in with GitHub** (one click, no token copying) to browse private repositories and raise the API limit from 60 to 5,000 requests/hour. A personal access token also works.
- **GitLab**: gitlab.com and self-managed GitLab CE/EE get the same tree, merge request, CI/CD (pipelines, jobs, logs) and bookmark features. If you're signed in to GitLab in the browser, Hector uses that session for private projects; a personal access token (`read_api`) works too. GitLab's job logs are available while a job runs, so open running jobs follow their log live.
- **Bitbucket Cloud**: bitbucket.org gets the same tree, pull request, Pipelines (steps and logs, live while a step runs), deployments, commits, branches and bookmarks, drawn with Atlassian's look. Public repositories read anonymously; for private ones add an Atlassian API token (`email:token`) or app password (`user:password`) in Hector's settings. Bitbucket Server / Data Center (a different API) is not covered.
- **Self-hosted servers**: GitHub Enterprise, GitLab (CE/EE) and Bitbucket Server / Data Center (also under a context path such as `/code`). Open a repository on the server and click Hector's toolbar button (or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>): Hector recognizes the server from the page and asks once to run there. Or add the domain in the options page, or turn on "Find servers on any site" there (needs access to all websites; pages are only checked locally). On Bitbucket Server, builds are the build statuses other CIs (Jenkins, Bamboo, TeamCity…) report on commits; pull requests list files without line counts.
- **Docked or tucked away** behind a small edge tab (click to open), left or right side, resizable (drag the edge), light/dark/auto theme, adjustable font size.
- **CI/CD tab**: GitHub Actions runs for the branch or pull request you're viewing, with live status, expandable jobs and durations, plus the latest deployment per environment. Open a job to see its steps and full logs right in the sidebar, rendered like GitHub's log viewer: collapsible groups, ANSI colors, clickable links, error/warning annotations, sticky step headers, and log search behind a search icon in the job header (failed step opened first; logs need sign-in). Skipped runs are tucked away behind a toggle, and "Load more" pages back through history. Updates every 15 seconds while something is running, and an open running job follows its steps live every 5 seconds (GitHub's API only provides log text once a job finishes).
- **Settings** open from the gear in the footer and cover the whole sidebar.
- **Tabs**: show or hide Files, Changes, Commits, Branches, CI/CD and Bookmarks from the + menu, and drag them in that menu to reorder (or Alt+↑/↓). With a tab focused, ←/→ switch tabs and Shift+←/→ move them. Hector reopens on the tab you last used on each site, remembers separately which tab you use on pull requests, and every tab keeps its own search text and scroll position while you switch around. Opening a pull request from Files goes to the tab you last used on a pull request (the changed files at first), but leaves CI/CD, Commits, Branches and Bookmarks where you were. The CI/CD tab shows a dot while something is running for the branch or pull request you're on, red when the newest run failed.
- **Split view**: hold a tab icon, Shift+click or middle-click it, to show it below the current tab (drag the divider to resize; hold or Shift+click again, ✕, or Esc in the lower pane, to close). Clicking the lower tab swaps the two. The split comes back on the next page.
- **Branches tab**: branches as a tree by `/` prefix (chains of single folders collapse into one row, folders show how many branches they hold), the default and current branches pinned on top, the last commit's message and age where the site provides them (GitLab, Bitbucket), guide lines, and on hover a copy-name button and a compare-with-default link. The funnel icon sorts by name or recent activity and shows or hides merged branches.
- **CI/CD per repository, from any number of servers**: in the sidebar's Settings on a repository, hide the site's own pipelines and add the repository's external CI servers, as many as it has, of any kind:
  - **TeamCity**: build configuration or project IDs, comma-separated (empty finds the builds of the latest commits). Steps and logs, live while a build runs. A `teamcity.toml` in the repository or GitLab's TeamCity integration is offered in the CI/CD tab; nothing is connected until you say so.
  - **Jenkins**: job paths (`folder/job`), including multibranch pipelines, which pick the branch being viewed. Console output is the log; pipeline stages become the steps. Sign in to Jenkins in the browser, or use `user:apitoken`.
  - **Custom**: any CI behind a JSON endpoint. Give an address with `{sha}`, `{ref}`, `{owner}` and `{repo}` placeholders that answers a list of builds (`id`, `name`, `status`, `url`, `started_at`, `finished_at`, and optionally `log_url`, inline `log` or `steps`); status words from GitHub, GitLab, Jenkins and Buildkite are understood. See `src/content/customci.js` for the exact shape.

  Each server has its own optional access token, sent only to that server, and a connection test that walks through access, sign-in, jobs, builds and the log. Builds from every source share one timeline with the site's own runs (filter by source with the funnel icon). Builds other CIs report as commit statuses are listed too, and open in the sidebar when they belong to a server you added.
- **Fits GitHub's header**: GitHub's top bar spans the page and the sidebar's tabs line up with the repository nav (Code, Issues, Pull requests). The branch, file count and your account (avatar, username, and whether you signed in with GitHub or a token) sit in a status bar at the bottom; hover it for the API budget, which turns red when it runs low.
- **Compact folders** (`src/main/java` shown as one row), file icons colored by type.
- **Large repos**: folders load on demand when GitHub truncates the tree.
- **Expand / collapse all** folders with one button.
- Toggle with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> or the toolbar button.

## Privacy

Hector talks only to the GitHub or GitLab API of the site you're on (and, if you connect one, a repository's TeamCity server). Your token stays in your browser (`chrome.storage.local`); once saved it is never shown again, only replaced. API calls go through the extension's background worker, so the token is never exposed to the page, and each token is only ever sent to the server it was saved for. Responses are cached with ETags, so repeat requests don't count against your rate limit.

## Install (development)

**Chrome / Edge / Brave**
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.

**Firefox**
1. Run `node scripts/build.mjs`.
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`.

## Sign-in setup (maintainers)

Sign-in uses GitHub's OAuth device flow, which needs no client secret. To enable it in a build:

1. Create an OAuth App at <https://github.com/settings/applications/new>. Any homepage and callback URL work, since the device flow doesn't use them.
2. On the app's page, tick **Enable Device Flow** and save.
3. Put the app's **Client ID** in `OAUTH_CLIENT_ID` in `src/background.js`.

## GitLab access

Signed in to GitLab in the same browser? Nothing to set up. Otherwise create a [personal access token with the `read_api` scope](https://gitlab.com/-/user_settings/personal_access_tokens?name=Hector&scopes=read_api) (or the same page on your own server) and paste it into Hector's settings.

## Token (alternative to sign-in)

Create a [classic token with the `repo` scope](https://github.com/settings/tokens/new?scopes=repo&description=Hector) and paste it into Hector's settings. Classic tokens work in organizations that block third-party OAuth apps. If an organization uses SAML SSO, click **Configure SSO → Authorize** next to the token. Fine-grained tokens also work, but each organization has to allow them.

## Build

```sh
node scripts/build.mjs        # dist/hector-{chrome,firefox}-<version>.zip
python3 scripts/gen_icons.py  # regenerate icons/
node test/run.mjs             # unit tests: matching, ANSI, log parsers, CI adapters, bookmarks, backups
```

No dependencies and no bundler. The extension is plain JavaScript.

## Layout

```
manifest.json
src/background.js      API proxy, ETag cache, self-hosted content-script registration
src/content/           sidebar (shadow DOM): API transport, GitHub and GitLab adapters
                       (github.js, gitlab.js), external CI adapters (ci.js registry;
                       teamcity.js, jenkins.js, customci.js), tree, UI
src/options/           settings page
scripts/               build + icon generator
test/                  unit tests (node test/run.mjs); wasm/test/ checks the Rust search
```

## License

[MIT](LICENSE)

## Large repositories: Rust search

Trees of 50,000+ files filter through a small Rust module compiled to WebAssembly (`wasm/`, built to
`src/wasm/hector_core.wasm`, which is committed). It runs in the background worker, so typing stays smooth and
a page's Content-Security-Policy can't block it, and it returns exactly what the JavaScript filter would
(`node wasm/test/parity.mjs src/wasm/hector_core.wasm [paths.txt]` checks that and times both). Smaller
trees, and any browser where it can't load, use the JavaScript filter. To rebuild it: install Rust with the
`wasm32-unknown-unknown` target, then `node scripts/build-wasm.mjs`.

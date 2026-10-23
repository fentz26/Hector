# HectaTree

An IDE-like code tree sidebar for GitHub. Browse repositories and pull requests, jump to any file, and bookmark what matters. **Every feature is free.** There are no accounts, paid tiers, or tracking.

## Features

- **Code tree** for any repository, branch, tag, or commit. Branch names with slashes are handled.
- **Pull request tree** shows the changed files with their status (A/M/D/R) and +/− counts. Click a file to jump to its diff.
- **Fuzzy file search**: type in the sidebar to filter. Use ↑/↓ and Enter to open, Esc to clear.
- **Keyboard navigation**: arrows expand and collapse folders, and Home/End jump to the first and last row.
- **Bookmarks** for repos, PRs, files, and folders, with JSON import and export.
- **Sign in with GitHub** (one click, no token copying) to browse private repositories and raise the API limit from 60 to 5,000 requests/hour. A personal access token also works.
- **GitHub Enterprise**: add your own domains.
- **Docked or hover mode**, left or right side, resizable (drag the edge), light/dark/auto theme, adjustable font size.
- **CI/CD tab**: GitHub Actions runs for the branch or pull request you're viewing, with live status, expandable jobs and durations, plus the latest deployment per environment. Open a job to see its steps and full logs right in the sidebar, rendered like GitHub's log viewer: collapsible groups, ANSI colors, clickable links, error/warning annotations, sticky step headers, and log search (failed step opened first; logs need sign-in). Skipped runs are tucked away behind a toggle, and "Load more" pages back through history. Updates every 15 seconds while something is running, and an open running job follows its steps live every 5 seconds (GitHub's API only provides log text once a job finishes).
- **Tabs**: show or hide Files, Changes, CI/CD and Bookmarks from the + menu, and drag tabs to reorder them.
- **Fits GitHub's header**: GitHub's top bar spans the page and the sidebar's tabs line up with the repository nav (Code, Issues, Pull requests). The branch, file count and your account (avatar, username, and whether you signed in with GitHub or a token) sit in a status bar at the bottom; hover it for the API budget, which turns red when it runs low.
- **Compact folders** (`src/main/java` shown as one row), file icons colored by type.
- **Large repos**: folders load on demand when GitHub truncates the tree.
- **Expand / collapse all** folders with one button.
- Toggle with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> or the toolbar button.

## Privacy

HectaTree talks only to the GitHub API of the site you're on. Your token stays in your browser (`chrome.storage.local`). API calls go through the extension's background worker, so the token is never exposed to the page. Responses are cached with ETags, so repeat requests don't count against your rate limit.

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

## Token (alternative to sign-in)

Create a [classic token with the `repo` scope](https://github.com/settings/tokens/new?scopes=repo&description=HectaTree) and paste it into HectaTree's settings. Classic tokens work in organizations that block third-party OAuth apps. If an organization uses SAML SSO, click **Configure SSO → Authorize** next to the token. Fine-grained tokens also work, but each organization has to allow them.

## Build

```sh
node scripts/build.mjs        # dist/hectatree-{chrome,firefox}-<version>.zip
python3 scripts/gen_icons.py  # regenerate icons/
```

No dependencies and no bundler. The extension is plain JavaScript.

## Layout

```
manifest.json
src/background.js      API proxy, ETag cache, Enterprise content-script registration
src/content/           sidebar (shadow DOM): url parsing, API client, tree, UI
src/options/           settings page
scripts/               build + icon generator
```

## License

[MIT](LICENSE)

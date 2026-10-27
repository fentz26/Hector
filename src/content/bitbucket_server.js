// Bitbucket Server / Data Center adapter (self-hosted Bitbucket). Returns the
// same shapes as github.js. The REST API lives on the server itself, under
// the server's context path ("/rest/api/1.0", or "/code/rest/api/1.0" when
// Bitbucket is served from /code). Public repositories read anonymously,
// others with the browser's Bitbucket session or an HTTP access token.
//
// Bitbucket Server has no pipelines of its own; builds come from the build
// statuses other CIs (Jenkins, Bamboo, TeamCity, …) report on commits.
HT.providers = HT.providers || {};

HT.providers.bitbucketServer = {
  id: 'bitbucket-server',
  site: 'bitbucket', // Atlassian look, like Bitbucket Cloud
  name: 'Bitbucket',
  terms: {
    pull: 'pull request',
    pullRef: (n) => `#${n}`,
    runs: 'Builds',
    run: 'build',
    allRuns: 'All builds',
    noRuns: 'builds',
  },
  liveLogs: false,
  // Builds are other CIs' statuses on commits, listed like GitHub's "Other CI".
  statusCI: true,

  // /<context>/projects/KEY/repos/slug/… or /<context>/users/name/repos/slug/…
  parse(loc) {
    const raw = loc.pathname.split('/');
    const i = raw.findIndex((p, n) => (p === 'projects' || p === 'users') && raw[n + 2] === 'repos' && raw[n + 1] && raw[n + 3]);
    if (i < 1) return null;
    const contextPath = raw.slice(0, i).join('/');
    if (loc === location || loc.href === location.href) this._cp = contextPath;
    const user = raw[i] === 'users';
    const [key, , slug, section, ...rest] = raw.slice(i + 1).map(HT.decodeSegment);
    const base = {
      host: loc.host,
      origin: loc.origin || `https://${loc.host}`,
      contextPath,
      user,
      // The REST API names a personal repository's "project" ~user.
      owner: user ? `~${key}` : key,
      repo: slug,
    };
    const at = this._at(new URLSearchParams(loc.search || '').get('at'));
    if (section === 'pull-requests' && /^\d+$/.test(rest[0] || '')) return { ...base, kind: 'pull', pullNumber: Number(rest[0]), segments: [] };
    if (section === 'commits' && /^[0-9a-f]{7,40}$/i.test(rest[0] || '')) return { ...base, kind: 'commit', sha: rest[0].toLowerCase(), segments: [] };
    // /commits?until=refs/heads/x: a branch's history.
    if (section === 'commits') {
      const until = this._at(new URLSearchParams(loc.search || '').get('until'));
      if (until) return { ...base, kind: 'commits', segments: [], at: until };
    }
    if (section === 'browse') {
      const path = rest.filter(Boolean);
      // The ref travels in ?at=; without one the page shows the default branch.
      if (at || path.length) return { ...base, kind: 'tree', segments: path, at };
    }
    return { ...base, kind: 'repo', segments: [], at };
  },

  // "refs/heads/feature/x" -> "feature/x"; tags and commits stay as they are.
  _at(value) {
    if (!value) return null;
    return value.replace(/^refs\/heads\//, '');
  },

  // ---- links ----
  base(ctx) {
    const owner = ctx.user ? `users/${encodeURIComponent(ctx.owner.slice(1))}` : `projects/${encodeURIComponent(ctx.owner)}`;
    return `${ctx.origin}${ctx.contextPath}/${owner}/repos/${encodeURIComponent(ctx.repo)}`;
  },
  _atQuery(ref) {
    if (!ref) return '';
    const full = /^[0-9a-f]{7,40}$/i.test(ref) || ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return `?at=${encodeURIComponent(full)}`;
  },
  codeUrl(ctx, ref, path) {
    return `${this.base(ctx)}/browse${path ? `/${HT.encodePath(path)}` : ''}${this._atQuery(ref)}`;
  },
  pullUrl(ctx, n) {
    return `${this.base(ctx)}/pull-requests/${n}/overview`;
  },
  diffUrl(ctx, n, anchor) {
    return `${this.base(ctx)}/pull-requests/${n}/diff#${HT.encodePath(anchor)}`;
  },
  onDiffPage(n) {
    return new RegExp(`/pull-requests/${n}/diff/?$`).test(location.pathname);
  },
  ciUrl(ctx) {
    return `${this.base(ctx)}/builds`;
  },
  deploymentsUrl(ctx) {
    return this.base(ctx);
  },
  compareUrl(ctx, base, head) {
    return `${this.base(ctx)}/compare/diff?sourceBranch=${encodeURIComponent(`refs/heads/${head}`)}&targetBranch=${encodeURIComponent(`refs/heads/${base}`)}`;
  },
  commitUrl(ctx, sha) {
    return `${this.base(ctx)}/commits/${sha}`;
  },
  branchUrl(ctx, name) {
    return `${this.base(ctx)}/browse${this._atQuery(name)}`;
  },
  tokenUrl(origin) {
    return `${origin}${this._contextPath()}/plugins/servlet/access-tokens/manage`;
  },
  tokenHint: 'HTTP access token (or user:password)',

  topBar() {
    return document.querySelector('#header, header.aui-header, .aui-header');
  },

  // ---- data ----
  // The context path of the page being viewed (users/ and projects/ pages
  // carry it; elsewhere Bitbucket is assumed at the root).
  _contextPath() {
    return this._cp ?? this.parse(location)?.contextPath ?? '';
  },
  _path(ctx) {
    return `${ctx.contextPath}/rest/api/1.0/projects/${encodeURIComponent(ctx.owner)}/repos/${encodeURIComponent(ctx.repo)}`;
  },

  // Bitbucket Server pages with start / nextPageStart; follow up to `max` pages.
  async _all(path, max = 30, fresh = false, limit = 1000) {
    const out = [];
    let start = 0;
    let last = false;
    for (let page = 0; page < max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const url = `${path}${sep}limit=${limit}&start=${start}`;
      const { data } = await (fresh ? HT.api.request(url) : HT.api.get(url));
      out.push(...(Array.isArray(data?.values) ? data.values : []));
      last = data?.isLastPage !== false || typeof data?.nextPageStart !== 'number';
      if (last) break;
      start = data.nextPageStart;
    }
    return { items: out, more: !last };
  },

  async repo(ctx) {
    let data;
    for (const tail of ['/default-branch', '/branches/default']) {
      try {
        ({ data } = await HT.api.get(`${this._path(ctx)}${tail}`));
        break;
      } catch (err) {
        // 204/404: no default branch yet, or an older server.
        if (![404, 405].includes(err.status) || tail === '/branches/default') throw err;
      }
    }
    if (!data?.displayId) throw Object.assign(new Error('This repository has no commits yet.'), { status: 409 });
    return { defaultBranch: data.displayId, sizeKb: null };
  },

  // The page carries the ref in ?at=; without one it's the default branch
  // (the last of `known`).
  resolveRef(ctx, segments, known) {
    return Promise.resolve({ ref: ctx.at || known[known.length - 1], path: segments.join('/') });
  },

  // The files API lists every file path at a ref (no folders); folders come
  // from the paths. Past 100,000 files, folders load on demand.
  async tree(ctx, ref, onTop) {
    const at = encodeURIComponent(ref);
    const full = this._all(`${this._path(ctx)}/files?at=${at}`, 100);
    if (onTop) {
      const done = await Promise.race([full.then(() => true, () => true), new Promise((res) => setTimeout(() => res(false), 400))]);
      if (!done) this.children(ctx, ref, { path: '' }).then((top) => onTop({ entries: top.map((e) => ({ ...e, path: e.name })), complete: false }), () => {});
    }
    const all = await full;
    if (!all.more) return { entries: all.items.filter((p) => typeof p === 'string').map((path) => ({ path, type: 'blob' })), complete: true };
    const top = await this.children(ctx, ref, { path: '' });
    return { entries: top.map((e) => ({ ...e, path: e.name })), complete: false };
  },

  async children(ctx, ref, node) {
    const dir = node.path ? `/${HT.encodePath(node.path)}` : '';
    const { data } = await HT.api.get(`${this._path(ctx)}/browse${dir}?at=${encodeURIComponent(ref)}&limit=1000`);
    return (data?.children?.values || []).map((e) => ({
      name: e.path?.toString || (e.path?.components || []).join('/'),
      type: e.type === 'DIRECTORY' ? 'tree' : e.type === 'SUBMODULE' ? 'commit' : 'blob',
      size: e.size,
    }));
  },

  async pull(ctx, n) {
    const { data } = await HT.api.get(`${this._path(ctx)}/pull-requests/${n}`);
    return { title: data.title, headSha: data.fromRef?.latestCommit, headRef: data.fromRef?.displayId, baseRef: data.toRef?.displayId, changedFiles: null };
  },

  // The changes API has the files but no line counts.
  pullFiles(ctx, n) {
    return this._changes(`${this._path(ctx)}/pull-requests/${n}/changes?withComments=false`);
  },
  async _changes(path) {
    const { items } = await this._all(path, 10);
    return items.map((c) => {
      const path = c.path?.toString || '';
      const status = { ADD: 'added', DELETE: 'removed', MOVE: 'renamed', COPY: 'added', MODIFY: 'modified' }[c.type] || 'modified';
      return { path, status, additions: 0, deletions: 0, previous: status === 'renamed' ? c.srcPath?.toString : undefined, anchor: path };
    });
  },

  // A commit page: its message and changed files.
  async commitInfo(ctx, sha) {
    const { data } = await HT.api.get(`${this._path(ctx)}/commits/${sha}`);
    return { sha: data.id, title: (data.message || '').split('\n')[0], changedFiles: null };
  },
  // Against the first parent: a merge commit otherwise lists nothing.
  async commitFiles(ctx, sha) {
    const { data } = await HT.api.get(`${this._path(ctx)}/commits/${sha}`);
    const parent = data?.parents?.[0]?.id;
    return this._changes(`${this._path(ctx)}/commits/${sha}/changes${parent ? `?since=${parent}` : ''}`);
  },
  commitDiffUrl(ctx, sha, anchor) {
    return `${this.base(ctx)}/commits/${sha}#${HT.encodePath(anchor)}`;
  },
  onCommitPage(sha) {
    const m = location.pathname.match(/\/commits\/([0-9a-f]{7,40})/i);
    return Boolean(m && sha.startsWith(m[1].toLowerCase()));
  },
  async pullCommits(ctx, n, page, perPage = 30) {
    return this._commitPage(ctx, `${this._path(ctx)}/pull-requests/${n}/commits?limit=${perPage}&start=${(page - 1) * perPage}`);
  },

  // ---- commits and branches ----
  commits(ctx, ref, page, perPage = 30) {
    return this._commitPage(ctx, `${this._path(ctx)}/commits?until=${encodeURIComponent(ref)}&limit=${perPage}&start=${(page - 1) * perPage}`);
  },
  async _commitPage(ctx, path) {
    const { data } = await HT.api.request(path);
    const items = (data?.values || []).map((c) => ({
      sha: c.id,
      parents: (c.parents || []).map((p) => p.id),
      title: (c.message || '').split('\n')[0],
      author: c.author?.displayName || c.author?.name || '',
      date: new Date(c.committerTimestamp || c.authorTimestamp || 0).toISOString(),
      url: this.commitUrl(ctx, c.id),
    }));
    return { items, more: data?.isLastPage === false };
  },
  async branches(ctx) {
    const { items, more } = await this._all(`${this._path(ctx)}/branches?orderBy=MODIFICATION&details=true`, 10, true, 100);
    return {
      items: items.map((b) => {
        const meta = b.metadata?.['com.atlassian.bitbucket.server.bitbucket-branch:latest-commit-metadata'];
        return {
          name: b.displayId,
          sha: b.latestCommit,
          date: meta?.committerTimestamp ? new Date(meta.committerTimestamp).toISOString() : undefined,
          title: (meta?.message || '').split('\n')[0] || undefined,
        };
      }),
      more,
    };
  },

  async recentShas(ctx, ref) {
    const { data } = await HT.api.get(`${this._path(ctx)}/commits?until=${encodeURIComponent(ref)}&limit=5`);
    return (data?.values || []).map((c) => c.id);
  },

  // Who is signed in: the applinks "whoami" servlet answers the user name.
  async user() {
    const cp = this._contextPath();
    const name = String((await HT.api.text(`${cp}/plugins/servlet/applinks/whoami`)) || '').trim();
    if (!name) throw Object.assign(new Error('Not signed in.'), { status: 401 });
    const { data } = await HT.api.request(`${cp}/rest/api/1.0/users/${encodeURIComponent(name)}?avatarSize=48`);
    const avatar = data?.avatarUrl ? new URL(data.avatarUrl, location.origin).href : undefined;
    return { login: data?.slug || name, avatar };
  },

  // ---- CI/CD: no pipelines of its own ----
  async runs() {
    return { runs: [], total: 0, more: false };
  },
  async deployments() {
    return [];
  },
  async jobs() {
    return [];
  },
  async job() {
    throw new Error('Bitbucket Server has no pipelines.');
  },
  async log() {
    return null;
  },
  steps() {
    return { steps: [], byStep: null };
  },

  // Build statuses from other CIs on a commit.
  async externalStatuses(ctx, sha) {
    const { items } = await this._all(`${ctx.contextPath}/rest/build-status/1.0/commits/${encodeURIComponent(sha)}`, 2, true, 100);
    return items.map((st) => {
      const [status, conclusion] = bbStatus(st.state, st.state);
      return {
        id: `st:${st.key}`,
        name: st.name || st.key,
        status,
        conclusion,
        html_url: HT.safeUrl(st.url),
        description: st.description,
        started_at: st.dateAdded ? new Date(st.dateAdded).toISOString() : null,
        completed_at: status === 'completed' && st.dateAdded ? new Date(st.dateAdded).toISOString() : null,
        external: true,
        ci: HT.ciSystem(st.name, st.url),
      };
    });
  },

  // A text file from the repository, or throws (404 when it doesn't exist).
  repoFile(ctx, ref, path) {
    return HT.api.text(`${this._path(ctx)}/raw/${HT.encodePath(path)}?at=${encodeURIComponent(ref)}`);
  },

  // ---- pull requests (their tab); issues live in Jira ----
  pullsUrl(ctx) {
    return `${this.base(ctx)}/pull-requests`;
  },
  async pulls(ctx, state, page) {
    const s = { open: 'OPEN', merged: 'MERGED', closed: 'DECLINED', all: 'ALL' }[state] || 'OPEN';
    const { data } = await HT.api.get(`${this._path(ctx)}/pull-requests?state=${s}&order=NEWEST&limit=50&start=${(page - 1) * 50}`);
    const items = (data?.values || []).map((p) => ({
      number: p.id,
      title: p.title,
      state: p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? (p.draft ? 'draft' : 'open') : 'closed',
      author: p.author?.user?.displayName || p.author?.user?.name,
      created: p.createdDate ? new Date(p.createdDate).toISOString() : null,
      date: p.updatedDate ? new Date(p.updatedDate).toISOString() : null,
      head: p.fromRef?.displayId,
      base: p.toRef?.displayId,
      comments: p.properties?.commentCount,
      url: p.links?.self?.[0]?.href || this.pullUrl(ctx, p.id),
    }));
    return { items, more: data?.isLastPage === false };
  },
  // The diff API answers in hunks and segments; made into a unified diff here.
  async filePatch(ctx, target, node) {
    const file = HT.encodePath(node.path);
    let path;
    if (target.pull) path = `${this._path(ctx)}/pull-requests/${target.pull}/diff/${file}?contextLines=3&withComments=false`;
    else {
      const { data: commit } = await HT.api.get(`${this._path(ctx)}/commits/${target.sha}`);
      const parent = commit?.parents?.[0]?.id;
      path = `${this._path(ctx)}/commits/${target.sha}/diff/${file}?contextLines=3&withComments=false${parent ? `&since=${parent}` : ''}`;
    }
    const { data } = await HT.api.get(path);
    const diff = data?.diffs?.[0];
    if (!diff || diff.binary) return null;
    const mark = { ADDED: '+', REMOVED: '-', CONTEXT: ' ' };
    const out = [];
    for (const hunk of diff.hunks || []) {
      out.push(`@@ -${hunk.sourceLine},${hunk.sourceSpan} +${hunk.destinationLine},${hunk.destinationSpan} @@`);
      for (const seg of hunk.segments || []) for (const l of seg.lines || []) out.push(`${mark[seg.type] || ' '}${l.line}`);
    }
    return out.join('\n');
  },
};

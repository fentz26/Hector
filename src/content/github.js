// GitHub (github.com and Enterprise Server) adapter. Every provider returns
// the same shapes, so the sidebar doesn't care which site it's on:
//   repo     { defaultBranch }
//   pull     { title, headSha, headRef, changedFiles }
//   file     { path, status, additions, deletions, previous, anchor }
//   run      { id, name, run_number, display_title, event, status, conclusion, html_url, run_started_at, created_at }
//   job      { id, name, status, conclusion, html_url, started_at, completed_at, steps }
//   status   'queued' | 'in_progress' | 'completed'; conclusion as GitHub names them
HT.providers = HT.providers || {};

const GITHUB_RESERVED = new Set([
  '', 'about', 'account', 'apps', 'blog', 'business', 'codespaces', 'collections', 'contact', 'copilot',
  'customer-stories', 'dashboard', 'enterprise', 'enterprises', 'events', 'explore', 'features', 'github-copilot',
  'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing',
  'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'stars', 'team',
  'topics', 'trending', 'users', 'watching', 'discussions', 'resources', 'solutions', 'partners', 'mobile', 'home',
]);

HT.providers.github = {
  id: 'github',
  name: 'GitHub',
  terms: {
    pull: 'pull request',
    pullRef: (n) => `#${n}`,
    runs: 'Workflow runs',
    run: 'run',
    allRuns: 'All runs',
    noRuns: 'workflow runs',
  },
  liveLogs: false,

  parse(loc) {
    const parts = loc.pathname.split('/').filter(Boolean).map(HT.decodeSegment);
    const [owner, repo, section, ...rest] = parts;
    if (!owner || !repo || GITHUB_RESERVED.has(owner.toLowerCase())) return null;
    const base = { host: loc.host, origin: loc.origin || `https://${loc.host}`, owner, repo: repo.replace(/\.git$/, '') };
    if (section === 'pull' && /^\d+$/.test(rest[0] || '')) {
      return { ...base, kind: 'pull', pullNumber: Number(rest[0]), segments: [] };
    }
    if (section === 'tree' || section === 'blob') return { ...base, kind: section, segments: rest };
    if (section === 'commit' && /^[0-9a-f]{7,40}$/i.test(rest[0] || '')) return { ...base, kind: 'commit', sha: rest[0].toLowerCase(), segments: [] };
    // /commits/<ref>: a branch's history.
    if (section === 'commits' && rest.length) return { ...base, kind: 'commits', segments: rest };
    return { ...base, kind: 'repo', segments: [] };
  },

  // ---- links ----
  base(ctx) {
    return `${ctx.origin}/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`;
  },
  codeUrl(ctx, ref, path, dir) {
    return `${this.base(ctx)}/${dir ? 'tree' : 'blob'}/${HT.encodePath(ref)}/${HT.encodePath(path)}`;
  },
  pullUrl(ctx, n) {
    return `${this.base(ctx)}/pull/${n}`;
  },
  diffUrl(ctx, n, anchor) {
    return `${this.base(ctx)}/pull/${n}/files#${anchor}`;
  },
  onDiffPage(n) {
    return new RegExp(`/pull/${n}/(files|changes)`).test(location.pathname);
  },
  ciUrl(ctx) {
    return `${this.base(ctx)}/actions`;
  },
  deploymentsUrl(ctx) {
    return `${this.base(ctx)}/deployments`;
  },
  tokenUrl(origin) {
    return `${origin}/settings/tokens/new?scopes=repo&description=Hector`;
  },
  tokenHint: 'github_pat_… or ghp_…',

  // ---- data ----
  _path(ctx) {
    return `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`;
  },

  async repo(ctx) {
    const { data } = await HT.api.get(this._path(ctx));
    return { defaultBranch: data.default_branch, sizeKb: data.size };
  },

  resolveRef(ctx, segments, known) {
    return HT.api.resolveRef(segments, known, async (prefix) => {
      const names = [];
      for (const kind of ['heads', 'tags']) {
        const { data } = await HT.api.get(`${this._path(ctx)}/git/matching-refs/${kind}/${encodeURIComponent(prefix)}`).catch(() => ({ data: [] }));
        for (const ref of data || []) names.push(ref.ref.replace(/^refs\/(heads|tags)\//, ''));
      }
      return names;
    });
  },

  // { entries: [{ path, type, sha }], complete } — a truncated listing falls
  // back to the top level, with folders loaded on demand.
  // GitHub's own "Go to file" list: every path of a commit or tree, past the
  // API listing's 100k-entry / 7 MB cut-off, in one small response and without
  // using API quota. Not a documented API, so callers fall back when it fails.
  // Same-origin only: it needs the page's own session for private repositories.
  async treeList(ctx, sha) {
    const base = this.base(ctx);
    if (new URL(base).origin !== location.origin) throw new Error('not same-origin');
    const res = await fetch(`${base}/tree-list/${sha}`, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`file list ${res.status}`);
    const { paths } = await res.json();
    if (!Array.isArray(paths) || !paths.length) throw new Error('empty file list');
    // Paths only: folders come from the paths, and files carry no size or hash.
    return paths.map((path) => ({ path, type: 'blob' }));
  },

  // `onTop({ entries, complete: false })` is called with the top level when the
  // full listing is slow (big repositories take seconds), so there is
  // something to show meanwhile. The returned listing is the final answer.
  async tree(ctx, ref, onTop, { huge = false } = {}) {
    const url = `${this._path(ctx)}/git/trees/${HT.encodePath(ref)}`;
    // Too big for one API listing: the complete path list, else the top level
    // with folders loaded as they are opened.
    const tooBig = async () => {
      const { data: top } = await HT.api.get(url);
      const entries = await this.treeList(ctx, top.sha).catch(() => null);
      return entries ? { entries, complete: true } : { entries: top.tree, complete: false };
    };
    // Multi-gigabyte repositories never fit the API listing (the Linux kernel's
    // is cut off after ~70k files, a 17 MB download), so don't fetch it.
    if (huge) {
      if (onTop) HT.api.get(url).then(({ data }) => onTop({ entries: data.tree, complete: false }), () => {});
      return tooBig();
    }
    const recursive = HT.api.get(`${url}?recursive=1`);
    if (onTop) {
      const done = await Promise.race([recursive.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 400))]);
      if (!done) HT.api.get(url).then(({ data }) => onTop({ entries: data.tree, complete: false }), () => {});
    }
    const { data } = await recursive;
    return data.truncated ? tooBig() : { entries: data.tree, complete: true };
  },

  // A folder's direct children: [{ name, type, sha, size }].
  async children(ctx, ref, node) {
    const { data } = await HT.api.get(`${this._path(ctx)}/git/trees/${node.sha}`);
    return data.tree.map((e) => ({ name: e.path, type: e.type, sha: e.sha, size: e.size }));
  },

  async pull(ctx, n) {
    const { data } = await HT.api.get(`${this._path(ctx)}/pulls/${n}`);
    return { title: data.title, headSha: data.head.sha, headRef: data.head.ref, baseRef: data.base?.ref, changedFiles: data.changed_files };
  },

  // GitHub caps this endpoint at 3000 files (30 pages of 100).
  async pullFiles(ctx, n, expected = Infinity) {
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const { data, link } = await HT.api.get(`${this._path(ctx)}/pulls/${n}/files?per_page=100&page=${page}`);
      files.push(...data);
      if (data.length < 100 || files.length >= expected || !/rel="next"/.test(link || '')) break;
    }
    return Promise.all(
      files.map(async (f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        previous: f.previous_filename,
        anchor: `diff-${await HT.sha256Hex(f.filename)}`,
        // Absent for binary files and very large diffs.
        patch: f.patch,
      }))
    );
  },

  // A commit page: its message and changed files (GitHub lists up to 300
  // per page, 3000 in all).
  async commitInfo(ctx, sha) {
    const { data } = await HT.api.get(`${this._path(ctx)}/commits/${sha}?per_page=100&page=1`);
    return { sha: data.sha, title: (data.commit?.message || '').split('\n')[0], changedFiles: data.files?.length ?? null };
  },
  async commitFiles(ctx, sha) {
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const { data, link } = await HT.api.get(`${this._path(ctx)}/commits/${sha}?per_page=100&page=${page}`);
      files.push(...(data.files || []));
      if (!/rel="next"/.test(link || '')) break;
    }
    return Promise.all(
      files.map(async (f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        previous: f.previous_filename,
        anchor: `diff-${await HT.sha256Hex(f.filename)}`,
        // Absent for binary files and very large diffs.
        patch: f.patch,
      }))
    );
  },
  commitDiffUrl(ctx, sha, anchor) {
    return `${this.base(ctx)}/commit/${sha}#${anchor}`;
  },
  onCommitPage(sha) {
    const m = location.pathname.match(/\/commit\/([0-9a-f]{7,40})/i);
    return Boolean(m && sha.startsWith(m[1].toLowerCase()));
  },
  // A pull request's own commits, newest first (GitHub lists up to 250).
  async pullCommits(ctx, n, page) {
    if (page > 1) return { items: [], more: false };
    const all = [];
    for (let p = 1; p <= 3; p++) {
      const { data } = await HT.api.request(`${this._path(ctx)}/pulls/${n}/commits?per_page=100&page=${p}`);
      all.push(...(data || []));
      if ((data || []).length < 100) break;
    }
    return { items: all.reverse().map((c) => this._commit(c)), more: false };
  },
  _commit(c) {
    return {
      sha: c.sha,
      parents: (c.parents || []).map((p) => p.sha),
      title: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || '',
      date: c.commit?.committer?.date || c.commit?.author?.date,
      url: c.html_url,
    };
  },

  // The latest commits on a branch (for matching TeamCity builds).
  // A text file from the repository, or throws (404 when it doesn't exist).
  async repoFile(ctx, ref, path) {
    const { data } = await HT.api.get(`${this._path(ctx)}/contents/${HT.encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (!data?.content) return null;
    return new TextDecoder().decode(Uint8Array.from(atob(data.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  },

  // ---- commits and branches ----
  commitUrl(ctx, sha) {
    return `${this.base(ctx)}/commit/${sha}`;
  },
  branchUrl(ctx, name) {
    return this.codeUrl(ctx, name, '', true);
  },
  compareUrl(ctx, base, head) {
    return `${this.base(ctx)}/compare/${HT.encodePath(base)}...${HT.encodePath(head)}`;
  },
  async commits(ctx, ref, page, perPage = 30) {
    const { data } = await HT.api.request(`${this._path(ctx)}/commits?sha=${encodeURIComponent(ref)}&per_page=${perPage}&page=${page}`);
    const items = (data || []).map((c) => this._commit(c));
    return { items, more: items.length === perPage };
  },
  async branches(ctx) {
    const items = [];
    let more = false;
    for (let page = 1; page <= 10; page++) {
      const { data } = await HT.api.request(`${this._path(ctx)}/branches?per_page=100&page=${page}`);
      items.push(...(data || []).map((b) => ({ name: b.name, sha: b.commit?.sha, protected: b.protected })));
      if ((data || []).length < 100) break;
      more = page === 10;
    }
    return { items, more };
  },

  async recentShas(ctx, ref) {
    const { data } = await HT.api.get(`${this._path(ctx)}/commits?sha=${encodeURIComponent(ref)}&per_page=5`);
    return (data || []).map((c) => c.sha);
  },

  async user() {
    const { data } = await HT.api.request('/user');
    return { login: data.login, avatar: data.avatar_url };
  },

  // ---- CI/CD (Actions) ----
  // target: { key, label, sha?, ref? }
  async runs(ctx, target, limit) {
    // GitHub pages runs 100 at a time; "Load more" raises the limit.
    const perPage = Math.min(limit, 100);
    const query = target.sha ? `head_sha=${target.sha}` : `branch=${encodeURIComponent(target.ref)}`;
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(limit / perPage) }, (_, i) =>
        HT.api.request(`${this._path(ctx)}/actions/runs?per_page=${perPage}&page=${i + 1}&${query}`)
      )
    );
    const runs = pages.flatMap((r) => r.data.workflow_runs || []);
    const total = pages[0].data.total_count;
    return { runs, total, more: runs.length < total };
  },

  // Latest deployment per environment, with its latest status.
  async deployments(ctx, target) {
    const filter = target.sha ? `&sha=${target.sha}` : '';
    const { data } = await HT.api.request(`${this._path(ctx)}/deployments?per_page=30${filter}`);
    const latest = new Map();
    for (const d of data || []) if (!latest.has(d.environment)) latest.set(d.environment, d);
    return Promise.all(
      [...latest.values()].slice(0, 8).map(async (d) => {
        const { data: statuses } = await HT.api.request(`${this._path(ctx)}/deployments/${d.id}/statuses?per_page=1`).catch(() => ({ data: [] }));
        const st = statuses?.[0];
        const state = st?.state || 'pending';
        return {
          id: d.id,
          environment: d.environment,
          ref: d.ref,
          state,
          busy: Boolean(st) && ['pending', 'queued', 'in_progress'].includes(state),
          when: st?.created_at || d.created_at,
          url: HT.safeUrl(st?.environment_url || st?.log_url || st?.target_url) || this.deploymentsUrl(ctx),
        };
      })
    );
  },

  // Checks and statuses on a commit from anything but GitHub Actions
  // (TeamCity, Jenkins, CircleCI, …), as jobs.
  async externalStatuses(ctx, sha) {
    const [checks, combined] = await Promise.all([
      HT.api.request(`${this._path(ctx)}/commits/${sha}/check-runs?per_page=100`).then((r) => r.data.check_runs || [], () => []),
      HT.api.request(`${this._path(ctx)}/commits/${sha}/status`).then((r) => r.data.statuses || [], () => []),
    ]);
    const fromChecks = checks
      .filter((c) => c.app?.slug !== 'github-actions')
      .map((c) => ({
        id: `cr:${c.id}`,
        name: c.name,
        status: c.status === 'completed' ? 'completed' : c.status === 'in_progress' ? 'in_progress' : 'queued',
        conclusion: c.conclusion,
        html_url: c.details_url || c.html_url,
        description: c.output?.title,
        started_at: c.started_at,
        completed_at: c.completed_at,
        external: true,
        ci: c.app?.name || HT.ciSystem(c.name, c.details_url),
      }));
    const fromStatuses = combined.map((st) => ({
      id: `st:${st.id}`,
      name: st.context,
      status: st.state === 'pending' ? 'queued' : 'completed',
      conclusion: st.state === 'pending' ? null : st.state === 'success' ? 'success' : 'failure',
      html_url: st.target_url,
      description: st.description,
      started_at: st.created_at,
      completed_at: st.state === 'pending' ? null : st.updated_at,
      external: true,
      ci: HT.ciSystem(st.context, st.target_url),
    }));
    return [...fromChecks, ...fromStatuses];
  },

  async jobs(ctx, runId) {
    const { data } = await HT.api.request(`${this._path(ctx)}/actions/runs/${runId}/jobs?per_page=50`);
    return data.jobs || [];
  },

  async job(ctx, jobId) {
    return (await HT.api.request(`${this._path(ctx)}/actions/jobs/${jobId}`)).data;
  },

  log(ctx, job) {
    return HT.api.text(`${this._path(ctx)}/actions/jobs/${job.id}/logs`);
  },

  // Steps come from the API; the log is split between them by time. Step
  // times only have whole seconds, so move to the next step once the current
  // one has ended, or when a step's first line ("##[group]Run …", "Post job
  // cleanup.", …) shows up after the next step has started. Skipped steps
  // print nothing.
  steps(job, text) {
    const steps = job.steps || [];
    if (text == null) return { steps, byStep: null };
    const sec = (iso) => Math.floor(new Date(iso) / 1000);
    const order = steps
      .filter((s) => s.started_at)
      .map((s) => ({ number: s.number, skipped: s.conclusion === 'skipped', start: sec(s.started_at), end: s.completed_at ? sec(s.completed_at) : Infinity }))
      .sort((a, b) => a.start - b.start || a.number - b.number);
    const byStep = new Map(steps.map((s) => [s.number, []]));
    let i = 0;
    for (const raw of text.replace(/^﻿/, '').replace(/\r?\n$/, '').split(/\r?\n/)) {
      const m = raw.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/);
      // Colors stay in the line; the viewer renders them.
      const line = m ? m[2] : raw;
      if (m) {
        const at = sec(m[1]);
        const header = /^(##\[group\]Run |Post job cleanup\.|Cleaning up orphan processes)/.test(HT.stripAnsi(line));
        let next = i + 1;
        if (header) while (next < order.length && order[next].skipped) next++;
        if (header && next < order.length && order[next].start <= at) i = next;
        else while (i + 1 < order.length && at > order[i].end) i++;
      }
      if (order[i]) byStep.get(order[i].number).push(line);
    }
    return { steps, byStep };
  },

  // ---- pull requests and issues (their tabs), newest activity first ----
  pullsUrl(ctx) {
    return `${this.base(ctx)}/pulls`;
  },
  issuesUrl(ctx) {
    return `${this.base(ctx)}/issues`;
  },
  // state: open | merged | closed | all. GitHub can't ask for merged ones
  // alone: those are the closed ones with a merge date.
  async pulls(ctx, state, page) {
    const s = state === 'merged' ? 'closed' : state;
    const { data } = await HT.api.get(`${this._path(ctx)}/pulls?state=${s}&sort=updated&direction=desc&per_page=50&page=${page}`);
    const items = (data || []).map((p) => ({
      number: p.number,
      title: p.title,
      state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
      author: p.user?.login,
      date: p.updated_at,
      head: p.head?.ref,
      base: p.base?.ref,
      url: p.html_url,
    }));
    return { items: state === 'merged' ? items.filter((p) => p.state === 'merged') : items, more: (data || []).length === 50 };
  },
  // The issues list also holds pull requests; those stay in their own tab.
  async issues(ctx, state, page) {
    const { data } = await HT.api.get(`${this._path(ctx)}/issues?state=${state}&sort=updated&direction=desc&per_page=50&page=${page}`);
    const items = (data || [])
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state === 'closed' ? 'closed' : 'open',
        author: i.user?.login,
        date: i.updated_at,
        labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
        comments: i.comments,
        url: i.html_url,
      }));
    return { items, more: (data || []).length === 50 };
  },
  // One file's diff: GitHub sends it with the file list.
  async filePatch(ctx, target, node) {
    return node.patch ?? null;
  },
};

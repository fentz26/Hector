// Bitbucket Cloud (bitbucket.org) adapter. Returns the same shapes as
// github.js. The API lives on api.bitbucket.org/2.0 (the background worker
// maps the site to it); public repositories read anonymously, private ones
// with an Atlassian API token ("email:token") or app password
// ("user:password"), sent as HTTP Basic.
//
// Bitbucket Server / Data Center has a different API and URL layout and is
// not covered here.
HT.providers = HT.providers || {};

// First path segments that are never a workspace, and second ones that are
// never a repository.
const BB_RESERVED = new Set([
  '', '!api', 'about', 'account', 'api', 'blog', 'dashboard', 'developers', 'features', 'gateway', 'help', 'ide', 'legal', 'login',
  'oauth2', 'plans', 'pricing', 'product', 'repo', 'search', 'signup', 'site', 'snippets', 'socket', 'static', 'support', 'teams',
  'whats-new', 'xf',
]);
const BB_NOT_REPO = new Set(['workspace', 'profile', 'projects', 'snippets']);

// Bitbucket's state names in GitHub's terms: [status, conclusion].
function bbStatus(state, result) {
  const s = String(state || '').toUpperCase();
  const r = String(result || '').toUpperCase();
  if (s === 'IN_PROGRESS' || s === 'INPROGRESS' || s === 'RUNNING') return ['in_progress', null];
  if (s === 'PENDING' || s === 'READY' || s === 'NOT_RUN' && !r) return ['queued', null];
  if (s === 'PAUSED' || s === 'HALTED') return ['completed', 'action_required'];
  const map = { SUCCESSFUL: 'success', FAILED: 'failure', ERROR: 'failure', STOPPED: 'cancelled', EXPIRED: 'cancelled', SKIPPED: 'skipped', NOT_RUN: 'skipped' };
  return ['completed', map[r || s] || (r || s ? 'failure' : null)];
}

HT.providers.bitbucket = {
  id: 'bitbucket',
  name: 'Bitbucket',
  terms: {
    pull: 'pull request',
    pullRef: (n) => `#${n}`,
    runs: 'Pipelines',
    run: 'pipeline',
    allRuns: 'All pipelines',
    noRuns: 'pipelines',
  },
  // A step's log is served while it runs.
  liveLogs: true,

  parse(loc) {
    const parts = loc.pathname.split('/').filter(Boolean).map(HT.decodeSegment);
    const [owner, repo, section, ...rest] = parts;
    if (!owner || !repo || BB_RESERVED.has(owner.toLowerCase()) || BB_NOT_REPO.has(repo.toLowerCase())) return null;
    const base = { host: loc.host, origin: loc.origin || `https://${loc.host}`, owner, repo };
    if (section === 'pull-requests' && /^\d+$/.test(rest[0] || '')) {
      return { ...base, kind: 'pull', pullNumber: Number(rest[0]), segments: [] };
    }
    // /src/<ref or hash>/<path>; a branch with "/" in its name travels as
    // /src/<hash>/<path>?at=<branch>.
    if (section === 'src' && rest.length) {
      const at = new URLSearchParams(loc.search || '').get('at');
      return { ...base, kind: 'tree', segments: rest, at: at || null };
    }
    if (section === 'branch' && rest.length) return { ...base, kind: 'tree', segments: [rest.join('/')], at: rest.join('/') };
    return { ...base, kind: 'repo', segments: [] };
  },

  // ---- links ----
  base(ctx) {
    return `${ctx.origin}/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`;
  },
  codeUrl(ctx, ref, path, dir) {
    const tail = `${HT.encodePath(path)}${dir && path ? '/' : ''}`;
    // Refs with "/" go through their commit, with the branch in ?at=.
    if (ref.includes('/')) {
      const hash = this._hashes.get(`${HT.url.repoKey(ctx)}:${ref}`);
      if (hash) return `${this.base(ctx)}/src/${hash}/${tail}?at=${encodeURIComponent(ref)}`;
    }
    return `${this.base(ctx)}/src/${encodeURIComponent(ref)}/${tail}`;
  },
  pullUrl(ctx, n) {
    return `${this.base(ctx)}/pull-requests/${n}`;
  },
  diffUrl(ctx, n, anchor) {
    return `${this.base(ctx)}/pull-requests/${n}/diff#${anchor}`;
  },
  onDiffPage(n) {
    return new RegExp(`/pull-requests/${n}(/diff)?/?$`).test(location.pathname);
  },
  ciUrl(ctx) {
    return `${this.base(ctx)}/pipelines`;
  },
  deploymentsUrl(ctx) {
    return `${this.base(ctx)}/deployments`;
  },
  compareUrl(ctx, base, head) {
    return `${this.base(ctx)}/branches/compare/${encodeURIComponent(head)}%0D${encodeURIComponent(base)}`;
  },
  tokenUrl() {
    return 'https://id.atlassian.com/manage-profile/security/api-tokens';
  },
  tokenHint: 'email:api-token or user:app-password',

  // Bitbucket's own top bar is fixed across the page; the sidebar starts
  // under it.
  topBar() {
    return document.querySelector('[data-testid="atlassian-navigation-header"], header[role="banner"], nav[aria-label="Primary"]');
  },

  // ---- data ----
  _path(ctx) {
    return `/repositories/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`;
  },
  _hashes: new Map(), // "repoKey:branch" -> commit hash (for links to branches with "/")

  // Follow `next` links up to `max` pages. `fresh` skips the page memo.
  async _all(path, max = 30, fresh = false) {
    const out = [];
    let next = path;
    for (let page = 0; next && page < max; page++) {
      const { data } = await (fresh ? HT.api.request(next) : HT.api.get(next));
      out.push(...(Array.isArray(data?.values) ? data.values : []));
      next = typeof data?.next === 'string' ? data.next.replace(/^https?:\/\/[^/]+\/2\.0/, '') : null;
      if (next && !next.startsWith('/')) next = null;
    }
    return { items: out, more: Boolean(next) };
  },

  async repo(ctx) {
    const { data } = await HT.api.get(`${this._path(ctx)}?fields=mainbranch.name,size`);
    if (!data.mainbranch?.name) throw Object.assign(new Error('This repository has no commits yet.'), { status: 409 });
    return { defaultBranch: data.mainbranch.name, sizeKb: Math.round((data.size || 0) / 1024) };
  },

  resolveRef(ctx, segments, known) {
    // The page already names the branch when it has a "/" in it.
    if (ctx.at) {
      const hash = segments[0];
      if (/^[0-9a-f]{7,40}$/i.test(hash)) this._hashes.set(`${HT.url.repoKey(ctx)}:${ctx.at}`, hash);
      return Promise.resolve({ ref: ctx.at, path: segments.slice(1).join('/') });
    }
    return HT.api.resolveRef(segments, known, async (prefix) => {
      const q = encodeURIComponent(`name~"${prefix}"`);
      const lists = await Promise.all(
        ['branches', 'tags'].map((kind) => this._all(`${this._path(ctx)}/refs/${kind}?q=${q}&pagelen=100&fields=values.name,next`, 3).catch(() => ({ items: [] })))
      );
      return lists.flatMap((l) => l.items.map((r) => r.name));
    });
  },

  // The commit a ref points at (the src API takes either, but a branch with
  // "/" in its name can't go in the path).
  async _hash(ctx, ref) {
    if (/^[0-9a-f]{7,40}$/i.test(ref)) return ref;
    const key = `${HT.url.repoKey(ctx)}:${ref}`;
    if (this._hashes.has(key)) return this._hashes.get(key);
    for (const kind of ['branches', 'tags']) {
      try {
        const { data } = await HT.api.get(`${this._path(ctx)}/refs/${kind}/${encodeURIComponent(ref)}?fields=target.hash`);
        if (data?.target?.hash) {
          this._hashes.set(key, data.target.hash);
          return data.target.hash;
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    return ref;
  },

  // The src API pages 100 entries at a time, files and folders together,
  // to any depth; past 5,000 entries folders load on demand.
  async tree(ctx, ref, onTop) {
    const hash = await this._hash(ctx, ref);
    const fields = 'fields=values.type,values.path,values.size,next';
    const map = (e) => ({ path: e.path, type: e.type === 'commit_directory' ? 'tree' : 'blob', size: e.size });
    const topPath = `${this._path(ctx)}/src/${hash}/?pagelen=100&${fields}`;
    const full = this._all(`${this._path(ctx)}/src/${hash}/?max_depth=20&pagelen=100&${fields}`, 50);
    if (onTop) {
      const done = await Promise.race([full.then(() => true, () => true), new Promise((res) => setTimeout(() => res(false), 400))]);
      if (!done) this._all(topPath, 20).then((top) => onTop({ entries: top.items.map(map), complete: false }), () => {});
    }
    const all = await full;
    if (!all.more) return { entries: all.items.map(map), complete: true };
    const top = await this._all(topPath, 20);
    return { entries: top.items.map(map), complete: false };
  },

  async children(ctx, ref, node) {
    const hash = await this._hash(ctx, ref);
    const { items } = await this._all(`${this._path(ctx)}/src/${hash}/${HT.encodePath(node.path)}/?pagelen=100&fields=values.type,values.path,values.size,next`, 20);
    return items.map((e) => ({ name: e.path.split('/').pop(), type: e.type === 'commit_directory' ? 'tree' : 'blob', size: e.size }));
  },

  async pull(ctx, n) {
    const { data } = await HT.api.get(`${this._path(ctx)}/pullrequests/${n}?fields=title,source.branch.name,source.commit.hash,destination.branch.name`);
    return { title: data.title, headSha: data.source?.commit?.hash, headRef: data.source?.branch?.name, baseRef: data.destination?.branch?.name, changedFiles: null };
  },

  // The diffstat redirects to a cached copy on the same API host.
  async pullFiles(ctx, n) {
    const { items } = await this._all(
      `${this._path(ctx)}/pullrequests/${n}/diffstat?pagelen=500&fields=values.status,values.lines_added,values.lines_removed,values.old.path,values.new.path,next`,
      10
    );
    return items.map((d) => {
      const path = d.new?.path || d.old?.path || '';
      const status = { added: 'added', removed: 'removed', renamed: 'renamed', modified: 'modified' }[d.status] || 'modified';
      return {
        path,
        status,
        additions: d.lines_added || 0,
        deletions: d.lines_removed || 0,
        previous: status === 'renamed' ? d.old?.path : undefined,
        // Bitbucket's pull request page anchors each file as "chg-<path>".
        anchor: `chg-${path}`,
      };
    });
  },

  // ---- commits and branches ----
  commitUrl(ctx, sha) {
    return `${this.base(ctx)}/commits/${sha}`;
  },
  branchUrl(ctx, name) {
    return `${this.base(ctx)}/branch/${HT.encodePath(name)}`;
  },
  _commitPages: new Map(), // "repoKey:ref" -> [path of page 1, page 2, …]
  async commits(ctx, ref, page, perPage = 30) {
    const key = `${HT.url.repoKey(ctx)}:${ref}`;
    const pages = this._commitPages.get(key) || [`${this._path(ctx)}/commits/${encodeURIComponent(ref)}?pagelen=${perPage}&fields=values.hash,values.message,values.author,values.date,values.links.html.href,next`];
    // Bitbucket pages commits with cursors, so page N is reached through page N-1.
    if (!pages[page - 1]) return { items: [], more: false };
    const { data } = await HT.api.request(pages[page - 1]);
    const next = typeof data?.next === 'string' ? data.next.replace(/^https?:\/\/[^/]+\/2\.0/, '') : null;
    if (next?.startsWith('/')) pages[page] = next;
    this._commitPages.set(key, pages);
    const items = (data?.values || []).map((c) => ({
      sha: c.hash,
      title: (c.message || '').split('\n')[0],
      author: c.author?.user?.display_name || (c.author?.raw || '').replace(/\s*<[^>]*>\s*$/, ''),
      date: c.date,
      url: c.links?.html?.href,
    }));
    return { items, more: Boolean(next) };
  },
  async branches(ctx) {
    const { items, more } = await this._all(
      `${this._path(ctx)}/refs/branches?pagelen=100&sort=-target.date&fields=values.name,values.target.hash,values.target.date,values.target.message,next`,
      10,
      true
    );
    return {
      items: items.map((b) => ({ name: b.name, sha: b.target?.hash, date: b.target?.date, title: (b.target?.message || '').split('\n')[0] })),
      more,
    };
  },

  async recentShas(ctx, ref) {
    const { data } = await HT.api.get(`${this._path(ctx)}/commits/${encodeURIComponent(ref)}?pagelen=5&fields=values.hash`);
    return (data?.values || []).map((c) => c.hash);
  },

  async user() {
    const { data } = await HT.api.request('/user?fields=username,nickname,display_name,links.avatar.href');
    return { login: data.username || data.nickname || data.display_name, avatar: data.links?.avatar?.href };
  },

  // ---- CI/CD (Pipelines) ----
  _run(ctx, p) {
    const [status, conclusion] = bbStatus(p.state?.name, p.state?.result?.name || p.state?.stage?.name);
    const sel = p.target?.selector;
    return {
      id: p.uuid,
      name: sel?.pattern ? (sel.type === 'custom' ? `custom: ${sel.pattern}` : sel.pattern) : sel?.type || 'Pipeline',
      run_number: p.build_number,
      display_title: p.target?.ref_name || p.target?.commit?.hash?.slice(0, 7) || '',
      event: (p.trigger?.name || 'push').toLowerCase(),
      status,
      conclusion,
      html_url: `${this.base(ctx)}/pipelines/results/${p.build_number}`,
      run_started_at: p.created_on,
      created_at: p.created_on,
      completed_at: p.completed_on,
      sha: p.target?.commit?.hash,
    };
  },
  async runs(ctx, target, limit) {
    const perPage = Math.min(limit, 100);
    const fields = 'fields=values.uuid,values.build_number,values.state,values.created_on,values.completed_on,values.target,values.trigger,size';
    // Pipelines filter by branch; a commit (pull request head) is matched here.
    const branch = target.ref || target.branch;
    const query = branch ? `&target.branch=${encodeURIComponent(branch)}` : '';
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(limit / perPage) }, (_, i) => HT.api.request(`${this._path(ctx)}/pipelines/?sort=-created_on&pagelen=${perPage}&page=${i + 1}${query}&${fields}`))
    );
    let runs = pages.flatMap((r) => r.data?.values || []).map((p) => this._run(ctx, p));
    if (target.sha) runs = runs.filter((r) => !r.sha || r.sha.startsWith(target.sha) || target.sha.startsWith(r.sha));
    const total = target.sha ? null : pages[0]?.data?.size ?? null;
    return { runs, total, more: total != null ? runs.length < total : (pages.at(-1)?.data?.values?.length || 0) === perPage };
  },

  _step(ctx, run, s) {
    const [status, conclusion] = bbStatus(s.state?.name, s.state?.result?.name);
    return {
      id: s.uuid,
      runId: run?.id,
      name: s.name || 'Step',
      status,
      conclusion,
      html_url: run ? `${this.base(ctx)}/pipelines/results/${run.run_number}/steps/${encodeURIComponent(s.uuid)}` : null,
      started_at: s.started_on,
      completed_at: s.completed_on,
      duration: s.duration_in_seconds != null && status === 'completed' ? s.duration_in_seconds * 1000 : undefined,
    };
  },
  async jobs(ctx, runId, run) {
    const { items } = await this._all(`${this._path(ctx)}/pipelines/${encodeURIComponent(runId)}/steps/?pagelen=50&fields=values.uuid,values.name,values.state,values.started_on,values.completed_on,values.duration_in_seconds,next`, 4, true);
    return items.map((s) => this._step(ctx, run || { id: runId, run_number: this._numbers?.get(runId) }, s));
  },
  async job(ctx, jobId, runId) {
    const { data } = await HT.api.request(`${this._path(ctx)}/pipelines/${encodeURIComponent(runId)}/steps/${encodeURIComponent(jobId)}`);
    const number = data?.pipeline?.build_number;
    return this._step(ctx, { id: runId, run_number: number }, data);
  },
  log(ctx, job) {
    return HT.api.text(`${this._path(ctx)}/pipelines/${encodeURIComponent(job.runId)}/steps/${encodeURIComponent(job.id)}/log`);
  },

  // A step's log echoes each script command as "+ <command>"; those are the
  // steps shown, with the setup output before the first one.
  steps(job, text) {
    if (text == null) return { steps: [], byStep: null };
    const steps = [];
    const byStep = new Map();
    let current = null;
    const start = (name) => {
      current = { number: steps.length + 1, name, status: 'completed', conclusion: 'success', started_at: null, completed_at: null };
      steps.push(current);
      byStep.set(current.number, []);
    };
    for (const line of text.replace(/^﻿/, '').replace(/\r?\n$/, '').split(/\r?\n/)) {
      const cmd = line.match(/^\+ (.+)$/);
      if (cmd) {
        start(cmd[1].length > 80 ? `${cmd[1].slice(0, 77)}…` : cmd[1]);
        byStep.get(current.number).push(line);
        continue;
      }
      if (!current) start(steps.length ? 'Output' : 'Setup');
      byStep.get(current.number).push(line);
    }
    if (job.status !== 'completed' && current) {
      current.status = 'in_progress';
      current.conclusion = null;
    } else if (['failure', 'timed_out'].includes(job.conclusion) && steps.length) {
      steps[steps.length - 1].conclusion = 'failure';
    }
    return { steps, byStep };
  },

  // Latest deployment per environment.
  async deployments(ctx, target) {
    const { data } = await HT.api.request(`${this._path(ctx)}/deployments/?pagelen=30&fields=values.environment.name,values.environment.uuid,values.state,values.release.commit.hash,values.last_update_time`);
    const latest = new Map();
    for (const d of data?.values || []) {
      if (target.sha && d.release?.commit?.hash && !d.release.commit.hash.startsWith(target.sha)) continue;
      const env = d.environment?.name;
      if (env && !latest.has(env)) latest.set(env, d);
    }
    return [...latest.values()].slice(0, 8).map((d) => {
      const [status, conclusion] = bbStatus(d.state?.name, d.state?.status?.name);
      const state = status !== 'completed' ? status : conclusion || 'success';
      return {
        id: d.environment?.uuid,
        environment: d.environment.name,
        ref: d.release?.commit?.hash?.slice(0, 7) || '',
        state,
        busy: status !== 'completed',
        when: d.state?.completed_on || d.state?.started_on || d.last_update_time,
        url: HT.safeUrl(d.state?.url) || this.deploymentsUrl(ctx),
      };
    });
  },

  // Build statuses from other CIs on a commit (Bamboo, Jenkins, …) as jobs;
  // Pipelines' own are left out.
  async externalStatuses(ctx, sha) {
    const { items } = await this._all(`${this._path(ctx)}/commit/${sha}/statuses?pagelen=100&fields=values.key,values.name,values.state,values.url,values.description,values.created_on,values.updated_on,next`, 2, true);
    const own = `${this.base(ctx)}/addon/pipelines`;
    return items
      .filter((st) => !(st.url || '').startsWith(own))
      .map((st) => {
        const [status, conclusion] = bbStatus(st.state, st.state);
        return {
          id: `st:${st.key}`,
          name: st.name || st.key,
          status,
          conclusion,
          html_url: st.url,
          description: st.description,
          started_at: st.created_on,
          completed_at: status === 'completed' ? st.updated_on : null,
          external: true,
          ci: HT.ciSystem(st.name, st.url),
        };
      });
  },

  // A text file from the repository, or throws (404 when it doesn't exist).
  async repoFile(ctx, ref, path) {
    const hash = await this._hash(ctx, ref);
    return HT.api.text(`${this._path(ctx)}/src/${hash}/${HT.encodePath(path)}`);
  },
};

// GitLab (gitlab.com, self-managed CE/EE) adapter. Returns the same shapes
// as github.js. Pages carry the project in <body data-project-id
// data-project-full-path>, which also tells us we're on a project at all.
HT.providers = HT.providers || {};

// GitLab statuses in GitHub's terms: [status, conclusion].
function gitlabStatus(status, allowFailure) {
  switch (status) {
    case 'running': case 'canceling': return ['in_progress', null];
    case 'success': return ['completed', 'success'];
    case 'failed': return ['completed', allowFailure ? 'allowed_failure' : 'failure'];
    case 'canceled': return ['completed', 'cancelled'];
    case 'skipped': return ['completed', 'skipped'];
    case 'manual': return ['completed', 'manual'];
    default: return ['queued', null]; // created, pending, preparing, scheduled, waiting_for_resource…
  }
}

function gitlabJob(j) {
  const [status, conclusion] = gitlabStatus(j.status, j.allow_failure);
  return {
    id: j.id,
    name: j.name,
    stage: j.stage,
    status,
    conclusion,
    html_url: j.web_url,
    started_at: j.started_at,
    completed_at: j.finished_at,
  };
}

// A commit status from another CI (TeamCity, Jenkins, …), as a job.
function gitlabStatusJob(st) {
  const [status, conclusion] = gitlabStatus(st.status, st.allow_failure);
  return {
    id: `st:${st.id}`,
    name: st.name,
    status,
    conclusion,
    html_url: st.target_url,
    description: st.description,
    started_at: st.started_at,
    completed_at: st.finished_at,
    external: true,
    ci: HT.ciSystem(st.name, st.target_url),
  };
}

const humanize = (name) => name.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

HT.providers.gitlab = {
  id: 'gitlab',
  name: 'GitLab',
  terms: {
    pull: 'merge request',
    pullRef: (n) => `!${n}`,
    runs: 'Pipelines',
    run: 'pipeline',
    allRuns: 'All pipelines',
    noRuns: 'pipelines',
  },
  // The trace endpoint serves a running job's output so far.
  liveLogs: true,

  parse(loc) {
    const data = document.body?.dataset || {};
    if (!data.projectId && !data.projectFullPath) return null;
    const path = loc.pathname.replace(/\/+$/, '');
    const fullPath = data.projectFullPath || path.split('/-/')[0].slice(1);
    const parts = fullPath.split('/');
    const ctx = {
      host: loc.host,
      origin: loc.origin || `https://${loc.host}`,
      owner: parts.slice(0, -1).join('/'),
      repo: parts[parts.length - 1],
      fullPath,
      projectId: data.projectId || null,
      kind: 'repo',
      segments: [],
    };
    const prefix = `/${fullPath}/-/`;
    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return ctx;
    const [section, ...rest] = path.slice(prefix.length).split('/').map(HT.decodeSegment);
    if (section === 'merge_requests' && /^\d+$/.test(rest[0] || '')) return { ...ctx, kind: 'pull', pullNumber: Number(rest[0]) };
    if (section === 'tree' || section === 'blob') return { ...ctx, kind: section, segments: rest };
    return ctx;
  },

  // ---- links ----
  base(ctx) {
    return `${ctx.origin}/${HT.encodePath(ctx.fullPath)}`;
  },
  codeUrl(ctx, ref, path, dir) {
    return `${this.base(ctx)}/-/${dir ? 'tree' : 'blob'}/${HT.encodePath(ref)}/${HT.encodePath(path)}`;
  },
  pullUrl(ctx, n) {
    return `${this.base(ctx)}/-/merge_requests/${n}`;
  },
  diffUrl(ctx, n, anchor) {
    return `${this.base(ctx)}/-/merge_requests/${n}/diffs#${anchor}`;
  },
  onDiffPage(n) {
    return new RegExp(`/-/merge_requests/${n}/diffs`).test(location.pathname);
  },
  ciUrl(ctx) {
    return `${this.base(ctx)}/-/pipelines`;
  },
  deploymentsUrl(ctx) {
    return `${this.base(ctx)}/-/environments`;
  },
  tokenUrl(origin) {
    return `${origin}/-/user_settings/personal_access_tokens?name=Hector&scopes=read_api`;
  },
  tokenHint: 'glpat-…',

  // ---- data ----
  _path(ctx) {
    return `/projects/${ctx.projectId || encodeURIComponent(ctx.fullPath)}`;
  },

  // Follow rel="next" links (keyset or offset) up to `max` pages. `fresh`
  // skips the page-lifetime memo, for data that changes (CI).
  async _all(path, max = 30, fresh = false) {
    const out = [];
    let next = path;
    for (let page = 0; next && page < max; page++) {
      const { data, link } = await (fresh ? HT.api.request(next) : HT.api.get(next));
      out.push(...(Array.isArray(data) ? data : []));
      const m = /<([^>]+)>;\s*rel="next"/.exec(link || '');
      next = m ? m[1].replace(/^https?:\/\/[^/]+(\/.*?)?\/api\/v4/, '') : null;
    }
    return { items: out, more: Boolean(next) };
  },

  async repo(ctx) {
    const { data } = await HT.api.get(this._path(ctx));
    if (!data.default_branch) throw Object.assign(new Error('This repository has no commits yet.'), { status: 409 });
    return { defaultBranch: data.default_branch };
  },

  resolveRef(ctx, segments, known) {
    return HT.api.resolveRef(segments, known, async (prefix) => {
      const search = encodeURIComponent(`^${prefix}`);
      const lists = await Promise.all(
        ['branches', 'tags'].map((kind) => this._all(`${this._path(ctx)}/repository/${kind}?search=${search}&per_page=100`, 3).catch(() => ({ items: [] })))
      );
      return lists.flatMap((l) => l.items.map((r) => r.name));
    });
  },

  // The tree API pages 100 entries at a time. Big repositories would take
  // hundreds of requests, so past 5,000 entries load folders on demand.
  async tree(ctx, ref, onTop) {
    const r = encodeURIComponent(ref);
    const map = (e) => ({ path: e.path, type: e.type, sha: e.id });
    const topPath = `${this._path(ctx)}/repository/tree?per_page=100&pagination=keyset&ref=${r}`;
    const full = this._all(`${this._path(ctx)}/repository/tree?recursive=true&per_page=100&pagination=keyset&ref=${r}`, 50);
    if (onTop) {
      // The full listing is a page at a time; if it is slow, show the top level.
      const done = await Promise.race([full.then(() => true, () => true), new Promise((res) => setTimeout(() => res(false), 400))]);
      if (!done) this._all(topPath, 20).then((top) => onTop({ entries: top.items.map(map), complete: false }), () => {});
    }
    const all = await full;
    if (!all.more) return { entries: all.items.map(map), complete: true };
    const top = await this._all(topPath, 20);
    return { entries: top.items.map(map), complete: false };
  },

  async children(ctx, ref, node) {
    const path = `${this._path(ctx)}/repository/tree?path=${encodeURIComponent(node.path)}&per_page=100&pagination=keyset&ref=${encodeURIComponent(ref)}`;
    const { items } = await this._all(path, 20);
    return items.map((e) => ({ name: e.name, type: e.type, sha: e.id }));
  },

  async pull(ctx, n) {
    const { data } = await HT.api.get(`${this._path(ctx)}/merge_requests/${n}`);
    return {
      title: data.title,
      headSha: data.diff_refs?.head_sha || data.sha,
      headRef: data.source_branch,
      changedFiles: parseInt(data.changes_count, 10) || null,
    };
  },

  // /diffs is GitLab 15.7+; older servers only have /changes.
  async pullFiles(ctx, n) {
    let diffs;
    try {
      diffs = (await this._all(`${this._path(ctx)}/merge_requests/${n}/diffs?per_page=100`, 30)).items;
    } catch (err) {
      if (err.status !== 404) throw err;
      diffs = (await HT.api.get(`${this._path(ctx)}/merge_requests/${n}/changes`)).data.changes || [];
    }
    return Promise.all(
      diffs.map(async (d) => {
        let additions = 0;
        let deletions = 0;
        for (const line of (d.diff || '').split('\n')) {
          if (line[0] === '+' && !line.startsWith('+++')) additions++;
          else if (line[0] === '-' && !line.startsWith('---')) deletions++;
        }
        return {
          path: d.new_path,
          status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
          additions,
          deletions,
          previous: d.renamed_file ? d.old_path : undefined,
          // GitLab's diff anchors are the SHA-1 of the file path.
          anchor: await HT.sha1Hex(d.new_path),
        };
      })
    );
  },

  async recentShas(ctx, ref) {
    const { data } = await HT.api.get(`${this._path(ctx)}/repository/commits?ref_name=${encodeURIComponent(ref)}&per_page=5`);
    return (data || []).map((c) => c.id);
  },

  // ---- commits and branches ----
  commitUrl(ctx, sha) {
    return `${this.base(ctx)}/-/commit/${sha}`;
  },
  branchUrl(ctx, name) {
    return this.codeUrl(ctx, name, '', true);
  },
  compareUrl(ctx, base, head) {
    return `${this.base(ctx)}/-/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  },
  async commits(ctx, ref, page, perPage = 30) {
    const { data } = await HT.api.request(`${this._path(ctx)}/repository/commits?ref_name=${encodeURIComponent(ref)}&per_page=${perPage}&page=${page}`);
    const items = (data || []).map((c) => ({ sha: c.id, parents: c.parent_ids || [], title: c.title, author: c.author_name, date: c.committed_date || c.created_at, url: c.web_url }));
    return { items, more: items.length === perPage };
  },
  async branches(ctx) {
    const { items, more } = await this._all(`${this._path(ctx)}/repository/branches?per_page=100`, 10, true);
    return {
      items: items.map((b) => ({ name: b.name, sha: b.commit?.id, title: b.commit?.title, date: b.commit?.committed_date, protected: b.protected, merged: b.merged })),
      more,
    };
  },

  async user() {
    const { data } = await HT.api.request('/user');
    return { login: data.username, avatar: data.avatar_url };
  },

  // ---- CI/CD (pipelines) ----
  async runs(ctx, target, limit) {
    const perPage = Math.min(limit, 100);
    const query = target.sha ? `sha=${target.sha}` : `ref=${encodeURIComponent(target.ref)}`;
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(limit / perPage) }, (_, i) =>
        HT.api.request(`${this._path(ctx)}/pipelines?per_page=${perPage}&page=${i + 1}&${query}`)
      )
    );
    const runs = pages.flatMap((r) => r.data || []).map((p) => {
      const [status, conclusion] = gitlabStatus(p.status);
      return {
        id: p.id,
        name: p.name || 'Pipeline',
        run_number: p.id,
        display_title: p.ref,
        event: p.source || 'pipeline',
        status,
        conclusion,
        html_url: p.web_url,
        run_started_at: p.created_at,
        created_at: p.created_at,
        sha: p.sha,
        // Statuses posted by another CI (TeamCity, Jenkins, …) live in an
        // "external" pipeline; name it after that CI.
        external: p.source === 'external',
      };
    });
    await Promise.all(
      runs
        .filter((r) => r.external)
        .map(async (r) => {
          const jobs = await this.jobs(ctx, r.id, r).catch(() => []);
          const systems = [...new Set(jobs.map((j) => j.ci))];
          if (systems.length) r.name = systems.join(' · ');
        })
    );
    // GitLab leaves out the total for very long lists.
    const total = pages[0].total != null ? Number(pages[0].total) : null;
    return { runs, total, more: total != null ? runs.length < total : pages.at(-1).data?.length === perPage };
  },

  // Latest deployment per environment.
  async deployments(ctx, target) {
    const { data } = await HT.api.request(`${this._path(ctx)}/deployments?order_by=created_at&sort=desc&per_page=50`);
    const latest = new Map();
    for (const d of data || []) {
      if (target.sha && d.sha !== target.sha) continue;
      const env = d.environment?.name;
      if (env && !latest.has(env)) latest.set(env, d);
    }
    const states = { success: 'success', failed: 'failure', canceled: 'inactive', running: 'in_progress', created: 'queued', blocked: 'queued' };
    return [...latest.values()].slice(0, 8).map((d) => {
      const state = states[d.status] || d.status;
      return {
        id: d.id,
        environment: d.environment.name,
        ref: d.ref,
        state,
        busy: state === 'in_progress' || state === 'queued',
        when: d.updated_at || d.created_at,
        url: HT.safeUrl(d.environment.external_url) || `${this.deploymentsUrl(ctx)}/${d.environment.id}`,
      };
    });
  },

  async jobs(ctx, pipelineId, run) {
    if (run?.external) return this.statuses(ctx, run.sha, pipelineId);
    const { items } = await this._all(`${this._path(ctx)}/pipelines/${pipelineId}/jobs?per_page=100`, 5, true);
    return items.map(gitlabJob).sort((a, b) => a.id - b.id);
  },

  // Latest status per name on a commit, from other CIs (optionally one
  // external pipeline's). GitLab's own jobs are left out.
  async statuses(ctx, sha, pipelineId) {
    const filter = pipelineId ? `&pipeline_id=${pipelineId}` : '';
    const { items } = await this._all(`${this._path(ctx)}/repository/commits/${sha}/statuses?per_page=100${filter}`, 3, true);
    const own = `${ctx.origin}/`;
    return items.filter((st) => !(st.target_url || '').startsWith(own) || !/\/-\/jobs\//.test(st.target_url)).map(gitlabStatusJob);
  },

  externalStatuses(ctx, sha) {
    return this.statuses(ctx, sha);
  },

  // GitLab's own JetBrains TeamCity integration: { url, buildType }, if set
  // up and readable (needs Maintainer).
  async teamcityIntegration(ctx) {
    for (const kind of ['integrations', 'services']) {
      try {
        const { data } = await HT.api.get(`${this._path(ctx)}/${kind}/teamcity`);
        const props = data?.properties || {};
        return data?.active && props.teamcity_url ? { url: props.teamcity_url, buildType: props.build_type || '' } : null;
      } catch (err) {
        if (err.status !== 404) return null;
      }
    }
    return null;
  },

  // A text file from the repository, or throws (404 when it doesn't exist).
  async repoFile(ctx, ref, path) {
    return HT.api.text(`${this._path(ctx)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`);
  },

  // Signed-out visitors can't read a single job, but can list the pipeline's.
  async job(ctx, jobId, pipelineId) {
    try {
      return gitlabJob((await HT.api.request(`${this._path(ctx)}/jobs/${jobId}`)).data);
    } catch (err) {
      if (![401, 403].includes(err.status) || !pipelineId) throw err;
      const job = (await this.jobs(ctx, pipelineId)).find((j) => j.id === jobId);
      if (!job) throw err;
      return job;
    }
  },

  // The API wants a token for logs; signed-out visitors of public projects
  // can still read the web page's raw log.
  async log(ctx, job) {
    try {
      return await HT.api.text(`${this._path(ctx)}/jobs/${job.id}/trace`);
    } catch (err) {
      const url = HT.safeUrl(job.html_url);
      if (err.hasToken || ![401, 403].includes(err.status) || !url || new URL(url).host !== location.host) throw err;
      return HT.api.text(`${new URL(url).pathname}/raw`, { web: true });
    }
  },

  // Steps come from the log: each top-level section_start…section_end is a
  // step (named by its header line), nested sections become folds, and
  // output outside any section joins the step before it.
  steps(job, text) {
    if (text == null) return { steps: [], byStep: null };
    const steps = [];
    const byStep = new Map();
    const iso = (ts) => new Date(Number(ts) * 1000).toISOString();
    let current = null;
    let depth = 0;
    // A section's header text follows its section_start marker.
    let pending = null; // { kind: 'step' | 'group', name }
    const startStep = (key, at) => {
      current = { number: steps.length + 1, key, name: humanize(key), status: 'completed', conclusion: 'success', started_at: at, completed_at: null };
      steps.push(current);
      byStep.set(current.number, []);
    };
    const emit = (line) => {
      if (!current) startStep('set_up_job', null);
      byStep.get(current.number).push(line);
    };
    const settle = (shown = '') => {
      const title = HT.stripAnsi(shown).trim();
      if (pending.kind === 'step') {
        if (title) current.name = title;
      } else {
        emit(`##[group]${title ? shown : humanize(pending.name)}`);
      }
      pending = null;
    };
    const output = (chunk) => {
      // "\r" redraws the line (progress bars): keep what was drawn last.
      const parts = chunk.replace(/\r$/, '').split('\r');
      const shown = parts.filter((p) => HT.stripAnsi(p).trim()).pop() ?? parts.pop();
      if (pending) settle(shown);
      else emit(shown);
    };

    // Runners with timestamps prefix each line ("<time> 00O "); "00O+"
    // continues the previous line.
    const lines = [];
    for (const raw of text.replace(/^﻿/, '').replace(/\r?\n$/, '').split('\n')) {
      const m = raw.match(/^\d{4}-\d\d-\d\dT[\d:.]+Z [0-9a-f]{2}[OE](?:(\+)|\s)([\s\S]*)$/);
      if (m?.[1] && lines.length) lines[lines.length - 1] += m[2];
      else lines.push(m ? m[2] : raw);
    }

    const marker = /(?:\x1b\[0K)?section_(start|end):(\d+):([\w.-]+)(?:\[[^\]]*\])?\r?(?:\x1b\[0K)?/g;
    for (const line of lines) {
      let last = 0;
      let marked = false;
      for (const m of line.matchAll(marker)) {
        marked = true;
        const before = line.slice(last, m.index);
        if (HT.stripAnsi(before).trim()) output(before);
        last = m.index + m[0].length;
        if (pending) settle();
        const [, kind, ts, name] = m;
        if (kind === 'start') {
          if (depth === 0) startStep(name, iso(ts));
          pending = { kind: depth === 0 ? 'step' : 'group', name };
          depth++;
        } else if (depth > 0) {
          depth--;
          if (depth === 0) current.completed_at = iso(ts);
          else emit('##[endgroup]');
        }
      }
      const rest = line.slice(last);
      if (!marked || HT.stripAnsi(rest).trim()) output(rest);
      if (pending) settle();
    }

    if (job.status !== 'completed' && current && !current.completed_at) {
      current.status = 'in_progress';
      current.conclusion = null;
    }
    if (job.conclusion === 'failure' || job.conclusion === 'allowed_failure') {
      const script = steps.filter((s) => /^(step|build|after)_script$|^step_/.test(s.key));
      const failed =
        script.at(-1) || steps.find((s) => byStep.get(s.number).some((l) => /^ERROR: /.test(HT.stripAnsi(l)))) || steps.at(-1);
      if (failed) failed.conclusion = 'failure';
    }
    return { steps, byStep };
  },
};

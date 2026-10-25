// Any CI behind a JSON endpoint. The source's address is a template, e.g.
//   https://ci.example.com/api/builds?repo={owner}/{repo}&sha={sha}
// filled with the commit or branch being viewed, and answers with builds:
//   [{ "id": 42, "name": "unit tests", "number": 42, "status": "success",
//      "url": "https://ci.example.com/builds/42",
//      "started_at": "2026-10-25T08:00:00Z", "finished_at": "…",
//      "log_url": "https://ci.example.com/builds/42/log",   (text, same server)
//      "log": "…",                                          (or inline)
//      "steps": [{ "name": "install", "status": "success", "log": "…" }] }]
// or { "builds": [...] }. Status words from GitHub, GitLab, Jenkins,
// Buildkite and friends are understood (status/conclusion, state, result).
HT.customCI = (() => {
  const known = new Map(); // build id -> { build, origin }

  function normalize(b) {
    const s = String(b.status ?? b.state ?? '').toLowerCase();
    const c = String(b.conclusion ?? b.result ?? '').toLowerCase();
    if (['running', 'in_progress', 'building', 'started', 'in progress'].includes(s)) return ['in_progress', null];
    if (['queued', 'pending', 'created', 'scheduled', 'waiting', 'blocked', 'manual'].includes(s)) return ['queued', null];
    const r = c || s;
    const map = {
      success: 'success', succeeded: 'success', passed: 'success', ok: 'success', green: 'success', completed: 'success',
      failure: 'failure', failed: 'failure', error: 'failure', errored: 'failure', red: 'failure', broken: 'failure',
      cancelled: 'cancelled', canceled: 'cancelled', aborted: 'cancelled', stopped: 'cancelled',
      skipped: 'skipped', not_built: 'skipped', neutral: 'skipped',
      unstable: 'allowed_failure', warning: 'allowed_failure', timed_out: 'timed_out', timeout: 'timed_out',
    };
    return ['completed', map[r] || (r ? 'failure' : 'success')];
  }

  function asJob(source, origin, b, i) {
    const [status, conclusion] = normalize(b);
    const id = String(b.id ?? b.number ?? b.build_id ?? i);
    const job = {
      ci: 'custom',
      id: `${origin}#${id}`,
      name: String(b.name || b.job || b.pipeline || source.name || 'Build'),
      run_number: b.number ?? b.id ?? null,
      status,
      conclusion,
      html_url: HT.safeUrl(b.url || b.html_url || b.web_url || b.link),
      description: typeof b.description === 'string' ? b.description : undefined,
      created_at: b.created_at || b.queued_at || b.started_at || null,
      started_at: b.started_at || b.start || b.created_at || null,
      completed_at: b.finished_at || b.completed_at || b.end || b.ended_at || null,
      branch: typeof b.branch === 'string' ? b.branch : typeof b.ref === 'string' ? b.ref : '',
    };
    known.set(job.id, { build: job, origin, log: typeof b.log === 'string' ? b.log : null, logUrl: HT.safeUrl(b.log_url), steps: Array.isArray(b.steps) ? b.steps : null });
    return job;
  }

  async function fetchBuilds(source, opts, limit) {
    const { target } = opts;
    const sha = target.sha || (await opts.recentShas().catch(() => []))[0] || '';
    const ref = target.ref || target.branch || '';
    const url = new URL(HT.ci.fill(source.server, { sha, ref, branch: ref, owner: opts.repo?.owner || '', repo: opts.repo?.repo || '' }));
    const origin = url.origin.toLowerCase();
    const data = await HT.ci.request('custom', origin, `${url.pathname}${url.search}`);
    const list = Array.isArray(data) ? data : Array.isArray(data?.builds) ? data.builds : Array.isArray(data?.items) ? data.items : Array.isArray(data?.runs) ? data.runs : null;
    if (!list) throw new Error('The endpoint did not answer with a list of builds.');
    const builds = list.filter((b) => b && typeof b === 'object').slice(0, limit).map((b, i) => asJob(source, origin, b, i));
    return { builds, origin, url: HT.safeUrl(data?.url) };
  }

  return {
    id: 'custom',
    name: 'Custom CI',
    liveLogs: true,

    async load(opts) {
      const { source } = opts;
      try {
        const { builds, origin, url } = await fetchBuilds(source, opts, opts.limit);
        return { builds, url: url || origin };
      } catch (err) {
        if (err.needsAccess) return { needsAccess: new URL(source.server).origin, builds: [] };
        throw HT.ci.friendly(err, new URL(source.server).origin);
      }
    },

    async diagnose(opts) {
      const out = [];
      const step = (ok, text) => (out.push({ ok, text }), ok);
      const server = new URL(opts.source.server).origin;
      const host = new URL(server).host;
      const { granted } = await HT.api.send({ type: 'ci:access', server });
      if (!step(granted, granted ? `Hector may reach ${host}.` : `Hector isn't allowed to reach ${host} yet (Allow access).`)) return out;
      let builds;
      try {
        ({ builds } = await fetchBuilds(opts.source, opts, 5));
        step(true, `The endpoint answered with ${builds.length} build${builds.length === 1 ? '' : 's'} for ${opts.target.label}.`);
      } catch (err) {
        step(false, `Couldn't read builds: ${HT.ci.friendly(err, server).message}`);
        return out;
      }
      const latest = builds[0];
      if (!step(Boolean(latest), latest ? `Latest: ${latest.name} (${latest.conclusion || latest.status}).` : 'No builds yet; the shape of the answer looks right.')) return out;
      try {
        const text = await this.log(null, latest);
        step(true, text == null ? 'This build has no log.' : `Read its log (${text.split('\n').length} lines).`);
      } catch (err) {
        step(false, `Couldn't read the log: ${err.message}`);
      }
      return out;
    },

    forget() {
      known.clear();
    },

    // No per-build endpoint: the list's copy is the latest known state (the
    // CI/CD tab reloads the list while anything runs).
    async job(ctx, id) {
      const k = known.get(id);
      if (!k) throw new Error('Build not found.');
      return k.build;
    },

    async log(ctx, job) {
      const k = known.get(job.id);
      if (!k) throw new Error('Build not found.');
      if (k.log != null) return k.log;
      if (k.steps?.some((s) => typeof s?.log === 'string')) return k.steps.map((s) => s?.log || '').join('\n');
      if (!k.logUrl) return null;
      const url = new URL(k.logUrl);
      if (url.origin.toLowerCase() !== k.origin) throw new Error('The log is on another server.');
      return HT.ci.request('custom', k.origin, `${url.pathname}${url.search}`, { text: true });
    },

    steps(job, text) {
      const k = known.get(job.id);
      if (k?.steps?.length) {
        const steps = [];
        const byStep = new Map();
        k.steps.forEach((s, i) => {
          const [status, conclusion] = normalize(s || {});
          steps.push({ number: i + 1, name: String(s?.name || `Step ${i + 1}`), status, conclusion, started_at: s?.started_at || null, completed_at: s?.finished_at || s?.completed_at || null });
          byStep.set(i + 1, typeof s?.log === 'string' ? s.log.replace(/\r?\n$/, '').split(/\r?\n/) : []);
        });
        if (text != null && !k.steps.some((s) => typeof s?.log === 'string')) byStep.set(steps.length, text.replace(/\r?\n$/, '').split(/\r?\n/));
        return { steps, byStep };
      }
      if (text == null) return { steps: [], byStep: null };
      const one = { number: 1, name: 'Log', status: job.status, conclusion: job.conclusion, started_at: job.started_at, completed_at: job.completed_at };
      return { steps: [one], byStep: new Map([[1, text.replace(/\r?\n$/, '').split(/\r?\n/)]]) };
    },
  };
})();

HT.ci.register(HT.customCI);

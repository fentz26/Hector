// Jenkins builds for a repository: freestyle and pipeline jobs, folders and
// multibranch pipelines (the branch job is picked from the branch being
// viewed). Builds come back in the shape github.js uses for jobs, marked
// `ci: 'jenkins'`. Console output is the log; a pipeline's stages become the
// steps, read from the "[Pipeline] { (Stage)" markers in that output.
HT.jenkins = (() => {
  const memo = new Map();
  const where = new Map(); // build id -> { server, base } (the job's API path)
  const BUILD = 'number,result,building,timestamp,duration,url,fullDisplayName,actions[lastBuiltRevision[SHA1],revision[SHA1]]';

  const req = (server, path, opts) => HT.ci.request('jenkins', server, path, opts);
  const get = (server, path) => {
    const key = `${server}${path}`;
    if (!memo.has(key)) memo.set(key, req(server, path).catch((err) => (memo.delete(key), Promise.reject(err))));
    return memo.get(key);
  };

  // "folder/job" -> "/job/folder/job/job"
  const jobPath = (id) =>
    id
      .split('/')
      .filter(Boolean)
      .map((s) => `/job/${encodeURIComponent(s)}`)
      .join('');

  const RESULTS = { SUCCESS: 'success', UNSTABLE: 'allowed_failure', FAILURE: 'failure', ABORTED: 'cancelled', NOT_BUILT: 'skipped' };

  function asJob(server, base, label, b) {
    const status = b.building ? 'in_progress' : b.result ? 'completed' : 'queued';
    const conclusion = status === 'completed' ? RESULTS[b.result] || 'failure' : null;
    const sha = (b.actions || []).flatMap((a) => [a?.lastBuiltRevision?.SHA1, a?.revision?.SHA1]).find(Boolean) || null;
    const started = b.timestamp ? new Date(b.timestamp).toISOString() : null;
    const done = started && !b.building && b.duration ? new Date(b.timestamp + b.duration).toISOString() : null;
    const id = `${label}#${b.number}`;
    where.set(id, { server, base, number: b.number });
    return {
      ci: 'jenkins',
      id,
      name: label,
      run_number: b.number,
      status,
      conclusion,
      sha,
      html_url: b.url,
      created_at: started,
      started_at: started,
      completed_at: done,
      duration: b.building ? null : b.duration || null,
    };
  }

  // Builds of one job (or of the branch job inside a multibranch pipeline).
  async function buildsFor(server, id, target, limit) {
    const base = jobPath(id);
    const data = await req(server, `${base}/api/json?tree=builds[${BUILD}]{0,${limit}},jobs[name]`);
    if (Array.isArray(data.builds)) {
      const jobs = data.builds.map((b) => asJob(server, base, id, b));
      // Plain jobs rarely say which commit they built; keep them all then.
      return target.sha && jobs.some((j) => j.sha) ? jobs.filter((j) => !j.sha || j.sha === target.sha) : jobs;
    }
    if (!Array.isArray(data.jobs)) return [];
    // A multibranch pipeline (or folder): branch jobs are named after the
    // branch, with "/" as "%2F".
    const names = data.jobs.map((j) => j.name);
    const branch = target.ref || target.branch;
    const pick = branch && names.find((n) => n === branch || HT.decodeSegment(n) === branch);
    if (pick) {
      const sub = `${base}/job/${encodeURIComponent(pick)}`;
      const d = await req(server, `${sub}/api/json?tree=builds[${BUILD}]{0,${limit}}`);
      const jobs = (d.builds || []).map((b) => asJob(server, sub, `${id}/${HT.decodeSegment(pick)}`, b));
      return target.sha && jobs.some((j) => j.sha) ? jobs.filter((j) => !j.sha || j.sha === target.sha) : jobs;
    }
    if (!target.sha) return [];
    // No branch to go by: look for the commit in the most recent branch jobs.
    const lists = await Promise.all(
      names.slice(0, 10).map(async (n) => {
        const sub = `${base}/job/${encodeURIComponent(n)}`;
        const d = await req(server, `${sub}/api/json?tree=builds[${BUILD}]{0,10}`).catch(() => ({}));
        return (d.builds || []).map((b) => asJob(server, sub, `${id}/${HT.decodeSegment(n)}`, b));
      })
    );
    return lists.flat().filter((j) => j.sha === target.sha);
  }

  // Jobs linked from commit statuses on this server.
  async function detect(server, opts) {
    const shas = (await opts.recentShas()).slice(0, 3);
    const ids = new Set();
    for (const sha of shas) {
      for (const st of await opts.statuses(sha).catch(() => [])) {
        const link = linkFor(st.html_url);
        // Job names from status links get the same check as typed ones.
        if (link?.server === server && HT.ci.cleanIds('jenkins', link.job)) ids.add(link.job);
      }
      if (ids.size) break;
    }
    return [...ids].slice(0, 8);
  }

  // "https://jenkins/job/a/job/b/123/display/redirect" -> { server, job: 'a/b', buildId: '123' }
  function linkFor(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const m = u.pathname.match(/^((?:\/job\/[^/]+)+)\/(\d+)(?:\/|$)/);
    if (!m) return null;
    const job = m[1]
      .split('/job/')
      .filter(Boolean)
      .map((s) => HT.decodeSegment(s))
      .join('/');
    return { server: u.origin.toLowerCase(), job, buildId: m[2] };
  }

  const ids = (source) => HT.ci.cleanIds('jenkins', source.ids).split(',').filter(Boolean);

  const sortNewest = (all) => all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.run_number - a.run_number);

  return {
    id: 'jenkins',
    tokenUrl: (server) => `${server}/me/configure`,
    name: 'Jenkins',
    liveLogs: true, // consoleText serves a running build's output so far
    linkFor,

    async load(opts) {
      const { server } = opts.source;
      try {
        const jobs = ids(opts.source).length ? ids(opts.source) : await detect(server, opts);
        if (!jobs.length) {
          return { builds: [], url: server, note: `No Jenkins jobs are linked from the latest commits of ${opts.target.label}. Set the job names in Settings.` };
        }
        const lists = await Promise.all(jobs.map((id) => buildsFor(server, id, opts.target, opts.limit)));
        const all = sortNewest(lists.flat());
        return { builds: all.slice(0, opts.limit), url: `${server}${jobPath(jobs[0])}` };
      } catch (err) {
        if (err.needsAccess) return { needsAccess: server, builds: [] };
        throw HT.ci.friendly(err, server);
      }
    },

    async diagnose(opts) {
      const out = [];
      const step = (ok, text) => (out.push({ ok, text }), ok);
      const { server } = opts.source;
      const host = new URL(server).host;
      const { granted } = await HT.api.send({ type: 'ci:access', server });
      if (!step(granted, granted ? `Hector may reach ${host}.` : `Hector isn't allowed to reach ${host} yet (Allow access).`)) return out;
      try {
        const info = await req(server, '/api/json?tree=mode,nodeDescription');
        step(true, `Reached Jenkins (${info.nodeDescription || info.mode || 'ok'}).`);
      } catch (err) {
        step(false, `Couldn't reach Jenkins at ${host}: ${HT.ci.friendly(err, server).message}`);
        return out;
      }
      const me = await req(server, '/me/api/json?tree=id,fullName').catch(() => null);
      step(true, me?.id ? `Signed in as ${me.fullName || me.id}.` : 'Anonymous access (sign in or add user:apitoken to see private jobs).');
      let jobs;
      try {
        jobs = ids(opts.source).length ? ids(opts.source) : await detect(server, opts);
        if (!step(jobs.length > 0, jobs.length ? `Jobs: ${jobs.join(', ')}.` : `No Jenkins jobs are linked from the latest commits of ${opts.target.label}. Set the job names.`)) return out;
      } catch (err) {
        step(false, HT.ci.friendly(err, server).message);
        return out;
      }
      let latest;
      try {
        const lists = await Promise.all(jobs.map((id) => buildsFor(server, id, opts.target, 5)));
        const all = sortNewest(lists.flat());
        latest = all[0];
        if (!step(Boolean(latest), latest ? `${all.length >= 5 ? '5+' : all.length} build${all.length === 1 ? '' : 's'} for ${opts.target.label}; latest #${latest.run_number} (${latest.conclusion || latest.status}).` : `No builds for ${opts.target.label} in those jobs.`)) return out;
      } catch (err) {
        step(false, HT.ci.friendly(err, server).message);
        return out;
      }
      try {
        const text = await this.log(null, latest);
        step(true, `Read the console of #${latest.run_number}: ${this.steps(latest, text).steps.length} stage(s).`);
      } catch (err) {
        step(false, `Couldn't read the console output: ${HT.ci.friendly(err, server).message}`);
      }
      return out;
    },

    // A build from a status link.
    async build(server, link) {
      const base = jobPath(link.job);
      const b = await req(server, `${base}/${link.buildId}/api/json?tree=${BUILD}`);
      return asJob(server, base, link.job, b);
    },

    forget() {
      memo.clear();
    },

    async job(ctx, id) {
      const at = where.get(id);
      if (!at) throw new Error('Build not found.');
      const b = await req(at.server, `${at.base}/${at.number}/api/json?tree=${BUILD}`);
      return asJob(at.server, at.base, id.replace(/#\d+$/, ''), b);
    },

    log(ctx, job) {
      const at = where.get(job.id);
      if (!at) return Promise.reject(new Error('Build not found.'));
      return req(at.server, `${at.base}/${at.number}/consoleText`, { text: true });
    },

    // Pipeline stages from "[Pipeline] { (Name)" … "[Pipeline] }" markers;
    // nested blocks fold. A freestyle build is one step.
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
      // Open "[Pipeline] {" blocks: the stage's own, then nested ones (folds).
      // Output between or after stages joins the step before it.
      const stack = [];
      for (const line of text.replace(/^﻿/, '').replace(/\r?\n$/, '').split(/\r?\n/)) {
        const open = line.match(/^\[Pipeline\] \{ \((.+)\)$/);
        if (open) {
          start(open[1]);
          stack.length = 0;
          stack.push('stage');
          continue;
        }
        if (!current) start('Console output');
        if (/^\[Pipeline\] \{$/.test(line) && stack.length) {
          stack.push('block');
          byStep.get(current.number).push(`##[group]${line}`);
          continue;
        }
        if (/^\[Pipeline\] \}$/.test(line) && stack.length) {
          byStep.get(current.number).push(stack.pop() === 'block' ? '##[endgroup]' : line);
          continue;
        }
        byStep.get(current.number).push(line);
      }
      if (job.status !== 'completed' && current) {
        current.status = 'in_progress';
        current.conclusion = null;
      }
      if (['failure', 'allowed_failure', 'timed_out'].includes(job.conclusion) && steps.length) {
        const failed =
          steps.find((s) => (byStep.get(s.number) || []).some((l) => /^ERROR: |^FATAL: |Finished: (FAILURE|UNSTABLE)/.test(HT.stripAnsi(l)))) || steps[steps.length - 1];
        failed.conclusion = job.conclusion === 'allowed_failure' ? 'allowed_failure' : 'failure';
      }
      return { steps, byStep };
    },
  };
})();

HT.ci.register(HT.jenkins);

// TeamCity builds for the repository being viewed, shown as their own
// section in the CI/CD tab. Requests go through the background worker to
// servers the user added (with a token, their TeamCity session, or guest
// access). Builds and their logs come back in the same shapes the GitHub and
// GitLab adapters use for runs and jobs, marked `tc: true`.
//
// Which build configurations belong to a repository: by default, the ones
// that built its recent commits (TeamCity can look builds up by revision with
// ordinary view permissions); a TeamCity project ID set per repository
// overrides that.
HT.teamcity = (() => {
  const FIELDS =
    'count,build(id,number,status,state,statusText,branchName,defaultBranch,webUrl,buildTypeId,' +
    'buildType(id,name,projectName,projectId,webUrl),queuedDate,startDate,finishDate,percentageComplete)';
  const memo = new Map();

  // "20261025T084831+0000" -> ISO 8601.
  const date = (s) => (s ? s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)([+-]\d\d)(\d\d)$/, '$1-$2-$3T$4:$5:$6$7:$8') : null);

  async function request(server, path, { text = false } = {}) {
    let res = await HT.api.send({ type: 'tc', server, path, text });
    // Not signed in and no token: try TeamCity's guest access.
    if (res?.status === 401 && !res.hasToken && !path.startsWith('/guestAuth/')) {
      res = await HT.api.send({ type: 'tc', server, path: `/guestAuth${path}`, text });
    }
    if (!res?.ok) throw new HT.ApiError(res || { status: 0 });
    return res.data;
  }

  const get = (server, path) => {
    const key = `${server}${path}`;
    if (!memo.has(key)) memo.set(key, request(server, path).catch((err) => (memo.delete(key), Promise.reject(err))));
    return memo.get(key);
  };

  const builds = async (server, locator) => (await request(server, `/app/rest/builds?locator=${encodeURIComponent(locator)}&fields=${FIELDS}`)).build || [];

  function asJob(b) {
    const status = b.state === 'running' ? 'in_progress' : b.state === 'finished' ? 'completed' : 'queued';
    const conclusion =
      status !== 'completed' ? null : b.status === 'SUCCESS' ? 'success' : b.status === 'UNKNOWN' ? 'cancelled' : 'failure';
    const project = (b.buildType?.projectName || '').split(' / ').pop();
    return {
      tc: true,
      id: b.id,
      name: project ? `${project} :: ${b.buildType?.name || b.buildTypeId}` : b.buildType?.name || b.buildTypeId,
      run_number: b.number,
      status,
      conclusion,
      statusText: b.statusText,
      branch: b.branchName ? b.branchName.replace(/^refs\/heads\//, '') : '',
      projectId: b.buildType?.projectId,
      html_url: b.webUrl,
      created_at: date(b.queuedDate),
      started_at: date(b.startDate),
      completed_at: date(b.finishDate),
    };
  }

  // Build configurations that built any of these commits (newest first).
  // Sign-in problems surface; other failures just mean "not found".
  async function detect(server, shas) {
    for (const sha of shas) {
      const found = await builds(server, `revision:(version:${sha}),defaultFilter:false,count:20`).catch((err) => {
        if ([401, 403].includes(err.status)) throw err;
        return [];
      });
      if (found.length) return [...new Set(found.map((b) => b.buildTypeId))];
    }
    return [];
  }

  // An ID set by the user or GitLab: a build configuration, else a project.
  async function scopeFor(server, id) {
    const enc = encodeURIComponent(id);
    const isType = await get(server, `/app/rest/buildTypes/id:${enc}?fields=id`).then(
      () => true,
      (err) => {
        if ([401, 403].includes(err.status)) throw err;
        return false;
      }
    );
    return isType ? `buildType:(id:${id})` : `affectedProject:(id:${id})`;
  }

  function friendly(err, server) {
    if ([401, 403].includes(err.status)) {
      const host = new URL(server).host;
      return Object.assign(
        new Error(`${host} needs you signed in: log in to TeamCity in this browser, or add an access token for ${host} in Hector's options.`),
        { status: err.status }
      );
    }
    return err;
  }

  // Builds of one configuration (or a whole project) for the target.
  async function forScope(server, scope, target, limit) {
    const base = `${scope},defaultFilter:false,state:any,count:${limit}`;
    if (target.sha) return builds(server, `${base},revision:(version:${target.sha})`);
    const tries = target.isDefault ? ['branch:(default:true)'] : [];
    tries.push(`branch:(name:${target.ref})`, `branch:(name:refs/heads/${target.ref})`);
    for (const branch of tries) {
      const found = await builds(server, `${base},${branch}`).catch(() => []);
      if (found.length) return found;
    }
    return [];
  }

  return {
    id: 'teamcity',
    name: 'TeamCity',
    liveLogs: true,

    // { builds, server, url, note? } or { needsServer } for the section, or
    // null when TeamCity isn't set up for this repository. Which builds:
    //   1. the build configuration / project set in Hector for this repo,
    //   2. GitLab's TeamCity integration (its server and build configuration),
    //   3. TeamCity builds linked from the commits' statuses,
    //   4. TeamCity builds of the latest commits (by revision).
    // opts: { repoKey, target, limit, recentShas(), integration(), statuses(sha) }
    async load(opts) {
      const { teamcityServers = [], teamcityRepos = {} } = await chrome.storage.sync.get(['teamcityServers', 'teamcityRepos']);
      const repo = teamcityRepos[opts.repoKey] || {};
      if (repo.off) return null;
      const integ = repo.project ? null : await opts.integration().catch(() => null);
      let servers = repo.server ? [repo.server] : teamcityServers;
      let fixed = repo.project || '';
      if (integ) {
        let origin = null;
        try {
          origin = new URL(integ.url).origin.toLowerCase();
        } catch {
          // A malformed URL in GitLab's settings; fall through to detection.
        }
        if (origin && !teamcityServers.includes(origin)) return { needsServer: origin, builds: [] };
        if (origin) {
          servers = [origin];
          fixed = integ.buildType;
        }
      }
      if (!servers.length) return null;

      let lastError = null;
      for (const server of servers) {
        try {
          const scopes = fixed ? [await scopeFor(server, fixed)] : await this._detect(server, opts);
          if (!scopes.length) continue;
          const lists = await Promise.all(scopes.map((scope) => forScope(server, scope, opts.target, opts.limit)));
          const all = lists.flat().map(asJob);
          all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id - a.id);
          this.remember(server, all);
          const projectId = all[0]?.projectId;
          return { builds: all.slice(0, opts.limit), server, url: projectId ? `${server}/project/${encodeURIComponent(projectId)}` : server };
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError) throw friendly(lastError, servers[0]);
      return {
        builds: [],
        server: servers[0],
        note: `No TeamCity builds found for the latest commits of ${opts.target.label}. Set the build configuration or project in Settings.`,
      };
    },

    // Build configurations for this repository on a server (memoized).
    _detect(server, opts) {
      const key = `detect:${server}:${opts.repoKey}`;
      if (!memo.has(key)) {
        const run = (async () => {
          const shas = (await opts.recentShas()).slice(0, 5);
          // Status links name the builds directly.
          const types = new Set();
          const buildIds = [];
          for (const sha of shas.slice(0, 3)) {
            for (const st of await opts.statuses(sha).catch(() => [])) {
              const link = HT.teamcityLink(st.html_url);
              if (link?.server !== server) continue;
              if (link.buildTypeId) types.add(link.buildTypeId);
              else buildIds.push(link.buildId);
            }
            if (types.size || buildIds.length) break;
          }
          for (const id of buildIds.slice(0, 5)) {
            const b = await request(server, `/app/rest/builds/id:${id}?fields=buildTypeId`).catch(() => null);
            if (b?.buildTypeId) types.add(b.buildTypeId);
          }
          const ids = types.size ? [...types] : await detect(server, shas);
          return ids.slice(0, 8).map((id) => `buildType:(id:${id})`);
        })();
        memo.set(key, run.catch((err) => (memo.delete(key), Promise.reject(err))));
      }
      return memo.get(key);
    },

    // A build from a status link, for opening it in the sidebar.
    async build(server, id) {
      const b = await request(server, `/app/rest/builds/id:${id}?fields=${FIELDS.replace(/^count,build\((.*)\)$/, '$1')}`);
      const job = asJob(b);
      this.remember(server, [job]);
      return job;
    },

    forget() {
      memo.clear();
    },

    // ---- the job view, same interface as the site adapters ----
    async job(ctx, id) {
      const server = this._servers.get(id);
      const b = await request(server, `/app/rest/builds/id:${id}?fields=${FIELDS.replace(/^count,build\((.*)\)$/, '$1')}`);
      return asJob(b);
    },

    _servers: new Map(), // build id -> server, for the job view

    remember(server, list) {
      for (const b of list) this._servers.set(b.id, server);
    },

    log(ctx, job) {
      return request(this._servers.get(job.id), `/downloadBuildLog.html?buildId=${job.id}`, { text: true });
    },

    // Top-level blocks of the log are the steps ("Step 1/2: Build (5s)",
    // "Updating sources", …); a run of one-line entries joins into one step.
    // Nested lines fold under their block; E/W lines are colored.
    steps(job, text) {
      if (text == null) return { steps: [], byStep: null };
      const steps = [];
      const byStep = new Map();
      const lines = text.replace(/\r/g, '').split('\n');
      const parsed = [];
      for (const raw of lines) {
        const m = raw.match(/^\[(\d\d:\d\d:\d\d)\](.):(\t*) ?(.*)$/);
        if (!m) {
          if (raw.trim()) parsed.push({ depth: -1, flag: ' ', text: raw });
          continue;
        }
        const depth = m[3].length;
        // Nested lines repeat their parent block: "\t [Step 1/2] text".
        const body = depth ? m[4].replace(/^\[[^\]]*\] ?/, '') : m[4];
        parsed.push({ depth, flag: m[2], text: body });
      }
      const seconds = (d) => {
        let s = 0;
        for (const [, n, unit] of d.matchAll(/(\d+)([hms])/g)) s += Number(n) * { h: 3600, m: 60, s: 1 }[unit];
        return s * 1000;
      };
      let current = null;
      const start = (name, flag, blockStep) => {
        const dur = name.match(/\s\((<\s*)?([\dhms:]+)\)$/);
        current = {
          number: steps.length + 1,
          name: dur ? name.slice(0, dur.index) : name,
          status: 'completed',
          conclusion: flag === 'E' ? 'failure' : 'success',
          duration: dur ? seconds(dur[2]) : null,
          block: blockStep,
        };
        steps.push(current);
        byStep.set(current.number, []);
      };
      const color = (flag, t) => (flag === 'E' ? `\x1b[31m${t}\x1b[0m` : flag === 'W' ? `\x1b[33m${t}\x1b[0m` : t);
      let open = false; // a fold at depth 1 is open
      for (let i = 0; i < parsed.length; i++) {
        const line = parsed[i];
        const next = parsed[i + 1];
        if (line.depth <= 0) {
          if (open) byStep.get(current.number).push('##[endgroup]');
          open = false;
          const hasChildren = next && next.depth > 0;
          if (line.depth < 0) {
            if (!current) start('Build details', ' ', false);
            byStep.get(current.number).push(line.text);
          } else if (hasChildren || !current || current.block) {
            start(line.text, line.flag, hasChildren);
            if (!hasChildren) byStep.get(current.number).push(color(line.flag, line.text));
          } else {
            byStep.get(current.number).push(color(line.flag, line.text));
          }
          continue;
        }
        const out = byStep.get(current.number);
        if (line.depth === 1 && next && next.depth > 1) {
          if (open) out.push('##[endgroup]');
          out.push(`##[group]${color(line.flag, line.text)}`);
          open = true;
        } else {
          if (open && line.depth === 1) {
            out.push('##[endgroup]');
            open = false;
          }
          out.push(color(line.flag, `${'  '.repeat(Math.max(0, line.depth - 2))}${line.text}`));
        }
      }
      if (job.status !== 'completed' && current) {
        current.status = 'in_progress';
        current.conclusion = null;
      }
      return { steps, byStep };
    },
  };
})();

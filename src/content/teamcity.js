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
    let res = await HT.api.send({ type: 'ci', ci: 'teamcity', server, path, text });
    // Not signed in and no token: try TeamCity's guest access.
    if (res?.status === 401 && !res.hasToken && !path.startsWith('/guestAuth/')) {
      res = await HT.api.send({ type: 'ci', ci: 'teamcity', server, path: `/guestAuth${path}`, text });
    }
    if (!res?.ok) throw Object.assign(new HT.ApiError(res || { status: 0 }), { needsAccess: Boolean(res?.needsAccess) });
    return res.data;
  }

  const originOf = (value) => HT.ci.originOf(value);

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
      ci: 'teamcity',
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
    const lists = await Promise.all(
      shas.map((sha) =>
        builds(server, `revision:(version:${sha}),defaultFilter:false,count:20`).catch((err) => {
          if ([401, 403].includes(err.status) || err.needsAccess) throw err;
          return [];
        })
      )
    );
    const found = lists.find((list) => list.length);
    return found ? [...new Set(found.map((b) => b.buildTypeId))] : [];
  }

  async function scopeFor(server, id) {
    if (!HT.teamcityIds(id)) throw new Error(`"${id}" isn't a TeamCity ID.`);
    const kind = (isType) => (isType ? `buildType:(id:${id})` : `affectedProject:(id:${id})`);
    // An ID stays a build configuration or a project; no need to ask each time.
    const ck = `tcscope:${server}:${id}`;
    const known = await HT.cache.get(ck);
    if (known) return kind(known === 'type');
    const enc = encodeURIComponent(id);
    const isType = await get(server, `/app/rest/buildTypes/id:${enc}?fields=id`).then(
      () => true,
      (err) => {
        if ([401, 403].includes(err.status) || err.needsAccess) throw err;
        return false;
      }
    );
    HT.cache.set(ck, isType ? 'type' : 'project');
    return kind(isType);
  }

  const friendly = (err, server) => HT.ci.friendly(err, server);

  // Builds of one configuration (or a whole project) for the target.
  async function forScope(server, scope, target, limit) {
    const base = `${scope},defaultFilter:false,state:any,count:${limit}`;
    if (target.sha) return builds(server, `${base},revision:(version:${target.sha})`);
    const tries = target.isDefault ? ['branch:(default:true)'] : [];
    tries.push(`branch:(name:${target.ref})`, `branch:(name:refs/heads/${target.ref})`);
    // All spellings at once; the first one (in order) that has builds wins.
    const found = await Promise.all(tries.map((branch) => builds(server, `${base},${branch}`).catch(() => [])));
    return found.find((list) => list.length) || [];
  }

  // teamcity.toml at the root of a repository:
  //   [[server]]
  //   url = 'https://teamcity.example.com'
  //   project = 'MyProject'      (optional)
  //   job = 'MyProject_Build'    (optional; wins over project)
  // Only the first [[server]] block is read.
  function parseConfig(text) {
    const block = String(text).split(/^\s*\[\[server\]\]\s*$/m)[1]?.split(/^\s*\[/m)[0];
    if (!block) return null;
    const val = (key) => {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:'([^'\\n]*)'|"([^"\\n]*)")`, 'm').exec(block);
      return m ? (m[1] ?? m[2]).trim() : '';
    };
    const url = originOf(val('url'));
    return url ? { url, buildType: HT.teamcityIds(val('job') || val('project')) } : null;
  }

  // The IDs set for a repository, as a list; anything malformed is ignored.
  const idList = (text) => HT.teamcityIds(text).split(',').filter(Boolean);

  return {
    id: 'teamcity',
    tokenUrl: (server) => `${server}/profile.html?item=accessTokens`,
    parseConfig,
    name: 'TeamCity',
    liveLogs: true,

    linkFor: (url) => HT.teamcityLink(url),

    // The builds of one TeamCity source for a repository:
    //   { builds, url, note? }     builds (or why there are none)
    //   { needsAccess: server }    set up, but not granted yet
    // Which builds: the IDs set for the source (build configurations or
    // projects, comma-separated), else GitLab's integration's build
    // configuration on the same server, else TeamCity builds linked from or
    // built for the latest commits.
    // opts: { source, repoKey, target, limit, recentShas(), integration(), statuses(sha) }
    async load(opts) {
      const { server } = opts.source;
      let ids = idList(opts.source.ids);
      if (!ids.length) {
        opts.recentShas().catch(() => {}); // warm the commit list
        const integ = await opts.integration().catch(() => null);
        if (integ && originOf(integ.url) === server && integ.buildType) ids = idList(integ.buildType);
      }
      try {
        const scopes = ids.length ? await Promise.all(ids.map((id) => scopeFor(server, id))) : await this._detect(server, opts);
        if (!scopes.length) {
          return {
            builds: [],
            server,
            note: `No TeamCity builds found for the latest commits of ${opts.target.label}. Set the build configuration or project ID in Settings.`,
          };
        }
        const lists = await Promise.all(scopes.map((scope) => forScope(server, scope, opts.target, opts.limit)));
        // A configuration and its project can both be listed: one row per build.
        const seen = new Set();
        const all = lists.flat().filter((b) => !seen.has(b.id) && seen.add(b.id)).map(asJob);
        all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id - a.id);
        this.remember(server, all);
        const projectId = all[0]?.projectId;
        return { builds: all.slice(0, opts.limit), url: projectId ? `${server}/project/${encodeURIComponent(projectId)}` : server };
      } catch (err) {
        if (err.needsAccess) return { needsAccess: server, builds: [] };
        throw friendly(err, server);
      }
    },

    // A step-by-step check of a repository's TeamCity setup, for Settings:
    // [{ ok: true | false, text }]. Stops at the first step that fails.
    async diagnose(opts) {
      const out = [];
      const step = (ok, text) => (out.push({ ok, text }), ok);
      const conf = opts.source;
      const { server } = conf;
      const host = new URL(server).host;
      const { granted } = await HT.api.send({ type: 'ci:access', server });
      if (!step(granted, granted ? `Hector may reach ${host}.` : `Hector isn't allowed to reach ${host} yet (Allow access).`)) return out;
      try {
        const info = await request(server, '/app/rest/server?fields=version');
        step(true, `Reached TeamCity ${info.version}.`);
      } catch (err) {
        step(false, `Couldn't reach TeamCity at ${host}: ${friendly(err, server).message}`);
        return out;
      }
      try {
        const me = await request(server, '/app/rest/users/current?fields=username,name');
        step(true, me.username === 'guest' ? 'Using guest access (sign in or add a token to see private projects).' : `Signed in as ${me.name || me.username}.`);
      } catch (err) {
        step(false, friendly(err, server).message);
        return out;
      }
      let scopes;
      try {
        const integ = await opts.integration().catch(() => null);
        let ids = idList(conf.ids);
        let from = 'set in Hector';
        if (!ids.length && integ && originOf(integ.url) === server && integ.buildType) {
          ids = idList(integ.buildType);
          from = "from this repository's TeamCity settings";
        }
        if (ids.length) {
          scopes = await Promise.all(ids.map((id) => scopeFor(server, id)));
          step(true, `Builds of ${scopes.map((sc) => sc.replace(/^(\w+):\(id:(.*)\)$/, (m, kind, id) => `${kind === 'buildType' ? 'configuration' : 'project'} ${id}`)).join(', ')} (${from}).`);
        } else {
          scopes = await this._detect(server, opts);
          if (!step(scopes.length > 0, scopes.length ? `Found ${scopes.length} build configuration${scopes.length === 1 ? '' : 's'} that built the latest commits: ${scopes.map((sc) => sc.replace(/^buildType:\(id:(.*)\)$/, '$1')).join(', ')}.` : `No TeamCity build of the latest commits of ${opts.target.label} was found. Set the build configuration or project ID.`)) return out;
        }
      } catch (err) {
        step(false, friendly(err, server).message);
        return out;
      }
      let latest;
      try {
        const lists = await Promise.all(scopes.map((scope) => forScope(server, scope, opts.target, 5)));
        const all = lists.flat().map(asJob).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        latest = all[0];
        if (!step(Boolean(latest), latest ? `${all.length >= 5 ? '5+' : all.length} build${all.length === 1 ? '' : 's'} for ${opts.target.label}; latest #${latest.run_number} (${latest.conclusion || latest.status}).` : `No builds for ${opts.target.label} in those configurations.`)) return out;
      } catch (err) {
        step(false, friendly(err, server).message);
        return out;
      }
      try {
        this.remember(server, [latest]);
        const text = await this.log(null, latest);
        const { steps } = this.steps(latest, text);
        step(true, `Read the log of #${latest.run_number}: ${steps.length} step${steps.length === 1 ? '' : 's'}.`);
      } catch (err) {
        step(false, `Couldn't read the build log: ${friendly(err, server).message}`);
      }
      return out;
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
          const statuses = await Promise.all(shas.slice(0, 3).map((sha) => opts.statuses(sha).catch(() => [])));
          for (const list of statuses) {
            for (const st of list) {
              const link = HT.teamcityLink(st.html_url);
              if (link?.server !== server) continue;
              if (link.buildTypeId) types.add(link.buildTypeId);
              else buildIds.push(link.buildId);
            }
            if (types.size || buildIds.length) break;
          }
          const linked = await Promise.all(
            buildIds.slice(0, 5).map((id) => request(server, `/app/rest/builds/id:${id}?fields=buildTypeId`).catch(() => null))
          );
          for (const b of linked) if (b?.buildTypeId) types.add(b.buildTypeId);
          const ids = types.size ? [...types] : await detect(server, shas);
          return ids.slice(0, 8).map((id) => `buildType:(id:${id})`);
        })();
        memo.set(key, run.catch((err) => (memo.delete(key), Promise.reject(err))));
      }
      return memo.get(key);
    },

    // A build from a status link, for opening it in the sidebar.
    async build(server, link) {
      const id = String(link.buildId);
      if (!/^\d+$/.test(id)) throw new Error('Not a TeamCity build link.');
      const b = await request(server, `/app/rest/builds/id:${id}?fields=${FIELDS.replace(/^count,build\((.*)\)$/, '$1')}`);
      const job = asJob(b);
      this.remember(server, [job]);
      return job;
    },

    originOf,

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

HT.ci.register(HT.teamcity);

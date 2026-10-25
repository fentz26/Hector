// External CI servers for a repository: TeamCity, Jenkins, or any service
// behind a JSON endpoint. A repository can list several, of any kind.
//
// Each adapter (teamcity.js, jenkins.js, customci.js) registers itself here
// and offers the same interface the site adapters use for runs and jobs:
//   id, name, liveLogs
//   load({ source, target, limit, recentShas, statuses, integration, repo })
//       -> { builds, url?, note? } | { needsAccess: server }
//   diagnose(same opts) -> [{ ok, text }]
//   job(ctx, id), log(ctx, job), steps(job, text)
//   linkFor(url) -> { server, buildId, ... } | null   (optional)
//   build(server, link) -> a build                    (optional)
//   forget()
// Builds carry `ci: <adapter id>`; their ids only need to be unique per
// adapter. Requests go through the background worker, which only lets them
// reach a server some repository lists, that the user allowed, on paths of
// that CI's API.
HT.ci = (() => {
  const types = {};

  const RULES = {
    teamcity: {
      label: 'Build configuration or project IDs',
      placeholder: 'Detected from your commits',
      help: 'Comma-separated. Empty finds the builds of this branch\'s latest commits.',
      serverPlaceholder: 'https://teamcity.example.com',
      tokenHint: 'Access token (optional)',
      idRe: /^[\w.-]{1,200}$/,
      idError: 'IDs may only have letters, digits, "_", "." and "-", separated by commas.',
    },
    jenkins: {
      label: 'Jobs',
      placeholder: 'folder/job, multibranch-job',
      help: 'Job paths, comma-separated. Multibranch jobs pick the branch themselves. Empty uses the jobs linked from commit statuses.',
      serverPlaceholder: 'https://jenkins.example.com',
      tokenHint: 'user:apitoken (optional)',
      // Segments of only dots would walk the API path.
      idRe: /^(?!\.+(\/|$))[\w.\- ]{1,100}(\/(?!\.+(\/|$))[\w.\- ]{1,100}){0,10}$/,
      idError: 'Job paths may only have letters, digits, spaces, "_", ".", "-" and "/", separated by commas.',
    },
    custom: {
      label: 'Name',
      placeholder: 'Shown in the CI/CD tab',
      help: 'The address may use {sha}, {ref}, {branch}, {owner} and {repo}. It must answer JSON: a list of builds (or {"builds": [...]}) with id, name, status, url, started_at, finished_at and optionally log_url, log or steps.',
      serverPlaceholder: 'https://ci.example.com/api/builds?sha={sha}',
      tokenHint: 'Bearer token (optional)',
      idRe: null,
      idError: '',
    },
  };

  const originOf = (value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin.toLowerCase() : null;
    } catch {
      return null;
    }
  };

  // "A,B" cleaned, or '' when any entry is not an ID of that CI.
  function cleanIds(type, text) {
    const rule = RULES[type];
    if (!rule?.idRe) return '';
    const ids = String(text || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.length || ids.length > 20 || ids.some((id) => !rule.idRe.test(id))) return '';
    return ids.join(',');
  }

  // A source as stored: { type, server, ids?, name? }. For TeamCity and
  // Jenkins `server` is an origin; for a custom CI it is the whole address
  // (with placeholders) and `name` is what the tab calls it.
  function cleanSource(s) {
    if (!s || typeof s !== 'object' || !RULES[s.type] || typeof s.server !== 'string') return null;
    const raw = s.server.trim();
    const origin = originOf(raw.includes('://') ? raw : `https://${raw}`);
    if (!origin) return null;
    const out = { type: s.type };
    if (s.type === 'custom') {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (url.hash || url.href.length > 1000) return null;
      out.server = url.href;
      const name = typeof s.name === 'string' ? s.name.trim().slice(0, 60) : '';
      if (name) out.name = name;
    } else {
      out.server = origin;
      const ids = cleanIds(s.type, s.ids);
      if (s.ids && String(s.ids).trim() && !ids) return null;
      if (ids) out.ids = ids;
    }
    return out;
  }

  // The sources of a repository's CI settings; older settings had one
  // TeamCity server under `teamcity`.
  function sources(conf) {
    const list = Array.isArray(conf?.sources) ? conf.sources : conf?.teamcity?.server ? [{ type: 'teamcity', ...conf.teamcity }] : [];
    return list.map(cleanSource).filter(Boolean).slice(0, 8);
  }

  const label = (s) => (s.type === 'custom' ? s.name || new URL(s.server).host : types[s.type]?.name || s.type);
  const sourceKey = (s) => `ext:${s.type}:${originOf(s.server)}`;
  const runId = (build) => `ext:${build.ci}:${build.id}`;

  // "https://ci/x?sha={sha}" with the values filled in, encoded.
  function fill(template, vars) {
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? encodeURIComponent(vars[k] ?? '') : m));
  }

  async function request(type, server, path, { text = false } = {}) {
    const res = await HT.api.send({ type: 'ci', ci: type, server, path, text });
    if (!res?.ok) throw Object.assign(new HT.ApiError(res || { status: 0 }), { needsAccess: Boolean(res?.needsAccess) });
    return res.data;
  }

  // Statuses from other CIs link to their builds; which configured source
  // a link belongs to, with the adapter's reading of it.
  function linkFor(url, list) {
    for (const s of list) {
      const adapter = types[s.type];
      const link = adapter?.linkFor?.(url);
      if (link && link.server === originOf(s.server)) return { source: s, adapter, link };
    }
    return null;
  }

  // Whether the user signed in / the server needs a sign-in, in words.
  function friendly(err, server) {
    if ([401, 403].includes(err.status)) {
      const host = new URL(server).host;
      return Object.assign(new Error(`${host} needs you signed in: log in to it in this browser, or add an access token for it in Settings.`), { status: err.status });
    }
    return err;
  }

  return {
    types,
    RULES,
    register: (adapter) => {
      types[adapter.id] = adapter;
    },
    sources,
    cleanSource,
    cleanIds,
    label,
    sourceKey,
    runId,
    fill,
    request,
    originOf,
    linkFor,
    friendly,
    forget() {
      for (const a of Object.values(types)) a.forget?.();
    },
  };
})();

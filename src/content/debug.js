// "Report a problem": a plain-text report of what Hector sees on this page,
// for the user to read and send. It holds versions, how the site was
// detected, what Hector made of the page, the sidebar's state, the recent
// requests (path and status only) and errors. Never tokens, cookies, file
// contents or log text. With `redact`, repository, user, branch and server
// names become placeholders.
HT.debug = (() => {
  const errors = []; // newest last
  const MAX = 30;

  function note(where, err, extra = {}) {
    errors.push({ at: Date.now(), where, status: err?.status ?? null, message: String(err?.message || err).slice(0, 300), ...extra });
    if (errors.length > MAX) errors.shift();
  }

  // Errors thrown by Hector's own scripts (not the page's).
  const ours = (file) => typeof file === 'string' && file.startsWith(chrome.runtime.getURL(''));
  addEventListener('error', (e) => ours(e.filename) && note('script', e.error || e.message, { file: e.filename.split('/').pop(), line: e.lineno }));
  addEventListener('unhandledrejection', (e) => {
    const stack = String(e.reason?.stack || '');
    if (stack.includes(chrome.runtime.getURL(''))) note('promise', e.reason);
  });

  // Which page markers the site detection saw.
  function signals() {
    const found = [];
    const meta = (sel, label) => document.querySelector(sel) && found.push(label);
    meta('meta[name="application-name"][content="Bitbucket"]', 'meta application-name=Bitbucket');
    if (document.body?.classList.contains('bitbucket-theme')) found.push('body.bitbucket-theme');
    meta('meta[property="og:site_name"][content="GitLab"]', 'meta og:site_name=GitLab');
    if (document.body?.dataset.page != null) found.push(`body[data-page=${document.body.dataset.page}]`);
    meta('meta[name="expected-hostname"]', 'meta expected-hostname');
    meta('meta[name="github-keyboard-shortcuts"]', 'meta github-keyboard-shortcuts');
    meta('meta[property="og:site_name"][content="GitHub"]', 'meta og:site_name=GitHub');
    return found.length ? found.join(', ') : 'none';
  }

  const SETTINGS = ['docked', 'dock', 'width', 'fontSize', 'theme', 'iconPack', 'compactFolders', 'fileIcons', 'previewFiles', 'prDefaultTab', 'tabOrder', 'hiddenTabs', 'splitPos', 'splitSize', 'toggleY'];
  const time = (t) => new Date(t).toISOString().slice(11, 19);
  const err = (e) => (e ? `${e.status != null ? `[${e.status}] ` : ''}${e.message || e}` : '');

  async function build(sb, { redact = true } = {}) {
    const manifest = chrome.runtime.getManifest();
    const ctx = sb.ctx;
    const [bg, token] = await Promise.all([
      HT.api.send({ type: 'debug:log', host: location.host }).catch((e) => ({ error: e.message })),
      HT.api.send({ type: 'token:status', host: location.host }).catch(() => null),
    ]);
    const conf = ctx ? await HT.store.repoCI(HT.url.repoKey(ctx)).catch(() => ({})) : {};
    const ci = sb.ci;
    const code = sb.code;

    const lines = [];
    const add = (...l) => lines.push(...l);
    add(
      '### Hector debug report',
      '',
      `- Hector: ${HT.versionLabel(manifest.version)}`,
      `- Browser: ${navigator.userAgent}`,
      `- Time: ${new Date().toISOString()}`,
      `- Page: ${location.origin}${location.pathname}`,
      `- Site: ${HT.provider.id}${HT.provider.site ? ` (looks like ${HT.provider.site})` : ''}; self-hosted: ${['github.com', 'gitlab.com', 'bitbucket.org'].includes(location.host) ? 'no' : 'yes'}`,
      `- Page markers: ${signals()}`,
      `- Access to this site: ${bg?.granted ? 'granted' : bg?.granted === false ? 'not granted' : 'unknown'}; find servers on any site: ${bg?.autoDetect ? 'on' : 'off'}`,
      `- Signed in: ${token?.hasToken ? 'token saved' : 'no token'}${sb.account ? `, account via ${sb.account.method || 'sign-in'}` : ''}${sb.rate ? `; API budget ${sb.rate.remaining}/${sb.rate.limit}` : ''}`,
      '',
      '#### What Hector made of the page',
      ctx
        ? `- ${ctx.kind}: ${ctx.owner}/${ctx.repo}${ctx.contextPath ? ` (context path ${ctx.contextPath})` : ''}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ''}${ctx.at ? `, at=${ctx.at}` : ''}`
        : '- Not a repository page',
      ctx ? `- Default branch: ${sb.repo?.defaultBranch ?? '(not loaded)'}; ref: ${code?.ref ?? '-'}; path: ${sb.currentPath || '/'}` : '',
      code ? `- Tree: ${code.loading ? 'loading' : code.error ? `error ${err(code.error)}` : `${code.count ?? '?'} files${code.lazy ? ', folders load on demand' : ''}`}` : '',
      sb.error ? `- Error shown: ${err(sb.error)}` : '',
      '',
      '#### Sidebar',
      `- Visible: ${Boolean(sb.visible)}, docked: ${Boolean(sb.s.docked)}, tab: ${sb.tab}${sb.split ? `, split: ${sb.split}` : ''}${sb.settingsOpen ? ', settings open' : ''}`,
      `- Settings: ${SETTINGS.map((k) => `${k}=${JSON.stringify(sb.s[k])}`).join(', ')}`,
      '',
      '#### CI/CD for this repository',
      `- Site's own ${HT.provider.terms?.runs || 'runs'}: ${conf.native === false ? 'hidden' : 'shown'}${ci ? `; ${ci.loading ? 'loading' : `${ci.runs?.length ?? 0} loaded`}${ci.error ? `; error ${err(ci.error)}` : ''}` : ''}`,
      ...HT.ci.sources(conf).map((s) => `- Source: ${s.type} ${HT.ci.originOf(s.server)}${s.ids ? ` (${s.ids.split(',').length} IDs)` : ''}`),
      ...(ci?.ext || []).map((e) => `- ${e.label} ${e.server || ''}: ${e.error ? `error ${err(e.error)}` : e.needsAccess ? 'needs access' : e.suggest ? 'suggested' : `${e.builds?.length ?? 0} builds`}${e.note ? `; note: ${e.note}` : ''}`),
      ci?.other ? `- Other CI statuses: ${ci.other.length}` : '',
      '',
      '#### Recent requests (newest last)',
      ...(bg?.requests?.length
        ? bg.requests.map((r) => `- ${time(r.at)} ${r.via} ${r.status ?? '-'} ${r.ms}ms ${r.server ? `${r.server} ` : ''}${redact ? cleanPath(r.path) : r.path}${r.error ? ` (${r.error})` : ''}`)
        : [`- none${bg?.error ? ` (${bg.error})` : ''}`]),
      '',
      '#### Recent errors (newest last)',
      ...(errors.length ? errors.map((e) => `- ${time(e.at)} ${e.where}${e.status != null ? ` [${e.status}]` : ''}: ${e.message}${e.path ? ` (${redact ? cleanPath(e.path) : e.path})` : ''}${e.file ? ` (${e.file}:${e.line})` : ''}`) : ['- none'])
    );
    let text = lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
    if (redact) text = scrub(text, sb);
    return text;
  }

  // Request paths without file and folder names: segments that aren't API
  // words, numbers or commit hashes become "…", and query values are dropped.
  const API_WORD = /^(rest|api|v\d+|\d+(\.\d+)*|latest|repos|repositories|projects|users|files|browse|raw|src|commits?|branches|tags|refs|pulls?|pull-requests|pullrequests|merge_requests|changes|diffstat|diff|statuses|status|check-runs|actions|runs|jobs|logs?|pipelines|steps|deployments|builds|build-status|git|trees|contents|default-branch|application-properties|plugins|servlet|applinks|whoami|app|guestAuth|downloadBuildLog\.html|job|consoleText|wfapi|describe|user|me|integrations|services|teamcity|trace|tree-list|[0-9a-f]{7,40}|id:\d+)$/i;
  function cleanPath(path) {
    const [p, q] = String(path).split('?');
    const segs = p.split('/').map((s) => (!s || API_WORD.test(HT.decodeSegment(s)) ? s : '…'));
    const keys = q ? `?${q.split('&').map((kv) => `${kv.split('=')[0]}=…`).join('&')}` : '';
    return segs.join('/') + keys;
  }

  // Names that identify the user's work become placeholders.
  function scrub(text, sb) {
    const swaps = [];
    const ctx = sb.ctx;
    const servers = new Set();
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+(?::\d+)?)/gi)) servers.add(m[1].toLowerCase());
    servers.add(location.host);
    let n = 0;
    for (const host of servers) {
      if (['github.com', 'api.github.com', 'gitlab.com', 'bitbucket.org', 'api.bitbucket.org'].includes(host)) continue;
      swaps.push([host, host === location.host ? 'site.example' : `server-${++n}.example`]);
    }
    if (ctx) {
      swaps.push([ctx.owner, 'OWNER'], [ctx.repo, 'REPO']);
      if (ctx.contextPath) swaps.push([ctx.contextPath, '/CONTEXT']);
    }
    for (const ref of [sb.code?.ref, sb.repo?.defaultBranch, ctx?.at, sb.refLabel]) {
      if (ref && !/^[0-9a-f]{7,40}$/i.test(ref) && !['main', 'master', 'develop'].includes(ref)) swaps.push([ref, 'BRANCH']);
    }
    if (sb.currentPath) swaps.push([sb.currentPath, 'PATH']);
    if (sb.account?.login) swaps.push([sb.account.login, 'USER']);
    // Longest first, so "org/repo-name" isn't half replaced by "repo".
    swaps.sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of swaps) {
      if (!from || from.length < 2) continue;
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Whole names only ("api" in a path is not the repository "api-docs").
      const whole = (s) => new RegExp(`(?<![\\w-])${esc(s)}(?![\\w-])`, 'gi');
      text = text.replace(whole(from), to);
      // Also as it appears in URLs.
      const enc = encodeURIComponent(from);
      if (enc !== from) text = text.replace(whole(enc), to);
    }
    return text;
  }

  return { note, build, errors };
})();

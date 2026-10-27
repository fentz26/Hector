// Custom tabs ("add-ons"): tabs the user makes, from three kinds that need
// no code of their own:
//   links  — a list of links built from the page (open in github.dev, …)
//   file   — a file from the repository at the ref being viewed (CHANGELOG.md)
//   feed   — a list from a JSON address (releases, issues, an internal API)
// Addresses take page placeholders: {owner} {repo} {ref} {sha} {path} {pull}
// {host} {origin} {repoUrl}; a feed's item fields read {item.path.to.field}.
// Definitions live in sync storage (`customTabs`) and are checked here
// wherever they come from (the editor, an import, a backup).
HT.customTabs = (() => {
  const TYPES = { links: 'Links', file: 'Repository file', feed: 'JSON feed' };
  const SITES = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
  const ICONS = ['bookmark', 'external', 'repo', 'files', 'file', 'folder', 'commit', 'branch', 'pull', 'diff', 'actions', 'deploy', 'search', 'star', 'check', 'settings'];
  const MAX_TABS = 12;
  const MAX_LINKS = 30;
  const PAGE_VARS = ['owner', 'repo', 'ref', 'sha', 'path', 'pull', 'host', 'origin', 'repoUrl'];

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const field = (v) => (typeof v === 'string' && /^[\w.-]{0,80}$/.test(v.trim()) ? v.trim() : '');

  // A template must start at a fixed http(s) origin, or at the page's own
  // ({origin}, {repoUrl}); a feed's must be a fixed origin (the background
  // only fetches origins a tab names).
  function template(v, { fixedOrigin = false } = {}) {
    const t = str(v, 1000);
    if (!t) return '';
    if (!fixedOrigin && /^\{(origin|repoUrl)\}/.test(t)) return t;
    try {
      const url = new URL(t.replace(/\{[\w.]+\}/g, 'x'));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
      const origin = t.match(/^https?:\/\/[^/?#]+/)?.[0] || '';
      return origin.includes('{') ? '' : t;
    } catch {
      return '';
    }
  }

  function clean(def) {
    if (!def || typeof def !== 'object' || !TYPES[def.type]) return null;
    const id = typeof def.id === 'string' && /^x-[a-z0-9]{4,16}$/.test(def.id) ? def.id : `x-${Math.random().toString(36).slice(2, 10)}`;
    const out = { id, name: str(def.name, 30) || TYPES[def.type], icon: ICONS.includes(def.icon) ? def.icon : 'bookmark', type: def.type };
    const sites = Array.isArray(def.sites) ? def.sites.filter((s) => SITES[s]) : [];
    if (sites.length) out.sites = [...new Set(sites)];
    if (def.type === 'links') {
      out.links = (Array.isArray(def.links) ? def.links : [])
        .map((l) => ({ label: str(l?.label, 60), url: template(l?.url) }))
        .filter((l) => l.label && l.url)
        .slice(0, MAX_LINKS);
      if (!out.links.length) return null;
    } else if (def.type === 'file') {
      const path = str(def.path, 300).replace(/^\/+/, '');
      if (!path || path.split('/').some((p) => p === '..' || p === '.')) return null;
      out.path = path;
    } else {
      const f = def.feed || {};
      const url = template(f.url, { fixedOrigin: true });
      if (!url) return null;
      out.feed = { url, items: field(f.items), title: str(f.title, 200) || '{item.title}', subtitle: str(f.subtitle, 200), link: str(f.link, 1000), date: field(f.date) };
    }
    return out;
  }

  function cleanList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list
      .map(clean)
      .filter((d) => d && !seen.has(d.id) && seen.add(d.id))
      .slice(0, MAX_TABS);
  }

  // Ready-made tabs to start from.
  const PRESETS = [
    {
      name: 'Open in…',
      icon: 'external',
      type: 'links',
      sites: ['github'],
      links: [
        { label: 'github.dev (web editor)', url: 'https://github.dev/{owner}/{repo}/tree/{ref}/{path}' },
        { label: 'vscode.dev', url: 'https://vscode.dev/github/{owner}/{repo}/tree/{ref}/{path}' },
        { label: 'Sourcegraph', url: 'https://sourcegraph.com/github.com/{owner}/{repo}@{ref}/-/tree/{path}' },
        { label: 'DeepWiki', url: 'https://deepwiki.com/{owner}/{repo}' },
        { label: 'Codespaces', url: 'https://github.com/codespaces/new?repo={owner}/{repo}&ref={ref}' },
      ],
    },
    {
      name: 'Open in…',
      icon: 'external',
      type: 'links',
      sites: ['gitlab'],
      links: [
        { label: 'Web IDE', url: '{repoUrl}/-/ide/project/{owner}/{repo}/edit/{ref}/-/{path}' },
        { label: 'Graph', url: '{repoUrl}/-/network/{ref}' },
        { label: 'Contributors', url: '{repoUrl}/-/graphs/{ref}' },
      ],
    },
    { name: 'Changelog', icon: 'file', type: 'file', path: 'CHANGELOG.md' },
    {
      name: 'Releases',
      icon: 'deploy',
      type: 'feed',
      sites: ['github'],
      feed: { url: 'https://api.github.com/repos/{owner}/{repo}/releases?per_page=30', items: '', title: '{item.tag_name}', subtitle: '{item.name}', link: '{item.html_url}', date: 'published_at' },
    },
    {
      name: 'Issues',
      icon: 'check',
      type: 'feed',
      sites: ['github'],
      feed: { url: 'https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=50', items: '', title: '{item.title}', subtitle: '#{item.number} by {item.user.login}', link: '{item.html_url}', date: 'created_at' },
    },
  ];

  // The values the placeholders stand for on this page.
  function vars(sb) {
    const ctx = sb.ctx;
    if (!ctx) return null;
    const repoUrl = HT.provider.base(ctx);
    return {
      owner: ctx.owner,
      repo: ctx.repo,
      ref: sb.refLabel && !/^[0-9a-f]{7}$/i.test(sb.refLabel) ? sb.refLabel : sb.code?.ref || sb.repo?.defaultBranch || '',
      sha: sb.pr?.sha || (/^[0-9a-f]{40}$/i.test(sb.code?.ref || '') ? sb.code.ref : sb.pr?.info?.headSha || ''),
      path: sb.currentPath || '',
      pull: ctx.pullNumber ? String(ctx.pullNumber) : '',
      host: ctx.host,
      origin: ctx.origin,
      repoUrl,
    };
  }

  const dig = (obj, path) => (path ? path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) : obj);

  // Fills page placeholders (encoded; {path} keeps its slashes, {origin} and
  // {repoUrl} stay as they are) and, for feeds, {item.…} fields.
  function fill(t, v, item) {
    return t.replace(/\{([\w.]+)\}/g, (m, k) => {
      if (k.startsWith('item.') && item !== undefined) {
        const x = dig(item, k.slice(5));
        return x == null ? '' : String(x);
      }
      if (!PAGE_VARS.includes(k)) return m;
      const val = v[k] ?? '';
      if (k === 'origin' || k === 'repoUrl') return val;
      if (k === 'path') return HT.encodePath(val);
      return encodeURIComponent(val);
    });
  }

  // A filled link, tidy at the end ("…/tree/main/" → "…/tree/main").
  function link(t, v, item) {
    const url = fill(t, v, item).replace(/\/+(?=$|[?#])/, '');
    return HT.safeUrl(url);
  }

  return {
    TYPES,
    SITES,
    ICONS,
    PRESETS,
    MAX_TABS,
    clean,
    cleanList,
    vars,
    fill,
    link,
    dig,
    list: () => cleanList(HT.settings.customTabs),
    // Tabs that apply to the site being viewed.
    forSite(site) {
      return this.list().filter((t) => !t.sites || t.sites.includes(site === 'bitbucket-server' ? 'bitbucket' : site));
    },
    isCustom: (id) => typeof id === 'string' && /^x-[a-z0-9]{4,16}$/.test(id),
  };
})();

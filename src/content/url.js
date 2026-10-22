// Parses GitHub URLs into a repo context, or null when the page isn't a repo.
const RESERVED_OWNERS = new Set([
  '', 'about', 'account', 'apps', 'blog', 'business', 'codespaces', 'collections', 'contact', 'copilot',
  'customer-stories', 'dashboard', 'enterprise', 'enterprises', 'events', 'explore', 'features', 'github-copilot',
  'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'organizations', 'orgs', 'pricing',
  'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'stars', 'team',
  'topics', 'trending', 'users', 'watching', 'discussions', 'resources', 'solutions', 'partners', 'mobile', 'home',
]);

HT.url = {
  parse(loc = location) {
    const parts = loc.pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    const [owner, repo, section, ...rest] = parts;
    if (!owner || !repo || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    const base = { host: loc.host, owner, repo: repo.replace(/\.git$/, '') };

    if (section === 'pull' && /^\d+$/.test(rest[0] || '')) {
      return { ...base, kind: 'pull', pullNumber: Number(rest[0]), segments: [] };
    }
    if (section === 'tree' || section === 'blob') {
      return { ...base, kind: section, segments: rest };
    }
    return { ...base, kind: 'repo', segments: [] };
  },

  repoKey(ctx) {
    return `${ctx.host}/${ctx.owner}/${ctx.repo}`.toLowerCase();
  },
};

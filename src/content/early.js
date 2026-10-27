// Runs as the page starts loading, before it paints: if Hector was docked
// on this site last time, make its room and paint its color now, so a full
// page load doesn't flash the page at full width and then shove it over.
// The sidebar takes over when it attaches (or clears this if it stays hidden).
(() => {
  if (globalThis.__hectorEarly) return;
  globalThis.__hectorEarly = true;
  // Only where a repository can be: not the site's own pages (dashboards,
  // settings, search…), where the sidebar stays hidden.
  const parts = location.pathname.split('/').filter(Boolean);
  const SITE_PAGES = ['dashboard', '-', 'users', 'admin', 'explore', 'help', 'search', 'groups', 'settings', 'notifications', 'login', 'sessions', 'organizations', 'orgs', 'account', 'pulls', 'issues', 'marketplace', 'projects', 'plugins', 'rest'];
  // Bitbucket Server's repositories live under /projects/…/repos/ and /users/…/repos/.
  if (parts.length < 2 || (SITE_PAGES.includes(parts[0].toLowerCase()) && !parts.includes('repos'))) return;
  const key = `shell:${location.host}`;
  chrome.storage.local.get(key).then((got) => {
    const shell = got[key];
    if (!shell || globalThis.__hectorLoaded) return;
    const html = document.documentElement;
    const dock = shell.dock === 'right' ? 'right' : 'left';
    const width = Math.min(Math.max(Number(shell.width) || 300, 160), 1200);
    html.style.setProperty('--hector-width', `${width}px`);
    if (/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(shell.bg || '')) html.style.setProperty('--hector-early-bg', shell.bg);
    html.classList.add(`hector-docked-${dock}`, 'hector-early');
    // Never longer than the sidebar needs to load.
    setTimeout(() => {
      if (!html.classList.contains('hector-early')) return;
      html.classList.remove('hector-early');
      if (!globalThis.__hectorLoaded) html.classList.remove(`hector-docked-${dock}`);
    }, 5000);
  }, () => {});
})();

// Entry point: boots the sidebar and follows GitHub's client-side navigation.
(async () => {
  if (globalThis.__hectorLoaded) return;
  globalThis.__hectorLoaded = true;

  HT.provider = HT.url.detectProvider();
  HT.api.provider = HT.provider.id;
  await HT.store.load();
  // GitLab's icons, if they arrive quickly; otherwise they swap in later.
  const glIcons = HT.provider.id === 'gitlab' ? HT.glIcons.refresh().catch(() => false) : null;
  if (glIcons) await Promise.race([glIcons, new Promise((r) => setTimeout(r, 800))]);
  const sidebar = new HT.Sidebar();
  await sidebar.restoreState(); // the tab last used on this site
  sidebar.checkUpdateQuietly();
  glIcons?.then((fresh) => fresh && sidebar.refreshIcons());
  let lastUrl = null;

  const check = () => {
    sidebar.ensureAttached();
    const url = location.href.split('#')[0];
    if (url === lastUrl) return;
    lastUrl = url;
    // GitLab renders its file icons late; pick up the sprite once it shows.
    if (HT.provider.id === 'gitlab') {
      const look = () => HT.glIcons.refresh().then((fresh) => fresh && sidebar.refreshIcons(), () => {});
      look();
      setTimeout(look, 2500);
    }
    const ctx = HT.url.parse(location);
    if (ctx) sidebar.navigate(ctx);
    else sidebar.hide();
  };

  check();
  document.addEventListener('turbo:load', check);
  document.addEventListener('turbo:render', check);
  document.addEventListener('pjax:end', check);
  window.addEventListener('popstate', check);
  // GitHub's React views use history.pushState, which an isolated-world
  // script can't hook. The Navigation API reports those (Chrome 102+,
  // Firefox 147+); where it exists the URL poll is only a slow safety net.
  const nav = globalThis.navigation;
  if (nav?.addEventListener) nav.addEventListener('currententrychange', () => setTimeout(check, 0));
  setInterval(check, nav ? 1500 : 400);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle') sidebar.toggle();
  });
})();

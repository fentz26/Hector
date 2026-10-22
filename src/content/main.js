// Entry point: boots the sidebar and follows GitHub's client-side navigation.
(async () => {
  if (globalThis.__hectaTreeLoaded) return;
  globalThis.__hectaTreeLoaded = true;

  await HT.store.load();
  const sidebar = new HT.Sidebar();
  let lastUrl = null;

  const check = () => {
    sidebar.ensureAttached();
    const url = location.href.split('#')[0];
    if (url === lastUrl) return;
    lastUrl = url;
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
  // script can't hook, so also poll the URL cheaply.
  setInterval(check, 400);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'toggle') sidebar.toggle();
  });
})();

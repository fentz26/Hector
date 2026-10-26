// Asks for a host permission the sidebar needs (a content script can't).
const params = new URLSearchParams(location.search);
// ?sites=1: Hector's own sites (GitHub, GitLab, Bitbucket), all at once.
const sites = params.get('sites') === '1' ? chrome.runtime.getManifest().host_permissions || [] : null;
const origin = (() => {
  try {
    const url = new URL(params.get('origin'));
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
})();

document.querySelector('#host').textContent = sites ? 'GitHub, GitLab and Bitbucket' : origin ? new URL(origin).host : 'this server';
document.querySelector('#why').textContent = sites
  ? 'Hector needs these to show its sidebar and read repositories there. Your browser removed them (a temporary add-on loses them on every reload).'
  : params.get('why') || '';

document.querySelector('#allow').addEventListener('click', async () => {
  if (!origin && !sites) return window.close();
  // Must run inside the click's user gesture.
  const granted = await chrome.permissions.request({ origins: sites || [`${origin}/*`] }).catch(() => false);
  if (granted) {
    // Offered from the toolbar button on a code host: start Hector there.
    if (params.get('site') === '1') await chrome.runtime.sendMessage({ type: 'site:add', origin, tabId: Number(params.get('tab')) }).catch(() => {});
    // Tells open sidebars to try again.
    await chrome.storage.local.set({ grantedAt: Date.now() });
    window.close();
  } else {
    const status = document.querySelector('#status');
    status.textContent = 'Access was not granted.';
    status.className = 'status err';
  }
});
document.querySelector('#cancel').addEventListener('click', () => window.close());

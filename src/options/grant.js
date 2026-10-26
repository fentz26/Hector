// Asks for a host permission the sidebar needs (a content script can't).
const params = new URLSearchParams(location.search);
const origin = (() => {
  try {
    const url = new URL(params.get('origin'));
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
})();

document.querySelector('#host').textContent = origin ? new URL(origin).host : 'this server';
document.querySelector('#why').textContent = params.get('why') || '';

document.querySelector('#allow').addEventListener('click', async () => {
  if (!origin) return window.close();
  // Must run inside the click's user gesture.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
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

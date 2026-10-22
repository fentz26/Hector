// HectaTree background worker: proxies GitHub API calls (so tokens never touch
// the page), caches responses with ETags, and registers content scripts for
// GitHub Enterprise hosts the user has granted access to.

const CONTENT_JS = [
  'src/content/util.js',
  'src/content/styles.js',
  'src/content/icons.js',
  'src/content/storage.js',
  'src/content/url.js',
  'src/content/api.js',
  'src/content/tree.js',
  'src/content/sidebar.js',
  'src/content/main.js',
];
const CONTENT_CSS = ['src/content/page.css'];
const ENTERPRISE_SCRIPT_ID = 'hectatree-enterprise';

const cache = new Map(); // url -> { etag, data, link }
const CACHE_LIMIT = 150;

function apiBase(host) {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

async function getToken(host) {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  return tokens[host] || '';
}

async function apiRequest({ host, path }) {
  const url = apiBase(host) + path;
  const token = await getToken(host);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const cacheKey = `${token ? 'auth' : 'anon'}:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) headers['If-None-Match'] = cached.etag;

  const res = await fetch(url, { headers, cache: 'no-store' });
  const meta = {
    status: res.status,
    rateRemaining: res.headers.get('x-ratelimit-remaining'),
    rateLimit: res.headers.get('x-ratelimit-limit'),
    rateReset: res.headers.get('x-ratelimit-reset'),
    hasToken: Boolean(token),
  };

  if (res.status === 304 && cached) {
    // Conditional hits don't count against the rate limit.
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return { ok: true, ...meta, status: 200, data: cached.data, link: cached.link };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (rare); leave data null.
  }
  const link = res.headers.get('link');
  const etag = res.headers.get('etag');
  if (res.ok && etag) {
    cache.set(cacheKey, { etag, data, link });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return { ok: res.ok, ...meta, data, link };
}

// ---------- Sign in with GitHub (OAuth device flow) ----------
// The device flow needs no client secret and no redirect URL, so it is safe
// to ship in an extension. Only github.com is supported.

const OAUTH_CLIENT_ID = '';
const OAUTH_SCOPE = 'repo';

async function githubPost(path, body) {
  const res = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function authStart() {
  if (!OAUTH_CLIENT_ID) return { error: 'Sign-in is not configured in this build.' };
  const data = await githubPost('/login/device/code', { client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE });
  if (data.error) return { error: data.error_description || data.error };
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function authPoll({ deviceCode }) {
  const data = await githubPost('/login/oauth/access_token', {
    client_id: OAUTH_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (data.error === 'authorization_pending') return { status: 'pending' };
  if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval };
  if (data.error) return { status: 'error', error: data.error_description || data.error };

  const token = data.access_token;
  const user = await fetch('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const { tokens = {}, accounts = {} } = await chrome.storage.local.get(['tokens', 'accounts']);
  tokens['github.com'] = token;
  accounts['github.com'] = { login: user.login, avatar: user.avatar_url, method: 'oauth' };
  await chrome.storage.local.set({ tokens, accounts });
  return { status: 'ok', login: user.login };
}

async function authSignOut({ host }) {
  const { tokens = {}, accounts = {} } = await chrome.storage.local.get(['tokens', 'accounts']);
  delete tokens[host];
  delete accounts[host];
  await chrome.storage.local.set({ tokens, accounts });
  return { ok: true };
}

const handlers = {
  api: apiRequest,
  'auth:config': async () => ({ enabled: Boolean(OAUTH_CLIENT_ID) }),
  'auth:start': authStart,
  'auth:poll': authPoll,
  'auth:signout': authSignOut,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (handler) {
    handler(msg).then(sendResponse, (err) =>
      sendResponse({ ok: false, status: 0, error: String(err?.message || err) })
    );
    return true;
  }
  if (msg?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
  return false;
});

async function toggleInTab(tab) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    // Not a page HectaTree runs on.
    chrome.runtime.openOptionsPage();
  }
}

chrome.action.onClicked.addListener(toggleInTab);

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-sidebar') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleInTab(tab);
});

async function syncEnterpriseScripts() {
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  const matches = [];
  for (const host of enterpriseHosts) {
    const origin = `https://${host}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) matches.push(origin);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ENTERPRISE_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ENTERPRISE_SCRIPT_ID] });
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: ENTERPRISE_SCRIPT_ID,
      matches,
      js: CONTENT_JS,
      css: CONTENT_CSS,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(syncEnterpriseScripts);
chrome.runtime.onStartup.addListener(syncEnterpriseScripts);
chrome.permissions.onAdded.addListener(syncEnterpriseScripts);
chrome.permissions.onRemoved.addListener(syncEnterpriseScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enterpriseHosts) syncEnterpriseScripts();
  if (area === 'local' && changes.tokens) cache.clear();
});

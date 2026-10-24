// Hector background worker: proxies GitHub API calls (so tokens never touch
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
const ENTERPRISE_SCRIPT_ID = 'hector-enterprise';

const cache = new Map(); // url -> { etag, data, link }
const CACHE_LIMIT = 150;

function apiBase(host) {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

async function getToken(host) {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  return tokens[host] || '';
}

// github.com, or an Enterprise host the user added and granted.
async function knownHost(host) {
  if (host === 'github.com') return true;
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return false;
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  return enterpriseHosts.includes(host) && chrome.permissions.contains({ origins: [`https://${host}/*`] });
}

// The token is only ever sent to the API base of the host it belongs to.
function apiUrl(host, path) {
  const base = apiBase(host);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  const url = new URL(base + path);
  return url.origin === new URL(base).origin ? url.href : null;
}

const TEXT_LIMIT = 4 * 1024 * 1024; // job logs can be huge; keep the tail

async function apiRequest({ host, path, text = false }) {
  const url = apiUrl(host, path);
  if (!url || !(await knownHost(host))) return { ok: false, status: 0, error: 'Request blocked.' };
  const token = await getToken(host);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const cacheKey = `${token ? 'auth' : 'anon'}:${url}`;
  const cached = text ? null : cache.get(cacheKey);
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
  if (text && res.ok) {
    // Logs redirect to blob storage; fetch drops the token on that hop.
    data = await res.text();
    if (data.length > TEXT_LIMIT) data = `… earlier output omitted …\n${data.slice(-TEXT_LIMIT)}`;
    return { ok: true, ...meta, data };
  }
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

const OAUTH_CLIENT_ID = 'Ov23liWhB55h760SDgta';
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
  const res = await fetch('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { status: 'error', error: `GitHub returned ${res.status} for the new sign-in.` };
  const user = await res.json();
  const { tokens = {}, accounts = {} } = await chrome.storage.local.get(['tokens', 'accounts']);
  tokens['github.com'] = token;
  accounts['github.com'] = { login: user.login, avatar: user.avatar_url, method: 'oauth' };
  await chrome.storage.local.set({ tokens, accounts });
  return { status: 'ok', login: user.login };
}

// The sidebar can save or remove a token and ask whether one exists, but
// never reads it back.
async function tokenStatus({ host }) {
  return { hasToken: Boolean(await getToken(host)) };
}

async function tokenSet({ host, token }) {
  if (!(await knownHost(host))) return { ok: false, error: 'Unknown host.' };
  const { tokens = {}, accounts = {} } = await chrome.storage.local.get(['tokens', 'accounts']);
  if (token) tokens[host] = String(token).trim();
  else delete tokens[host];
  delete accounts[host]; // a manual token replaces any GitHub sign-in
  await chrome.storage.local.set({ tokens, accounts });
  return { ok: true };
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
  'token:status': tokenStatus,
  'token:set': tokenSet,
};

// Only Hector's own pages and content scripts; a content script may only act
// for the site it runs on.
function trusted(msg, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab || sender.url?.startsWith(chrome.runtime.getURL(''))) return true;
  try {
    return msg.host == null || new URL(sender.url).host === msg.host;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!trusted(msg, sender)) return false;
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
    // Not a page Hector runs on.
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

// Hector background worker: proxies GitHub and GitLab API calls (so tokens
// never touch the page), caches responses with ETags, and registers content
// scripts for self-hosted GitHub Enterprise / GitLab hosts the user granted.

const CONTENT_JS = [
  'src/content/util.js',
  'src/content/styles.js',
  'src/content/icons.js',
  'src/content/gitlab_icons.js',
  'src/content/storage.js',
  'src/content/url.js',
  'src/content/api.js',
  'src/content/github.js',
  'src/content/gitlab.js',
  'src/content/teamcity.js',
  'src/content/tree.js',
  'src/content/sidebar.js',
  'src/content/main.js',
];
const CONTENT_CSS = ['src/content/page.css'];
const ENTERPRISE_SCRIPT_ID = 'hector-enterprise';

const cache = new Map(); // url -> { etag, data, link }
const CACHE_LIMIT = 150;

// github.com and gitlab.com are fixed; a self-hosted server says which it
// runs (the content script detects it from the page).
function providerFor(host, provider) {
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  return provider === 'gitlab' ? 'gitlab' : 'github';
}

function apiBase(origin, provider) {
  if (origin === 'https://github.com') return 'https://api.github.com';
  return `${origin}/api/${provider === 'gitlab' ? 'v4' : 'v3'}`;
}

// Self-hosted entries are "host" (https) or "http://host".
const entryOrigin = (entry) => (entry.startsWith('http://') ? entry : `https://${entry}`);

async function getToken(host) {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  return tokens[host] || '';
}

// Where a host is served from: github.com, gitlab.com, or a self-hosted
// server the user added and granted. null for anything else.
async function siteOrigin(host) {
  if (host === 'github.com' || host === 'gitlab.com') return `https://${host}`;
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  const entry = enterpriseHosts.find((e) => e === host || e === `http://${host}`);
  if (!entry) return null;
  const origin = entryOrigin(entry);
  return (await chrome.permissions.contains({ origins: [`${origin}/*`] })) ? origin : null;
}

// The token is only ever sent to the API base of the host it belongs to.
function apiUrl(origin, provider, path) {
  const base = apiBase(origin, provider);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  const url = new URL(base + path);
  return url.origin === new URL(base).origin ? url.href : null;
}

const TEXT_LIMIT = 4 * 1024 * 1024; // job logs can be huge; keep the tail

// GitLab job logs for signed-out visitors of public projects come from the
// web page's raw log, since the API wants a token for them.
const GITLAB_RAW_LOG = /^\/[^?#]+\/-\/jobs\/\d+\/raw$/;

async function apiRequest({ host, provider, path, text = false, web = false }) {
  provider = providerFor(host, provider);
  const gitlab = provider === 'gitlab';
  const origin = await siteOrigin(host);
  const url =
    origin &&
    (web ? gitlab && typeof path === 'string' && GITLAB_RAW_LOG.test(path) && `${origin}${path}` : apiUrl(origin, provider, path));
  if (!url) return { ok: false, status: 0, error: 'Request blocked.' };
  const token = web ? '' : await getToken(host);
  const headers = gitlab
    ? { Accept: 'application/json' }
    : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Without a token, GitLab accepts the browser's signed-in session for GETs.
  const credentials = gitlab && !token ? 'include' : 'omit';

  const cacheKey = `${token ? 'auth' : credentials}:${url}`;
  const cached = text ? null : cache.get(cacheKey);
  if (cached) headers['If-None-Match'] = cached.etag;

  const res = await fetch(url, { headers, credentials, cache: 'no-store' });
  const header = (...names) => names.map((n) => res.headers.get(n)).find((v) => v != null) ?? null;
  const meta = {
    status: res.status,
    rateRemaining: header('x-ratelimit-remaining', 'ratelimit-remaining'),
    rateLimit: header('x-ratelimit-limit', 'ratelimit-limit'),
    rateReset: header('x-ratelimit-reset', 'ratelimit-reset'),
    total: header('x-total'),
    hasToken: Boolean(token),
  };

  if (res.status === 304 && cached) {
    // Conditional hits don't count against the rate limit.
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return { ok: true, ...meta, status: 200, data: cached.data, link: cached.link, total: cached.total };
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
    cache.set(cacheKey, { etag, data, link, total: meta.total });
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

// ---------- TeamCity ----------
// TeamCity is set up per repository (sync items "ci:<repo>"). Requests may
// only reach a server some repository uses and the user granted, and only
// TeamCity's REST API and build logs. Without a token the browser's
// TeamCity session is used; the content script falls back to guest access.

async function teamcityServerInUse(server) {
  const all = await chrome.storage.sync.get(null);
  return Object.entries(all).some(([key, conf]) => key.startsWith('ci:') && conf?.teamcity?.server === server);
}

function originOf(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

const TEAMCITY_PATH = /^\/(guestAuth\/)?(app\/rest\/[^?#]*|downloadBuildLog\.html)(\?[^#]*)?$/;

async function teamcityRequest({ server, path, text = false }) {
  if (typeof server !== 'string' || typeof path !== 'string' || !TEAMCITY_PATH.test(path) || !(await teamcityServerInUse(server))) {
    return { ok: false, status: 0, error: 'Request blocked.' };
  }
  if (!(await chrome.permissions.contains({ origins: [`${server}/*`] }))) {
    return { ok: false, status: 0, needsAccess: true, error: `Hector isn't allowed to reach ${new URL(server).host} yet.` };
  }
  const url = new URL(server + path);
  if (url.origin !== server) return { ok: false, status: 0, error: 'Request blocked.' };
  const token = path.startsWith('/guestAuth/') ? '' : await getToken(url.host);
  const headers = { Accept: text ? 'text/plain' : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const credentials = token ? 'omit' : 'include';

  const cacheKey = `tc:${token ? 'auth' : credentials}:${url.href}`;
  const cached = text ? null : cache.get(cacheKey);
  if (cached) headers['If-None-Match'] = cached.etag;
  const res = await fetch(url.href, { headers, credentials, cache: 'no-store' });
  const meta = { status: res.status, hasToken: Boolean(token) };
  if (res.status === 304 && cached) return { ok: true, ...meta, status: 200, data: cached.data };
  if (text && res.ok) {
    let data = await res.text();
    if (data.length > TEXT_LIMIT) data = `… earlier output omitted …\n${data.slice(-TEXT_LIMIT)}`;
    return { ok: true, ...meta, data };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // TeamCity answers errors in plain text.
  }
  if (!res.ok && !data) data = { message: `TeamCity returned ${res.status}` };
  const etag = res.headers.get('etag');
  if (res.ok && etag) {
    cache.set(cacheKey, { etag, data });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return { ok: res.ok, ...meta, data };
}

// The sidebar can save or remove a token and ask whether one exists, but
// never reads it back.
async function tokenStatus({ host }) {
  return { hasToken: Boolean(await getToken(host)) };
}

// A TeamCity token, set from a repository's CI settings.
async function teamcityToken({ server, token }) {
  if (!(await teamcityServerInUse(server))) return { ok: false, error: 'Set the server for this repository first.' };
  const host = new URL(server).host;
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  if (token) tokens[host] = String(token).trim();
  else delete tokens[host];
  await chrome.storage.local.set({ tokens });
  return { ok: true };
}

async function teamcityAccess({ server }) {
  const origin = originOf(server);
  return { granted: Boolean(origin) && (await chrome.permissions.contains({ origins: [`${origin}/*`] })) };
}

// Host permissions can only be requested from an extension page, so the
// sidebar opens a small window that asks.
async function requestAccess({ origin, why }) {
  origin = originOf(origin);
  if (!origin) return { ok: false };
  const url = chrome.runtime.getURL(`src/options/grant.html?origin=${encodeURIComponent(origin)}&why=${encodeURIComponent(String(why || ''))}`);
  await chrome.windows.create({ url, type: 'popup', width: 460, height: 300 });
  return { ok: true };
}

async function tokenSet({ host, token }) {
  if (!(await siteOrigin(host))) return { ok: false, error: 'Unknown host.' };
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
  tc: teamcityRequest,
  'tc:token': teamcityToken,
  'tc:access': teamcityAccess,
  'access:request': requestAccess,
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
    // Firefox rejects a message nobody answers, so always reply.
    chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err) }));
    return true;
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
  for (const entry of enterpriseHosts) {
    const origin = `${entryOrigin(entry)}/*`;
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

// Older builds kept TeamCity servers in one global list, with per-repo
// overrides; move what maps to a repository into its own settings.
async function migrateTeamCity() {
  const { teamcityServers, teamcityRepos } = await chrome.storage.sync.get(['teamcityServers', 'teamcityRepos']);
  if (!teamcityServers && !teamcityRepos) return;
  const only = teamcityServers?.length === 1 ? teamcityServers[0] : null;
  const items = {};
  for (const [repoKey, conf] of Object.entries(teamcityRepos || {})) {
    const server = conf.server || only;
    if (server && !conf.off) items[`ci:${repoKey}`] = { teamcity: { server, ...(conf.project ? { ids: conf.project } : {}) } };
  }
  if (Object.keys(items).length) await chrome.storage.sync.set(items);
  await chrome.storage.sync.remove(['teamcityServers', 'teamcityRepos']);
}

chrome.runtime.onInstalled.addListener(migrateTeamCity);
chrome.runtime.onStartup.addListener(migrateTeamCity);
chrome.runtime.onInstalled.addListener(syncEnterpriseScripts);
chrome.runtime.onStartup.addListener(syncEnterpriseScripts);
chrome.permissions.onAdded.addListener(syncEnterpriseScripts);
chrome.permissions.onRemoved.addListener(syncEnterpriseScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enterpriseHosts) syncEnterpriseScripts();
  if (area === 'local' && changes.tokens) cache.clear();
});

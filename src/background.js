// Hector background worker: proxies GitHub and GitLab API calls (so tokens
// never touch the page), caches responses with ETags, and registers content
// scripts for self-hosted GitHub Enterprise / GitLab hosts the user granted.

const CONTENT_JS = [
  'src/content/util.js',
  'src/content/debug.js',
  'src/content/styles.js',
  'src/content/icons.js',
  'src/content/gitlab_icons.js',
  'src/content/storage.js',
  'src/content/url.js',
  'src/content/api.js',
  'src/content/fastsearch.js',
  'src/content/github.js',
  'src/content/gitlab.js',
  'src/content/bitbucket.js',
  'src/content/bitbucket_server.js',
  'src/content/ci.js',
  'src/content/teamcity.js',
  'src/content/jenkins.js',
  'src/content/customci.js',
  'src/content/tree.js',
  'src/content/sidebar.js',
  'src/content/main.js',
];
const CONTENT_CSS = ['src/content/page.css'];
const ENTERPRISE_SCRIPT_ID = 'hector-enterprise';
const DETECT_SCRIPT_ID = 'hector-detect';
const ANY_SITE = ['https://*/*', 'http://*/*'];
const KIND_NAMES = { github: 'GitHub Enterprise', gitlab: 'GitLab', 'bitbucket-server': 'Bitbucket Server' };

// ETag cache, least recently used first out. Bounded by bytes, not entries: a
// 20k-entry tree is a couple of MB on its own.
const cache = new Map(); // key -> { etag, data, link, total, size }
const CACHE_LIMIT = 150;
const CACHE_BYTES = 24 * 1024 * 1024;
let cacheBytes = 0;

function cacheGet(key) {
  const entry = cache.get(key);
  if (entry) {
    // Refresh its place in the order.
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

function cachePut(key, entry) {
  const old = cache.get(key);
  if (old) {
    cacheBytes -= old.size;
    cache.delete(key);
  }
  cache.set(key, entry);
  cacheBytes += entry.size;
  for (const [k, e] of cache) {
    if (cache.size <= CACHE_LIMIT && cacheBytes <= CACHE_BYTES) break;
    cache.delete(k);
    cacheBytes -= e.size;
  }
}

function cacheClear() {
  cache.clear();
  cacheBytes = 0;
}

// github.com and gitlab.com are fixed; a self-hosted server says which it
// runs (the content script detects it from the page).
function providerFor(host, provider) {
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === 'bitbucket.org') return 'bitbucket';
  if (provider === 'bitbucket-server') return provider;
  return provider === 'gitlab' ? 'gitlab' : 'github';
}

function apiBase(origin, provider) {
  if (origin === 'https://github.com') return 'https://api.github.com';
  if (origin === 'https://bitbucket.org') return 'https://api.bitbucket.org/2.0';
  // Bitbucket Server's paths carry its context path and /rest/ themselves.
  if (provider === 'bitbucket-server') return origin;
  return `${origin}/api/${provider === 'gitlab' ? 'v4' : 'v3'}`;
}

// Self-hosted entries are "host" (https) or "http://host".
const entryOrigin = (entry) => (entry.startsWith('http://') ? entry : `https://${entry}`);

// Tokens live in storage.local under the host they belong to; CI servers'
// (TeamCity, Jenkins, …) under "ci:" + host, so a CI token is never sent to
// a GitLab or GitHub Enterprise server that happens to share the host (or
// vice versa).
const ciKey = (host) => `ci:${host}`;

// "user:secret" for HTTP Basic, UTF-8 encoded (btoa alone throws past Latin-1).
const basicAuth = (token) => btoa(String.fromCharCode(...new TextEncoder().encode(token)));

async function getToken(key) {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  return tokens[key] || '';
}

// Where a host is served from: github.com, gitlab.com, or a self-hosted
// server the user added and granted. null for anything else.
async function siteOrigin(host) {
  if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') return `https://${host}`;
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  const entry = enterpriseHosts.find((e) => e === host || e === `http://${host}`);
  if (!entry) return null;
  const origin = entryOrigin(entry);
  return (await chrome.permissions.contains({ origins: [`${origin}/*`] })) ? origin : null;
}

// The token is only ever sent to the API base of the host it belongs to.
// Bitbucket Server: its REST APIs (core and build status) and the whoami
// servlet, under any context path. No "." or ".." segments.
const BBS_PATH = /^(\/[\w.~%-]+)*\/(rest\/(api|build-status)\/1\.0\/[^#]*|plugins\/servlet\/applinks\/whoami)$/;
const dotSegment = (path) => path.split(/[?#]/)[0].split('/').some((seg) => /^(\.|%2e){1,2}$/i.test(seg));

function apiUrl(origin, provider, path) {
  const base = apiBase(origin, provider);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  if (provider === 'bitbucket-server' && (dotSegment(path) || !BBS_PATH.test(path))) return null;
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
  const bitbucket = provider === 'bitbucket';
  const bbs = provider === 'bitbucket-server';
  const origin = await siteOrigin(host);
  const url =
    origin &&
    (web ? gitlab && typeof path === 'string' && GITLAB_RAW_LOG.test(path) && `${origin}${path}` : apiUrl(origin, provider, path));
  if (!url) return { ok: false, status: 0, error: 'Request blocked.' };
  const token = web ? '' : await getToken(host);
  // Plain-text endpoints (logs, raw files) are refused by Bitbucket with a JSON-only Accept.
  const headers = text
    ? { Accept: 'text/plain, */*' }
    : gitlab || bitbucket || bbs
      ? { Accept: 'application/json' }
      : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  // Bitbucket's API tokens and app passwords go with the account name, as HTTP Basic.
  if (token) headers.Authorization = (bitbucket || bbs) && token.includes(':') ? `Basic ${basicAuth(token)}` : `Bearer ${token}`;
  // Without a token, GitLab and Bitbucket accept the browser's signed-in session for GETs.
  const credentials = (gitlab || bitbucket || bbs) && !token ? 'include' : 'omit';

  const cacheKey = `${token ? 'auth' : credentials}:${url}`;
  const cached = text ? null : cacheGet(cacheKey);
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
    return { ok: true, ...meta, status: 200, data: cached.data, link: cached.link, total: cached.total };
  }

  let data = null;
  // Logs redirect to blob storage; fetch drops the token on that hop.
  const body = await res.text();
  if (text && res.ok) {
    data = body.length > TEXT_LIMIT ? `… earlier output omitted …\n${body.slice(-TEXT_LIMIT)}` : body;
    return { ok: true, ...meta, data };
  }
  try {
    data = JSON.parse(body);
  } catch {
    // Non-JSON body (rare); leave data null.
  }
  const link = res.headers.get('link');
  const etag = res.headers.get('etag');
  // Huge listings (a recursive tree of a big repository is tens of MB of objects)
  // aren't worth keeping in memory for a 304 later.
  const huge = Array.isArray(data?.tree) && data.tree.length > 20000;
  if (res.ok && etag && !huge) cachePut(cacheKey, { etag, data, link, total: meta.total, size: body.length });
  return { ok: res.ok, ...meta, data, link };
}

// ---------- Sign in with GitHub (OAuth device flow) ----------
// The device flow needs no client secret and no redirect URL, so it is safe
// to ship in an extension. Only github.com is supported.

const OAUTH_CLIENT_ID = 'Ov23liWhB55h760SDgta';
const OAUTH_SCOPE = 'repo';

// No cookies: the device flow doesn't need the GitHub session. A request the
// browser refuses outright (Firefox: "NetworkError") means Hector isn't
// allowed to reach github.com, so say that.
async function githubPost(path, body) {
  let res;
  try {
    res = await fetch(`https://github.com${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
  } catch {
    const allowed = await chrome.permissions.contains({ origins: ['https://github.com/*'] }).catch(() => false);
    return {
      error: 'unreachable',
      needsAccess: !allowed,
      error_description: allowed
        ? "Couldn't reach github.com (offline, or blocked by a privacy setting or another add-on). Try again, or use a personal access token."
        : "Hector isn't allowed to reach github.com. Turn on its access to github.com in your browser's add-on settings (Permissions), or use a personal access token.",
    };
  }
  return res.json();
}

async function authStart() {
  if (!OAUTH_CLIENT_ID) return { error: 'Sign-in is not configured in this build.' };
  const data = await githubPost('/login/device/code', { client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE });
  if (data.error) return { error: data.error_description || data.error, needsAccess: Boolean(data.needsAccess) };
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

// ---------- External CI servers (TeamCity, Jenkins, custom) ----------
// Set up per repository (sync items "ci:<repo>", each with a list of
// sources). A request may only reach a server some repository lists and the
// user granted, and only on the paths of that CI's API (or, for a custom
// endpoint, the server the address names). Without a token the browser's
// session on that server is used.

function originOf(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

// The sources of one repository's settings (older settings: one TeamCity).
function ciSourcesOf(conf) {
  if (Array.isArray(conf?.sources)) return conf.sources;
  return conf?.teamcity?.server ? [{ type: 'teamcity', ...conf.teamcity }] : [];
}

async function ciServerInUse(kind, server) {
  const all = await chrome.storage.sync.get(null);
  return Object.entries(all).some(
    ([key, conf]) => key.startsWith('ci:') && ciSourcesOf(conf).some((s) => s?.type === kind && typeof s.server === 'string' && originOf(s.server) === server)
  );
}

const CI_PATHS = {
  teamcity: /^\/(guestAuth\/)?(app\/rest\/[^?#]*|downloadBuildLog\.html)(\?[^#]*)?$/,
  jenkins: /^(\/job\/[^/?#]+)*\/(api\/json|me\/api\/json|\d+\/(consoleText|api\/json|wfapi\/describe))(\?[^#]*)?$/,
  custom: /^\/[^#]*$/,
};

async function ciRequest({ ci: kind, server, path, text = false }) {
  const allowed = typeof kind === 'string' && CI_PATHS[kind];
  if (!allowed || typeof server !== 'string' || typeof path !== 'string' || !allowed.test(path) || originOf(server) !== server || !(await ciServerInUse(kind, server))) {
    return { ok: false, status: 0, error: 'Request blocked.' };
  }
  if (!(await chrome.permissions.contains({ origins: [`${server}/*`] }))) {
    return { ok: false, status: 0, needsAccess: true, error: `Hector isn't allowed to reach ${new URL(server).host} yet.` };
  }
  // The browser resolves "." and ".." (also as %2e) before sending, so check
  // the path it will actually request, and refuse dot segments outright.
  const url = new URL(server + path);
  if (dotSegment(path) || url.origin.toLowerCase() !== server || !allowed.test(url.pathname + url.search)) {
    return { ok: false, status: 0, error: 'Request blocked.' };
  }
  const token = path.startsWith('/guestAuth/') ? '' : await getToken(ciKey(url.host));
  const headers = { Accept: text ? 'text/plain' : 'application/json' };
  // Jenkins API tokens go with the user name, as HTTP Basic.
  if (token) headers.Authorization = kind === 'jenkins' && token.includes(':') ? `Basic ${basicAuth(token)}` : `Bearer ${token}`;
  const credentials = token ? 'omit' : 'include';

  const cacheKey = `ci:${token ? 'auth' : credentials}:${url.href}`;
  const cached = text ? null : cacheGet(cacheKey);
  if (cached) headers['If-None-Match'] = cached.etag;
  const res = await fetch(url.href, { headers, credentials, cache: 'no-store' });
  const meta = { status: res.status, hasToken: Boolean(token) };
  if (res.status === 304 && cached) return { ok: true, ...meta, status: 200, data: cached.data };
  const body = await res.text();
  if (text && res.ok) {
    return { ok: true, ...meta, data: body.length > TEXT_LIMIT ? `… earlier output omitted …\n${body.slice(-TEXT_LIMIT)}` : body };
  }
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    // TeamCity answers errors in plain text.
  }
  if (!res.ok && !data) data = { message: `${new URL(server).host} returned ${res.status}` };
  const etag = res.headers.get('etag');
  if (res.ok && etag) cachePut(cacheKey, { etag, data, size: body.length });
  return { ok: res.ok, ...meta, data };
}

// The sidebar can save or remove a token and ask whether one exists, but
// never reads it back.
async function tokenStatus({ host }) {
  return { hasToken: Boolean(await getToken(host)) };
}

// A CI server's token, set from a repository's CI settings.
async function ciToken({ server, token }) {
  const origin = originOf(server);
  const all = await chrome.storage.sync.get(null);
  const inUse = Object.entries(all).some(([key, conf]) => key.startsWith('ci:') && ciSourcesOf(conf).some((s) => typeof s?.server === 'string' && originOf(s.server) === origin));
  if (!origin || !inUse) return { ok: false, error: 'Save the server for this repository first.' };
  const key = ciKey(new URL(origin).host);
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  if (token) tokens[key] = String(token).trim();
  else delete tokens[key];
  await chrome.storage.local.set({ tokens });
  return { ok: true };
}

// Whether a CI server may be reached, and whether a token is saved for it.
async function ciAccess({ server }) {
  const origin = originOf(server);
  if (!origin) return { granted: false, hasToken: false };
  return {
    granted: await chrome.permissions.contains({ origins: [`${origin}/*`] }),
    hasToken: Boolean(await getToken(ciKey(new URL(origin).host))),
  };
}

// Older builds kept TeamCity tokens under the bare host, like site tokens.
// Move the ones that belong to a CI server (and to no site) to "ci:".
async function migrateCITokens() {
  const { tokens } = await chrome.storage.local.get('tokens');
  if (!tokens) return;
  const sync = await chrome.storage.sync.get(null);
  const sites = new Set(['github.com', 'gitlab.com', ...(sync.enterpriseHosts || []).map((e) => e.replace(/^http:\/\//, ''))]);
  let changed = false;
  for (const [key, conf] of Object.entries(sync)) {
    if (!key.startsWith('ci:')) continue;
    for (const s of ciSourcesOf(conf)) {
      const origin = typeof s?.server === 'string' && originOf(s.server);
      const host = origin && new URL(origin).host;
      if (!host || tokens[ciKey(host)]) continue;
      // A build between those two schemes briefly used "tc:" + host.
      const old = tokens[`tc:${host}`] ? `tc:${host}` : tokens[host] && !sites.has(host) ? host : null;
      if (old) {
        tokens[ciKey(host)] = tokens[old];
        delete tokens[old];
        changed = true;
      }
    }
  }
  if (changed) await chrome.storage.local.set({ tokens });
}

// Firefox may install Hector (a temporary add-on: on every reload) without
// its own sites. Then one small window asks for all of them at once.
const SITES = () => chrome.runtime.getManifest().host_permissions || [];
async function sitesAllowed() {
  return chrome.permissions.contains({ origins: SITES() }).catch(() => true);
}
async function askForSites() {
  if (await sitesAllowed()) return { ok: true, granted: true };
  await chrome.windows.create({ url: chrome.runtime.getURL('src/options/grant.html?sites=1'), type: 'popup', width: 460, height: 320 });
  return { ok: true, granted: false };
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

// File search in WebAssembly (wasm/, Rust). It runs here, not in the page: a
// page's CSP can forbid WebAssembly, and the search stays off the page's
// main thread. One index per tab; the worker may be stopped at any time, in
// which case the page is told to send its paths again.
let wasm = null;
const wasmIndexes = new Map(); // tab id -> index handle

async function wasmModule() {
  if (!wasm) {
    const bytes = await (await fetch(chrome.runtime.getURL('src/wasm/hector_core.wasm'))).arrayBuffer();
    wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  }
  return wasm;
}

// Copy text into the module's memory for the duration of `fn(ptr, len)`.
function wasmWith(w, text, fn) {
  const bytes = new TextEncoder().encode(text);
  const ptr = w.alloc(bytes.length);
  try {
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
    return fn(ptr, bytes.length);
  } finally {
    w.dealloc(ptr, bytes.length);
  }
}

function wasmDrop(tab) {
  if (wasm && wasmIndexes.has(tab)) wasm.free(wasmIndexes.get(tab));
  wasmIndexes.delete(tab);
}

async function wasmIndex({ paths }, sender) {
  if (typeof paths !== 'string' || sender.tab?.id == null) return { ok: false, error: 'Request blocked.' };
  const w = await wasmModule();
  wasmDrop(sender.tab.id);
  wasmIndexes.set(sender.tab.id, wasmWith(w, paths, (ptr, len) => w.load(ptr, len)));
  return { ok: true };
}

// { ok, total, results: [{ i (path number), indices }] }, best match first.
async function wasmSearch({ query, limit }, sender) {
  const handle = wasmIndexes.get(sender.tab?.id);
  if (!handle || wasm == null) return { ok: false, needIndex: true };
  const w = wasm;
  const words = wasmWith(w, String(query), (ptr, len) => w.search(handle, ptr, len, Math.min(Number(limit) || 300, 1000)));
  const out = new Uint32Array(w.memory.buffer, w.out_ptr(), words);
  const results = [];
  for (let o = 2, r = 0; r < out[1]; r++) {
    const n = out[o + 1];
    results.push({ i: out[o], indices: Array.from(out.subarray(o + 2, o + 2 + n)) });
    o += 2 + n;
  }
  return { ok: true, total: out[0], results };
}

chrome.tabs.onRemoved.addListener((tab) => wasmDrop(tab));

const handlers = {
  api: apiRequest,
  'wasm:index': wasmIndex,
  'wasm:search': wasmSearch,
  'auth:config': async () => ({ enabled: Boolean(OAUTH_CLIENT_ID) }),
  'auth:start': authStart,
  'auth:poll': authPoll,
  'auth:signout': authSignOut,
  'token:status': tokenStatus,
  'token:set': tokenSet,
  ci: ciRequest,
  'ci:token': ciToken,
  'ci:access': ciAccess,
  'access:request': requestAccess,
  'access:sites': askForSites,
  'site:add': addSite,
  'site:found': siteFound,
  'debug:log': debugInfo,
};

// Only Hector's own pages and content scripts; a content script may only act
// for the site it runs on, and only a github.com page may drive GitHub sign-in.
function trusted(msg, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab || sender.url?.startsWith(chrome.runtime.getURL(''))) return true;
  try {
    const host = new URL(sender.url).host;
    if ((msg?.type === 'auth:start' || msg?.type === 'auth:poll') && host !== 'github.com') return false;
    return msg.host == null || host === msg.host;
  } catch {
    return false;
  }
}

// The last requests, for "Report a problem": path, status and timing only
// (no headers, tokens or bodies). Kept in memory; gone when the worker sleeps.
const debugLog = [];
function logRequest(msg, sender, res, started) {
  let site = '';
  try {
    site = new URL(sender.url).host;
  } catch {}
  debugLog.push({
    at: started,
    site,
    via: msg.type === 'ci' ? `ci:${msg.ci}` : msg.web ? 'web' : msg.text ? 'text' : 'api',
    server: msg.type === 'ci' ? originOf(msg.server) : '',
    path: String(msg.path || '').slice(0, 300),
    status: res?.status ?? null,
    ms: Date.now() - started,
    error: res?.ok ? '' : String(res?.error || (res?.needsAccess ? 'needs access' : '')).slice(0, 120),
  });
  if (debugLog.length > 60) debugLog.shift();
}

// A content script gets the requests made from its own site only.
async function debugInfo(msg, sender) {
  let site = '';
  try {
    site = new URL(sender.url).host;
  } catch {}
  const origin = await siteOrigin(site);
  const { autoDetect = false } = await chrome.storage.sync.get('autoDetect');
  return {
    requests: debugLog.filter((r) => r.site === site).slice(-30),
    granted: origin ? await chrome.permissions.contains({ origins: [`${origin}/*`] }) : false,
    autoDetect,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!trusted(msg, sender)) return false;
  const handler = handlers[msg?.type];
  if (handler) {
    const started = Date.now();
    const logged = msg.type === 'api' || msg.type === 'ci';
    handler(msg, sender).then(
      (res) => {
        if (logged) logRequest(msg, sender, res, started);
        sendResponse(res);
      },
      (err) => {
        const res = { ok: false, status: 0, error: String(err?.message || err) };
        if (logged) logRequest(msg, sender, res, started);
        sendResponse(res);
      }
    );
    return true;
  }
  if (msg?.type === 'openOptions') {
    // Firefox rejects a message nobody answers, so always reply.
    const opened =
      msg.section === 'backup'
        ? chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#backup') })
        : chrome.runtime.openOptionsPage();
    opened.then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  return false;
});

async function toggleInTab(tab) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    // Not a page Hector runs on (yet): look at the page (the click grants
    // that for this tab) and offer to start Hector if it's a code host.
    if (!(await offerSite(tab))) chrome.runtime.openOptionsPage();
  }
}

async function offerSite(tab) {
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/detect.js'] }).catch(() => []);
  const kind = result?.result;
  if (!KIND_NAMES[kind]) return false;
  const why = `This page looks like ${KIND_NAMES[kind]}. Allow Hector to run on it, to show the sidebar here.`;
  const page = chrome.runtime.getURL(`src/options/grant.html?origin=${encodeURIComponent(url.origin)}&why=${encodeURIComponent(why)}&site=1&tab=${tab.id}`);
  await chrome.windows.create({ url: page, type: 'popup', width: 460, height: 300 });
  return true;
}

// Adds a host to the self-hosted list (once Hector may run there) and starts
// Hector in the tab without a reload.
async function addSite({ origin, tabId }, sender) {
  // From Hector's own pages (the access popup), or siteFound below.
  if (sender && sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return { ok: false };
  origin = originOf(origin);
  if (!origin || !(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return { ok: false };
  const { host, protocol } = new URL(origin);
  if (['github.com', 'gitlab.com', 'bitbucket.org'].includes(host)) return { ok: false };
  const entry = protocol === 'http:' ? `http://${host}` : host;
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  if (!enterpriseHosts.includes(entry)) {
    await chrome.storage.sync.set({ enterpriseHosts: [...enterpriseHosts.filter((e) => e.replace(/^http:\/\//, '') !== host), entry] });
  }
  await syncEnterpriseScripts();
  if (Number.isInteger(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url && new URL(tab.url).origin === origin) {
      await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS }).catch(() => {});
    }
  }
  return { ok: true };
}

// "Find servers on any site": detect.js reported a code host. Only acted on
// when the user granted Hector every site; the origin is the tab's own.
async function siteFound(msg, sender) {
  if (!sender.tab?.id || !sender.url) return { ok: false };
  const { autoDetect } = await chrome.storage.sync.get('autoDetect');
  if (!autoDetect || !KIND_NAMES[msg.kind]) return { ok: false };
  return addSite({ origin: new URL(sender.url).origin, tabId: sender.tab.id }, null);
}

// The every-site detector runs only while the user wants it and allowed it.
async function syncDetectScript() {
  const { autoDetect } = await chrome.storage.sync.get('autoDetect');
  const allowed = await chrome.permissions.contains({ origins: ANY_SITE });
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DETECT_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [DETECT_SCRIPT_ID] });
  if (!autoDetect || !allowed) return;
  await chrome.scripting.registerContentScripts([
    {
      id: DETECT_SCRIPT_ID,
      matches: ANY_SITE,
      excludeMatches: ['https://github.com/*', 'https://gitlab.com/*', 'https://bitbucket.org/*'],
      js: ['src/content/detect.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
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

const migrate = () => migrateTeamCity().then(migrateCITokens);
chrome.runtime.onInstalled.addListener(migrate);
chrome.runtime.onStartup.addListener(migrate);
chrome.runtime.onInstalled.addListener(syncEnterpriseScripts);
chrome.runtime.onStartup.addListener(syncEnterpriseScripts);
chrome.permissions.onAdded.addListener(syncEnterpriseScripts);
chrome.permissions.onRemoved.addListener(syncEnterpriseScripts);
chrome.runtime.onInstalled.addListener(() => askForSites());
chrome.runtime.onInstalled.addListener(syncDetectScript);
chrome.runtime.onStartup.addListener(syncDetectScript);
chrome.permissions.onAdded.addListener(syncDetectScript);
chrome.permissions.onRemoved.addListener(syncDetectScript);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enterpriseHosts) syncEnterpriseScripts();
  if (area === 'sync' && changes.autoDetect) syncDetectScript();
  if (area === 'local' && changes.tokens) cacheClear();
});

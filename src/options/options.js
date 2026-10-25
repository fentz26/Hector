const DEFAULTS = HT.DEFAULTS;

const $ = (sel) => document.querySelector(sel);

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

// Self-hosted entries are "host" (https) or "http://host"; tokens are keyed
// by host.
const entryOrigin = (entry) => (entry.startsWith('http://') ? entry : `https://${entry}`);
const entryHost = (entry) => entry.replace(/^http:\/\//, '');

async function originOf(host) {
  if (host === 'github.com' || host === 'gitlab.com') return `https://${host}`;
  const { enterpriseHosts = [], teamcityServers = [] } = await chrome.storage.sync.get(['enterpriseHosts', 'teamcityServers']);
  const tc = teamcityServers.find((o) => new URL(o).host === host);
  if (tc) return tc;
  return entryOrigin(enterpriseHosts.find((e) => entryHost(e) === host) || host);
}

// github.com and gitlab.com are known; ask a self-hosted server whether it
// has GitLab's API (it answers JSON, even when signed out).
const kinds = new Map([['github.com', 'github'], ['gitlab.com', 'gitlab']]);
async function providerOf(host) {
  const { teamcityServers = [] } = await chrome.storage.sync.get('teamcityServers');
  if (teamcityServers.some((o) => new URL(o).host === host)) return 'teamcity';
  if (!kinds.has(host)) {
    const kind = await fetch(`${await originOf(host)}/api/v4/version`, { credentials: 'omit' })
      .then((r) => (/json/.test(r.headers.get('content-type') || '') ? 'gitlab' : 'github'))
      .catch(() => 'github');
    kinds.set(host, kind);
  }
  return kinds.get(host);
}

function apiBase(origin, kind) {
  if (origin === 'https://github.com') return 'https://api.github.com';
  if (kind === 'teamcity') return `${origin}/app/rest`;
  return `${origin}/api/${kind === 'gitlab' ? 'v4' : 'v3'}`;
}

const TOKEN_LINKS = {
  github: (origin) => `${origin}/settings/tokens/new?scopes=repo&description=Hector`,
  gitlab: (origin) => `${origin}/-/user_settings/personal_access_tokens?name=Hector&scopes=read_api`,
  teamcity: (origin) => `${origin}/profile.html?item=accessTokens`,
};

// ---------- settings ----------

async function initSettings() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  for (const el of document.querySelectorAll('[data-setting]')) {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
    else el.value = settings[key];
    el.addEventListener('change', () => {
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') {
        const min = Number(el.min);
        const max = Number(el.max);
        value = Math.min(max, Math.max(min, Number(value) || DEFAULTS[key]));
        el.value = value;
      }
      chrome.storage.sync.set({ [key]: value });
    });
  }
}

// ---------- tokens ----------

async function hosts() {
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  const { teamcityServers = [] } = await chrome.storage.sync.get('teamcityServers');
  return ['github.com', 'gitlab.com', ...enterpriseHosts.map(entryHost), ...teamcityServers.map((o) => new URL(o).host)];
}

async function tokens() {
  const { tokens = {} } = await chrome.storage.local.get('tokens');
  return tokens;
}

async function renderTokenHosts() {
  const select = $('#token-host');
  const current = select.value || 'github.com';
  select.replaceChildren(...(await hosts()).map((h) => new Option(h, h)));
  select.value = (await hosts()).includes(current) ? current : 'github.com';
  await loadToken();
}

async function loadToken() {
  const host = $('#token-host').value;
  $('#token').value = (await tokens())[host] || '';
  setStatus($('#token-status'), '');
  const kind = await providerOf(host);
  if ($('#token-host').value !== host) return;
  const origin = await originOf(host);
  $('#token-create').href = TOKEN_LINKS[kind](origin);
  setStatus($('#token-status'), origin.startsWith('http:') ? 'This server uses plain http: a token would travel unencrypted.' : '');
  $('#token').placeholder = { gitlab: 'glpat-…', teamcity: 'TeamCity access token', github: 'github_pat_… or ghp_…' }[kind];
}

async function saveToken() {
  const host = $('#token-host').value;
  const value = $('#token').value.trim();
  const all = await tokens();
  if (value) all[host] = value;
  else delete all[host];
  await chrome.storage.local.set({ tokens: all });
  setStatus($('#token-status'), value ? 'Token saved.' : 'Token removed.', 'ok');
  if (value) testToken();
}

async function testToken() {
  const host = $('#token-host').value;
  const value = $('#token').value.trim();
  const status = $('#token-status');
  if (!value) {
    setStatus(status, 'Enter a token first.', 'err');
    return;
  }
  setStatus(status, 'Testing…');
  try {
    const kind = await providerOf(host);
    const res = await fetch(`${apiBase(await originOf(host), kind)}/${kind === 'teamcity' ? 'users/current' : 'user'}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${value}` },
      credentials: 'omit',
    });
    if (!res.ok) {
      setStatus(status, res.status === 401 ? 'GitHub rejected this token (401).' : `GitHub returned ${res.status}.`, 'err');
      return;
    }
    const user = await res.json();
    setStatus(status, `Works — signed in as ${user.login || user.username}.`, 'ok');
  } catch (err) {
    setStatus(status, `Could not reach ${host}: ${err.message}`, 'err');
  }
}

// ---------- enterprise ----------

// "git.example.com", "https://git.example.com/group" → "git.example.com";
// "http://git.local:8080" → "http://git.local:8080" (plain http is kept).
function normalizeHost(input) {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.host.toLowerCase();
    return url.protocol === 'http:' ? `http://${host}` : host;
  } catch {
    return null;
  }
}

async function renderEnterprise() {
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  const list = $('#ghe-list');
  list.replaceChildren();
  for (const host of enterpriseHosts) {
    const granted = await chrome.permissions.contains({ origins: [`${entryOrigin(host)}/*`] });
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.textContent = host;
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = `${granted ? 'Active' : 'Permission not granted'}${host.startsWith('http://') ? ' · plain http, not encrypted' : ''}`;
    name.append(note);
    const actions = document.createElement('div');
    actions.className = 'row';
    if (!granted) {
      const grant = document.createElement('button');
      grant.className = 'secondary';
      grant.textContent = 'Grant access';
      grant.onclick = () => requestHost(host);
      actions.append(grant);
    }
    const remove = document.createElement('button');
    remove.className = 'secondary danger';
    remove.textContent = 'Remove';
    remove.onclick = () => removeHost(host);
    actions.append(remove);
    li.append(name, actions);
    list.append(li);
  }
}

async function requestHost(host) {
  // Must run inside the click handler's user gesture.
  return chrome.permissions.request({ origins: [`${entryOrigin(host)}/*`] });
}

async function addHost() {
  const host = normalizeHost($('#ghe-host').value);
  if (!host || ['github.com', 'gitlab.com'].includes(entryHost(host))) return;
  const granted = await requestHost(host);
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  // One entry per host: switching between http and https replaces it.
  const others = enterpriseHosts.filter((e) => entryHost(e) !== entryHost(host));
  enterpriseHosts.splice(0, enterpriseHosts.length, ...others, host);
  await chrome.storage.sync.set({ enterpriseHosts });
  $('#ghe-host').value = '';
  if (!granted) alert(`Hector can't run on ${host} until you grant access.`);
  await renderEnterprise();
  await renderTokenHosts();
}

async function removeHost(host) {
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  await chrome.storage.sync.set({ enterpriseHosts: enterpriseHosts.filter((h) => h !== host) });
  await chrome.permissions.remove({ origins: [`${entryOrigin(host)}/*`] }).catch(() => {});
  const all = await tokens();
  delete all[entryHost(host)];
  await chrome.storage.local.set({ tokens: all });
  await renderEnterprise();
  await renderTokenHosts();
}

// ---------- TeamCity ----------

async function renderTeamCity() {
  const { teamcityServers = [] } = await chrome.storage.sync.get('teamcityServers');
  const list = $('#tc-list');
  list.replaceChildren();
  for (const origin of teamcityServers) {
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.textContent = origin;
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = `${granted ? 'Active' : 'Permission not granted'}${origin.startsWith('http:') ? ' · plain http, not encrypted' : ''}`;
    name.append(note);
    const actions = document.createElement('div');
    actions.className = 'row';
    if (!granted) {
      const grant = document.createElement('button');
      grant.className = 'secondary';
      grant.textContent = 'Grant access';
      grant.onclick = () => chrome.permissions.request({ origins: [`${origin}/*`] }).then(renderTeamCity);
      actions.append(grant);
    }
    const remove = document.createElement('button');
    remove.className = 'secondary danger';
    remove.textContent = 'Remove';
    remove.onclick = () => removeTeamCity(origin);
    actions.append(remove);
    li.append(name, actions);
    list.append(li);
  }
}

async function addTeamCity() {
  let origin;
  try {
    const raw = $('#tc-host').value.trim();
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    origin = url.origin.toLowerCase();
  } catch {
    return;
  }
  // Must run inside the click handler's user gesture.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  const { teamcityServers = [] } = await chrome.storage.sync.get('teamcityServers');
  if (!teamcityServers.includes(origin)) teamcityServers.push(origin);
  await chrome.storage.sync.set({ teamcityServers });
  $('#tc-host').value = '';
  if (!granted) alert(`Hector can't read builds from ${origin} until you grant access.`);
  await renderTeamCity();
  await renderTokenHosts();
}

async function removeTeamCity(origin) {
  const { teamcityServers = [] } = await chrome.storage.sync.get('teamcityServers');
  await chrome.storage.sync.set({ teamcityServers: teamcityServers.filter((o) => o !== origin) });
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {});
  const all = await tokens();
  delete all[new URL(origin).host];
  await chrome.storage.local.set({ tokens: all });
  await renderTeamCity();
  await renderTokenHosts();
}

// ---------- bookmarks ----------

async function renderBookmarkCount() {
  const { bookmarks = [] } = await chrome.storage.local.get('bookmarks');
  $('#bm-count').textContent = bookmarks.length;
}

async function exportBookmarks() {
  const { bookmarks = [] } = await chrome.storage.local.get('bookmarks');
  const blob = new Blob([JSON.stringify({ app: 'hector', version: 1, bookmarks }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hector-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBookmarks(file) {
  const status = $('#bm-status');
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.bookmarks;
    if (!Array.isArray(incoming)) throw new Error('No bookmarks found in file.');
    const valid = HT.cleanBookmarks(incoming);
    const { bookmarks = [] } = await chrome.storage.local.get('bookmarks');
    const known = new Set(bookmarks.map((b) => b.url));
    const added = valid.filter((b) => !known.has(b.url));
    await chrome.storage.local.set({ bookmarks: [...bookmarks, ...added] });
    setStatus(status, `Imported ${added.length} new bookmark${added.length === 1 ? '' : 's'}.`, 'ok');
  } catch (err) {
    setStatus(status, `Import failed: ${err.message}`, 'err');
  }
  renderBookmarkCount();
}

async function clearBookmarks() {
  if (!confirm('Delete all Hector bookmarks? This cannot be undone.')) return;
  await chrome.storage.local.set({ bookmarks: [] });
  setStatus($('#bm-status'), 'All bookmarks deleted.', 'ok');
  renderBookmarkCount();
}

// ---------- wire up ----------

$('#token-host').addEventListener('change', loadToken);
$('#token-save').addEventListener('click', saveToken);
$('#token-test').addEventListener('click', testToken);
$('#token-clear').addEventListener('click', () => {
  $('#token').value = '';
  saveToken();
});
$('#token-toggle').addEventListener('click', (e) => {
  const input = $('#token');
  input.type = input.type === 'password' ? 'text' : 'password';
  e.target.textContent = input.type === 'password' ? 'Show' : 'Hide';
});
$('#ghe-add').addEventListener('click', addHost);
$('#tc-add').addEventListener('click', addTeamCity);
$('#tc-host').addEventListener('keydown', (e) => e.key === 'Enter' && addTeamCity());
$('#ghe-host').addEventListener('keydown', (e) => e.key === 'Enter' && addHost());
$('#bm-export').addEventListener('click', exportBookmarks);
$('#bm-import').addEventListener('change', (e) => e.target.files[0] && importBookmarks(e.target.files[0]));
$('#bm-clear').addEventListener('click', clearBookmarks);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bookmarks) renderBookmarkCount();
});

initSettings();
renderTokenHosts();
renderEnterprise();
renderTeamCity();
renderBookmarkCount();

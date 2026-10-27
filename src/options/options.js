const DEFAULTS = HT.DEFAULTS;

const $ = (sel) => document.querySelector(sel);

// The toolbar button opens this page as a popup. A popup closes when a file
// picker, a permission prompt or confirm() takes focus (Firefox doesn't show
// confirm() in one at all), so those controls (data-window) open the page in
// its own window instead.
const POPUP = new URLSearchParams(location.search).has('popup');
if (POPUP) {
  document.documentElement.classList.add('popup');
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target.closest('[data-window]');
      if (!el) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'openOptions', section: el.dataset.window }).finally(() => window.close());
    },
    true
  );
}

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

// Self-hosted entries are "host" (https) or "http://host"; tokens are keyed
// by host.
const entryOrigin = (entry) => (entry.startsWith('http://') ? entry : `https://${entry}`);
const entryHost = (entry) => entry.replace(/^http:\/\//, '');

async function originOf(host) {
  if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') return `https://${host}`;
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  return entryOrigin(enterpriseHosts.find((e) => entryHost(e) === host) || host);
}

// github.com and gitlab.com are known; ask a self-hosted server whether it
// has GitLab's API (it answers JSON, even when signed out).
const kinds = new Map([['github.com', 'github'], ['gitlab.com', 'gitlab'], ['bitbucket.org', 'bitbucket']]);
async function providerOf(host) {
  if (!kinds.has(host)) {
    const origin = await originOf(host);
    // Bitbucket Server names itself (at the root; a server under a context
    // path shows up as GitHub here, but its pages still say Bitbucket).
    const bbs = await fetch(`${origin}/rest/api/1.0/application-properties`, { credentials: 'omit' })
      .then((r) => r.json())
      .then((d) => d?.displayName === 'Bitbucket')
      .catch(() => false);
    const kind = bbs
      ? 'bitbucket-server'
      : await fetch(`${origin}/api/v4/version`, { credentials: 'omit' })
          .then((r) => (/json/.test(r.headers.get('content-type') || '') ? 'gitlab' : 'github'))
          .catch(() => 'github');
    kinds.set(host, kind);
  }
  return kinds.get(host);
}

function apiBase(origin, kind) {
  if (origin === 'https://github.com') return 'https://api.github.com';
  if (origin === 'https://bitbucket.org') return 'https://api.bitbucket.org/2.0';
  return `${origin}/api/${kind === 'gitlab' ? 'v4' : 'v3'}`;
}

const TOKEN_LINKS = {
  github: (origin) => `${origin}/settings/tokens/new?scopes=repo&description=Hector`,
  gitlab: (origin) => `${origin}/-/user_settings/personal_access_tokens?name=Hector&scopes=read_api`,
  bitbucket: () => 'https://id.atlassian.com/manage-profile/security/api-tokens',
  'bitbucket-server': (origin) => `${origin}/plugins/servlet/access-tokens/manage`,
};
const TOKEN_HINT = { github: 'github_pat_… or ghp_…', gitlab: 'glpat-…', bitbucket: 'email:api-token or user:app-password', 'bitbucket-server': 'HTTP access token' };

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
  return ['github.com', 'gitlab.com', 'bitbucket.org', ...enterpriseHosts.map(entryHost)];
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

const SITE_NAME = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', 'bitbucket-server': 'Bitbucket Server' };
// Bitbucket's tokens travel with the account name, as HTTP Basic.
const authHeader = (kind, value) =>
  kind.startsWith('bitbucket') && value.includes(':') ? `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}` : `Bearer ${value}`;

// The saved token is never shown again: the field only takes a new one.
async function loadToken() {
  const host = $('#token-host').value;
  const saved = Boolean((await tokens())[host]);
  $('#token').value = '';
  $('#token').type = 'password';
  $('#token-toggle').textContent = 'Show';
  setStatus($('#token-status'), saved ? 'A token is saved for this host (hidden). Paste a new one to replace it.' : '');
  const kind = await providerOf(host);
  if ($('#token-host').value !== host) return;
  const origin = await originOf(host);
  $('#token-create').href = TOKEN_LINKS[kind](origin);
  if (origin.startsWith('http:')) setStatus($('#token-status'), 'This server uses plain http: a token would travel unencrypted.');
  $('#token').placeholder = saved ? 'Saved (hidden). Paste a new one to replace it.' : TOKEN_HINT[kind];
}

async function saveToken() {
  const host = $('#token-host').value;
  const value = $('#token').value.trim();
  const all = await tokens();
  if (value) all[host] = value;
  else delete all[host];
  await chrome.storage.local.set({ tokens: all });
  setStatus($('#token-status'), value ? 'Token saved.' : 'Token removed.', 'ok');
  if (value) await testToken(value);
  $('#token').value = '';
  $('#token').placeholder = value ? 'Saved (hidden). Paste a new one to replace it.' : $('#token').placeholder;
}

// Tests the token in the field, or the saved one when the field is empty.
async function testToken(value = $('#token').value.trim()) {
  const host = $('#token-host').value;
  const status = $('#token-status');
  if (!value) value = (await tokens())[host] || '';
  if (!value) {
    setStatus(status, 'Enter a token first.', 'err');
    return;
  }
  setStatus(status, 'Testing…');
  try {
    const kind = await providerOf(host);
    const site = SITE_NAME[kind];
    const origin = await originOf(host);
    // Bitbucket Server has no "current user" API; whoami answers the name.
    const bbs = kind === 'bitbucket-server';
    const res = await fetch(bbs ? `${origin}/plugins/servlet/applinks/whoami` : `${apiBase(origin, kind)}/user`, {
      headers: { Accept: 'application/json', Authorization: authHeader(kind, value) },
      credentials: 'omit',
    });
    if (!res.ok) {
      setStatus(status, res.status === 401 ? `${site} rejected this token (401).` : `${site} returned ${res.status}.`, 'err');
      return;
    }
    const user = bbs ? { login: (await res.text()).trim() } : await res.json();
    if (!user.login && !user.username && !user.display_name) {
      setStatus(status, `${site} did not accept this token.`, 'err');
      return;
    }
    setStatus(status, `Works — signed in as ${user.login || user.username || user.display_name}.`, 'ok');
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
      grant.dataset.window = 'servers';
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
  if (!host || ['github.com', 'gitlab.com', 'bitbucket.org'].includes(entryHost(host))) return;
  // Asked first, inside the click's user gesture; the host is saved either way.
  const asked = requestHost(host).catch(() => false);
  const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
  // One entry per host: switching between http and https replaces it.
  const others = enterpriseHosts.filter((e) => entryHost(e) !== entryHost(host));
  enterpriseHosts.splice(0, enterpriseHosts.length, ...others, host);
  await chrome.storage.sync.set({ enterpriseHosts });
  $('#ghe-host').value = '';
  const granted = await asked;
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
  kinds.delete(entryHost(host)); // it may come back as a different kind of server
  await chrome.storage.local.set({ tokens: all });
  await renderEnterprise();
  await renderTokenHosts();
}

// ---------- backup, restore & reset ----------

let pending = null; // a checked backup waiting for "Import"
let toGrant = [];

$('#bk-tokens').addEventListener('change', (e) => {
  $('#bk-pass-row').hidden = !e.target.checked;
});

$('#bk-export').addEventListener('click', async () => {
  const status = $('#bk-status');
  const tokens = $('#bk-tokens').checked;
  const passphrase = $('#bk-pass').value;
  if (tokens && passphrase !== $('#bk-pass2').value) return setStatus(status, 'The passphrases differ.', 'err');
  try {
    const data = await HT.backup.build({ bookmarks: $('#bk-bookmarks').checked, tokens, passphrase });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hector-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('#bk-pass').value = $('#bk-pass2').value = '';
    setStatus(status, `Saved. ${tokens ? 'Tokens are encrypted with your passphrase.' : 'No tokens are in the file.'}`, 'ok');
  } catch (err) {
    setStatus(status, err.message, 'err');
  }
});

$('#bk-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    pending = HT.backup.inspect(await file.text());
    const c = pending.counts;
    $('#bk-summary').textContent =
      `This backup has ${c.settings} settings, ${c.selfHosted} self-hosted server${c.selfHosted === 1 ? '' : 's'}, ` +
      `CI/CD for ${c.repos} repositor${c.repos === 1 ? 'y' : 'ies'}, ${c.bookmarks} bookmark${c.bookmarks === 1 ? '' : 's'}` +
      `${pending.hasTokens ? ' and encrypted access tokens' : ''}. Importing merges it into what you have.`;
    $('#bk-unlock').hidden = !pending.hasTokens;
    $('#bk-review').hidden = false;
    setStatus($('#bk-status'), '');
  } catch (err) {
    setStatus($('#bk-status'), err.message, 'err');
  }
});

$('#bk-cancel').addEventListener('click', () => {
  pending = null;
  $('#bk-review').hidden = true;
});

$('#bk-apply').addEventListener('click', async () => {
  if (!pending) return;
  const status = $('#bk-status');
  try {
    const file = { ...pending.file };
    const passphrase = $('#bk-unlock-pass').value;
    if (file.tokens && !passphrase) delete file.tokens;
    toGrant = await HT.backup.restore(file, passphrase);
    $('#bk-unlock-pass').value = '';
    pending = null;
    $('#bk-review').hidden = true;
    if (!toGrant.length) {
      location.reload();
      return;
    }
    setStatus(status, 'Imported.', 'ok');
    $('#bk-grant').hidden = false;
    $('#bk-grant-text').textContent = `Allow Hector to reach ${toGrant.map((o) => new URL(o).host).join(', ')} again.`;
  } catch (err) {
    setStatus(status, err.message, 'err');
  }
});

$('#bk-grant-btn').addEventListener('click', async () => {
  // Must run inside the click's user gesture.
  const granted = await chrome.permissions.request({ origins: toGrant.map((o) => `${o}/*`) }).catch(() => false);
  if (granted) {
    await chrome.storage.local.set({ grantedAt: Date.now() });
    location.reload();
  }
});

$('#bk-reset').addEventListener('click', async () => {
  const ok = confirm(
    'Reset Hector? This deletes all settings, self-hosted servers, CI/CD setups, bookmarks, access tokens and sign-ins, and removes the sites Hector was allowed to reach. Export a backup first if you might want them back.'
  );
  if (!ok) return;
  await HT.backup.reset();
  location.reload();
});

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
$('#token-test').addEventListener('click', () => testToken());
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
// "Find servers on any site": needs every site; turning it off gives that back.
const ANY_SITE = ['https://*/*', 'http://*/*'];
chrome.storage.sync.get({ autoDetect: false }).then(async ({ autoDetect }) => {
  $('#auto-detect').checked = autoDetect && (await chrome.permissions.contains({ origins: ANY_SITE }));
});
$('#auto-detect').addEventListener('change', async (e) => {
  if (e.target.checked) {
    // Must run inside the click's user gesture.
    const granted = await chrome.permissions.request({ origins: ANY_SITE }).catch(() => false);
    e.target.checked = granted;
    await chrome.storage.sync.set({ autoDetect: granted });
  } else {
    await chrome.storage.sync.set({ autoDetect: false });
    await chrome.permissions.remove({ origins: ANY_SITE }).catch(() => {});
  }
  await renderEnterprise();
});
$('#ghe-host').addEventListener('keydown', (e) => e.key === 'Enter' && addHost());
$('#bm-export').addEventListener('click', exportBookmarks);
$('#bm-import').addEventListener('change', (e) => e.target.files[0] && importBookmarks(e.target.files[0]));
$('#bm-clear').addEventListener('click', clearBookmarks);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.bookmarks) renderBookmarkCount();
});

// ---------- toolbar popup ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function initQuick() {
  $('#quick').hidden = false;
  const tab = await activeTab();
  const state = tab?.id != null ? await chrome.tabs.sendMessage(tab.id, { type: 'state' }).catch(() => null) : null;
  if (state?.visible) $('#sb-toggle').textContent = 'Hide sidebar';
}

$('#sb-toggle').addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id == null) return;
  if (await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => null)) return window.close();
  // Not running here: offer it if the page is a code host.
  const { offered } = (await chrome.runtime.sendMessage({ type: 'offerSite', tabId: tab.id }).catch(() => null)) || {};
  if (offered) return window.close();
  $('#sb-toggle').disabled = true;
  setStatus($('#sb-status'), "This page isn't GitHub, GitLab or Bitbucket. Hector runs on repository pages.");
});

if (POPUP) initQuick();
initSettings();
renderTokenHosts();
renderEnterprise();
renderBookmarkCount();

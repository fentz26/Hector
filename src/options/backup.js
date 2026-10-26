// Backup, restore and reset for the whole extension.
//
// A backup is a JSON file with settings, self-hosted servers, each
// repository's CI/CD setup and (optionally) bookmarks. Access tokens are left
// out unless asked for, and then only encrypted with a passphrase
// (PBKDF2-SHA-256 → AES-256-GCM). Importing checks every value against what
// Hector itself would accept and drops anything else; host access has to be
// granted again by the user.
HT.backup = (() => {
  const FORMAT = { app: 'hector', kind: 'config', version: 1 };
  const ITERATIONS = 310000;

  // Allowed values for string settings, and ranges for numbers.
  const CHOICES = {
    theme: ['auto', 'light', 'dark'],
    dock: ['left', 'right'],
    iconPack: ['github', 'hector'],
    folderStyle: ['outline', 'filled'],
    prDefaultTab: ['changes', 'files'],
    splitPos: ['bottom', 'top', 'left', 'right'],
  };
  const RANGES = { width: [200, 800], fontSize: [11, 18], splitSize: [15, 85], toggleY: [0, 10000] };
  // Every tab Hector has, so a backup keeps the order and visibility of all of them.
  const TABS = HT.DEFAULTS.tabOrder;

  // Site tokens are keyed by host; CI servers' tokens by "ci:" + host.
  const isHost = (h) => typeof h === 'string' && /^(ci:)?[a-z0-9.-]+(:\d{1,5})?$/i.test(h) && h.length <= 260;

  function origin(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  // "host" (https) or "http://host", like the options page stores them.
  function selfHostedEntry(value) {
    if (typeof value !== 'string') return null;
    const o = origin(value.includes('://') ? value : `https://${value}`);
    if (!o) return null;
    const host = new URL(o).host;
    if (host === 'github.com' || host === 'gitlab.com') return null;
    return o.startsWith('http:') ? o : host;
  }

  function cleanSettings(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [key, def] of Object.entries(HT.DEFAULTS)) {
      const v = input[key];
      if (v === undefined) continue;
      if (Array.isArray(def)) {
        if (Array.isArray(v)) out[key] = [...new Set(v.filter((t) => TABS.includes(t)))];
      } else if (typeof def === 'boolean') {
        if (typeof v === 'boolean') out[key] = v;
      } else if (typeof def === 'number') {
        const [min, max] = RANGES[key] || [-Infinity, Infinity];
        if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, Math.round(v)));
      } else if (typeof def === 'string') {
        if (CHOICES[key]?.includes(v)) out[key] = v;
      }
    }
    return out;
  }

  function cleanRepos(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [key, conf] of Object.entries(input).slice(0, 400)) {
      if (typeof key !== 'string' || key.length > 300 || !/^[a-z0-9.:-]+\/\S+$/i.test(key) || !conf || typeof conf !== 'object') continue;
      const clean = {};
      if (conf.native === false) clean.native = false;
      // CI servers: a list of sources (older files: one TeamCity server).
      const sources = HT.ci.sources(conf);
      if (sources.length) clean.sources = sources;
      if (Object.keys(clean).length) out[key.toLowerCase()] = clean;
    }
    return out;
  }

  function cleanTokens(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [host, token] of Object.entries(input)) {
      if (isHost(host) && typeof token === 'string' && token.length <= 500 && /^\S+$/.test(token)) out[host.toLowerCase()] = token;
    }
    return out;
  }

  // ---- encryption of tokens ----
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function keyFor(passphrase, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
  }

  async function encrypt(data, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(passphrase, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
    return { cipher: 'AES-GCM', kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(ct) };
  }

  async function decrypt(box, passphrase) {
    if (box?.cipher !== 'AES-GCM' || box.kdf !== 'PBKDF2-SHA-256' || box.iterations !== ITERATIONS) throw new Error('Unknown token encryption.');
    const key = await keyFor(passphrase, unb64(box.salt));
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch {
      throw new Error('Wrong passphrase, or the file was changed.');
    }
  }

  return {
    // The backup object. passphrase is required when tokens are included.
    async build({ bookmarks = false, tokens = false, passphrase = '' } = {}) {
      const sync = await chrome.storage.sync.get(null);
      const local = await chrome.storage.local.get(['bookmarks', 'tokens']);
      const repos = {};
      for (const [key, conf] of Object.entries(sync)) if (key.startsWith('ci:')) repos[key.slice(3)] = conf;
      const out = {
        ...FORMAT,
        exported: new Date().toISOString(),
        settings: cleanSettings(sync),
        selfHosted: (sync.enterpriseHosts || []).map(selfHostedEntry).filter(Boolean),
        repos: cleanRepos(repos),
      };
      if (bookmarks) out.bookmarks = HT.cleanBookmarks(local.bookmarks || []);
      if (tokens) {
        if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
        out.tokens = await encrypt(cleanTokens(local.tokens), passphrase);
      }
      return out;
    },

    // What a file holds, before importing: { file, hasTokens, counts }.
    inspect(text) {
      let file;
      try {
        file = JSON.parse(text);
      } catch {
        throw new Error("This isn't a Hector backup (not JSON).");
      }
      if (file?.app !== FORMAT.app || file.kind !== FORMAT.kind) throw new Error("This isn't a Hector backup.");
      if (file.version !== FORMAT.version) throw new Error(`This backup is version ${file.version}; this Hector reads version ${FORMAT.version}.`);
      return {
        file,
        hasTokens: Boolean(file.tokens),
        counts: {
          settings: Object.keys(cleanSettings(file.settings)).length,
          selfHosted: (Array.isArray(file.selfHosted) ? file.selfHosted : []).map(selfHostedEntry).filter(Boolean).length,
          repos: Object.keys(cleanRepos(file.repos)).length,
          bookmarks: Array.isArray(file.bookmarks) ? HT.cleanBookmarks(file.bookmarks).length : 0,
        },
      };
    },

    // Applies a checked file; merges with what's there. Returns the origins
    // the user must allow again (self-hosted servers, TeamCity servers).
    async restore(file, passphrase = '') {
      const settings = cleanSettings(file.settings);
      const selfHosted = (Array.isArray(file.selfHosted) ? file.selfHosted : []).map(selfHostedEntry).filter(Boolean);
      const repos = cleanRepos(file.repos);
      const tokens = file.tokens ? cleanTokens(await decrypt(file.tokens, passphrase)) : {};

      const { enterpriseHosts = [] } = await chrome.storage.sync.get('enterpriseHosts');
      const byHost = new Map(enterpriseHosts.map((e) => [e.replace(/^http:\/\//, ''), e]));
      for (const e of selfHosted) byHost.set(e.replace(/^http:\/\//, ''), e);
      const items = { ...settings, enterpriseHosts: [...byHost.values()] };
      for (const [key, conf] of Object.entries(repos)) items[`ci:${key}`] = conf;
      await chrome.storage.sync.set(items);

      const local = await chrome.storage.local.get(['bookmarks', 'tokens']);
      const patch = {};
      if (Array.isArray(file.bookmarks)) {
        const known = new Set((local.bookmarks || []).map((b) => b.url));
        patch.bookmarks = [...(local.bookmarks || []), ...HT.cleanBookmarks(file.bookmarks).filter((b) => !known.has(b.url))];
      }
      if (Object.keys(tokens).length) patch.tokens = { ...(local.tokens || {}), ...tokens };
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);

      const origins = new Set(selfHosted.map((e) => (e.startsWith('http://') ? e : `https://${e}`)));
      for (const conf of Object.values(repos)) for (const s of conf.sources || []) origins.add(HT.ci.originOf(s.server));
      const missing = [];
      for (const o of origins) if (!(await chrome.permissions.contains({ origins: [`${o}/*`] }))) missing.push(o);
      return missing;
    },

    // Everything back to a fresh install: settings, servers, repositories,
    // bookmarks, tokens and sign-ins, and the hosts Hector was allowed.
    async reset() {
      const required = new Set(chrome.runtime.getManifest().host_permissions || []);
      const { origins = [] } = await chrome.permissions.getAll();
      const optional = origins.filter((o) => !required.has(o));
      if (optional.length) await chrome.permissions.remove({ origins: optional }).catch(() => {});
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
    },
  };
})();

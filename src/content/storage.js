// Settings live in storage.sync (small, follows the user); bookmarks and
// tokens live in storage.local (bigger quota, tokens never sync).
HT.DEFAULTS = {
  theme: 'auto', // auto | light | dark
  dock: 'left', // left | right
  width: 300,
  docked: true,
  compactFolders: true,
  fileIcons: true, // colored icons in the 'hector' pack
  iconPack: 'github', // github (monochrome, like GitHub's tree) | hector (colored)
  tabOrder: ['changes', 'files', 'commits', 'branches', 'ci', 'bookmarks'],
  toggleY: 0, // edge toggle's top in px when dragged; 0 = under the page header
  hiddenTabs: [], // tabs turned off in the + menu
  folderStyle: 'outline', // outline | filled (not shown in settings yet)
  showTabLabels: false, // not shown in settings yet
  fontSize: 14,
  prDefaultTab: 'changes', // changes | files
  hideNotices: false,
  splitPos: 'bottom', // split view: bottom | top | left | right of the main pane
  splitSize: 45, // split view: % of the sidebar's height for the lower pane
};

HT.settings = { ...HT.DEFAULTS };

// Last-seen data, so a tab can paint at once and refresh behind it. Lives in
// storage.local (never synced), a few dozen small entries, least recent first
// out. Anything that doesn't fit or fails to store is simply not cached.
HT.cache = {
  MAX_ENTRIES: 24,
  MAX_CHARS: 300000,
  _k: (key) => `cache:${key}`,

  async get(key) {
    try {
      const k = this._k(key);
      return (await chrome.storage.local.get(k))[k]?.data ?? null;
    } catch {
      return null;
    }
  },

  // Listings past this many rows can't fit MAX_CHARS, so don't serialize them
  // just to find that out (a 500k-path tree is ~30 MB of JSON, ~1 s).
  MAX_ROWS: 4000,

  tooBig(data) {
    for (const k of ['entries', 'items', 'runs']) if (Array.isArray(data?.[k]) && data[k].length > this.MAX_ROWS) return true;
    return JSON.stringify(data).length > this.MAX_CHARS;
  },

  async set(key, data) {
    try {
      if (this.tooBig(data)) return this.drop(key);
      const { 'cache:index': index = [] } = await chrome.storage.local.get('cache:index');
      const next = [key, ...index.filter((k) => k !== key)];
      await chrome.storage.local.set({ [this._k(key)]: { at: Date.now(), data }, 'cache:index': next.slice(0, this.MAX_ENTRIES) });
      if (next.length > this.MAX_ENTRIES) await chrome.storage.local.remove(next.slice(this.MAX_ENTRIES).map(this._k));
    } catch {
      // Over quota or storage unavailable: run without a cache.
    }
  },

  async drop(key) {
    try {
      await chrome.storage.local.remove(this._k(key));
    } catch {
      // ignore
    }
  },
};

HT.store = {
  async load() {
    const { visibleTabs } = await chrome.storage.sync.get('visibleTabs');
    Object.assign(HT.settings, await chrome.storage.sync.get(HT.DEFAULTS));
    // Older builds stored the shown tabs; store the hidden ones instead, so
    // tabs added later appear by default.
    if (Array.isArray(visibleTabs)) {
      const hiddenTabs = ['changes', 'files', 'bookmarks'].filter((t) => !visibleTabs.includes(t));
      HT.settings.hiddenTabs = hiddenTabs;
      await chrome.storage.sync.set({ hiddenTabs });
      await chrome.storage.sync.remove('visibleTabs');
    }
    // The colored pack was named after the old HectaTree brand.
    if (HT.settings.iconPack === 'hectatree') await this.set({ iconPack: 'hector' });
    return HT.settings;
  },

  async set(patch) {
    Object.assign(HT.settings, patch);
    await chrome.storage.sync.set(patch);
  },

  async bookmarks() {
    const { bookmarks = [] } = await chrome.storage.local.get('bookmarks');
    return bookmarks;
  },

  async saveBookmarks(list) {
    await chrome.storage.local.set({ bookmarks: list });
  },

  // Per-repository CI/CD settings, one sync item per repository (keeps each
  // under sync's per-item size limit):
  //   { native: false?, teamcity: { server, ids? } }
  async repoCI(repoKey) {
    const key = `ci:${repoKey}`;
    return (await chrome.storage.sync.get(key))[key] || {};
  },

  async setRepoCI(repoKey, patch) {
    const key = `ci:${repoKey}`;
    const next = { ...(await this.repoCI(repoKey)), ...patch };
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
    if (Object.keys(next).length) await chrome.storage.sync.set({ [key]: next });
    else await chrome.storage.sync.remove(key);
  },

  onChange(cb) {
    chrome.storage.onChanged.addListener((changes, area) => cb(changes, area));
  },
};

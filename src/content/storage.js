// Settings live in storage.sync (small, follows the user); bookmarks and
// tokens live in storage.local (bigger quota, tokens never sync).
HT.DEFAULTS = {
  theme: 'auto', // auto | light | dark
  dock: 'left', // left | right
  width: 300,
  docked: true,
  hoverPeek: true,
  compactFolders: true,
  fileIcons: true, // colored icons in the 'hector' pack
  iconPack: 'github', // github (monochrome, like GitHub's tree) | hector (colored)
  tabOrder: ['changes', 'files', 'ci', 'bookmarks'],
  hiddenTabs: [], // tabs turned off in the + menu
  folderStyle: 'outline', // outline | filled (not shown in settings yet)
  showTabLabels: false, // not shown in settings yet
  fontSize: 14,
  prDefaultTab: 'changes', // changes | files
  hideNotices: false,
};

HT.settings = { ...HT.DEFAULTS };

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

  onChange(cb) {
    chrome.storage.onChanged.addListener((changes, area) => cb(changes, area));
  },
};

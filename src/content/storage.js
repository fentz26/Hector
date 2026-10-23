// Settings live in storage.sync (small, follows the user); bookmarks and
// tokens live in storage.local (bigger quota, tokens never sync).
HT.DEFAULTS = {
  theme: 'auto', // auto | light | dark
  dock: 'left', // left | right
  width: 300,
  docked: true,
  hoverPeek: true,
  compactFolders: true,
  fileIcons: true, // colored icons in the 'hectatree' pack
  iconPack: 'github', // github (monochrome, like GitHub's tree) | hectatree (colored)
  tabOrder: ['changes', 'files', 'bookmarks'],
  visibleTabs: ['changes', 'files', 'bookmarks'],
  folderStyle: 'outline', // outline | filled (not shown in settings yet)
  showTabLabels: false, // not shown in settings yet
  fontSize: 13,
  prDefaultTab: 'changes', // changes | files
  hideNotices: false,
};

HT.settings = { ...HT.DEFAULTS };

HT.store = {
  async load() {
    Object.assign(HT.settings, await chrome.storage.sync.get(HT.DEFAULTS));
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

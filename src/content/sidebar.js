// The sidebar: UI shell, data loading for code/PR trees, and bookmarks.
const { h } = HT;

const THEME_TOKENS = [
  '--bg', '--bg-2', '--bg-hover', '--bg-sel', '--bg-input', '--fg', '--fg-2', '--fg-3', '--border',
  '--accent', '--accent-2', '--primary', '--primary-fg', '--add', '--del', '--mod', '--ren', '--mark',
  '--graph-button-bg', '--graph-button-fg', '--graph-button-border', '--graph-button-hover',
  '--bg-header', '--tab-active', '--bg-overlay', '--shadow-overlay', '--border-muted', '--shadow-card',
  '--page-font', '--panel-bg', '--panel-border', '--panel-shadow', '--section-bg', '--section-border', '--highlight', '--focus-ring',
  ...Array.from({ length: 16 }, (_, i) => `--ansi-${i}`),
];

// github.com logins of people who contributed code or donated to Hector.
const SUPPORTERS = {
  contributors: ['fentz26'],
  donors: [],
};

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

// GitHub's top header, across old and new layouts.
const GH_HEADER = 'header.AppHeader, .AppHeader, header.Header, .js-header-wrapper header, header[role="banner"]';

const STATUS_LABEL = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: '·' };

// The Dynamic tab's project view, in order; its filter menu turns parts off.
// On the repository's home page the site already shows the facts marked
// `onPage`, so they're left out there and only shown on other pages.
const PROJECT_FIELDS = [
  ['outline', 'README outline'],
  ['activity', 'Recent activity'],
  ['about', 'About'],
  ['stats', 'Stars, forks and open items'],
  ['languages', 'Languages'],
  ['release', 'Latest release'],
  ['details', 'Details'],
  ['clone', 'Clone addresses'],
];
const ON_PAGE = new Set(['about', 'stats', 'languages', 'release', 'details', 'clone']);
const HOME_ONLY = new Set(['outline']);

// Language colors as GitHub's linguist has them; others get a stable color from the name.
const LANG_COLORS = {
  Rust: '#dea584', JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572a5', Go: '#00add8', 'C++': '#f34b7d', C: '#555555',
  'C#': '#178600', Java: '#b07219', Kotlin: '#a97bff', Swift: '#f05138', Ruby: '#701516', PHP: '#4f5d95', Shell: '#89e051',
  PowerShell: '#012456', HTML: '#e34c26', CSS: '#663399', SCSS: '#c6538c', Vue: '#41b883', Svelte: '#ff3e00', Dart: '#00b4ab',
  Lua: '#000080', Makefile: '#427819', CMake: '#da3434', Dockerfile: '#384d54', HLSL: '#aace60', GLSL: '#5686a5', WGSL: '#1a5e9a',
  'Objective-C': '#438eff', Zig: '#ec915c', Haskell: '#5e5086', Elixir: '#6e4a7e', Scala: '#c22d40', Nix: '#7e7eff', Python3: '#3572a5',
  Markdown: '#083fa1', TeX: '#3d6117', 'Jupyter Notebook': '#da5b0b', Batchfile: '#c1f12e', Assembly: '#6e4c13', Perl: '#0298c3', R: '#198ce7',
};
const langColor = (name) => {
  if (LANG_COLORS[name]) return LANG_COLORS[name];
  let n = 0;
  for (const c of name) n = (n * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${n}, 45%, 55%)`;
};

HT.Sidebar = class Sidebar {
  constructor() {
    this.s = HT.settings;
    this.ctx = null;
    this.repoKey = null;
    this.repo = null;
    this.code = null; // { ref, loading, root, error, notice, lazy }
    this.pr = null; // { number, loading, info, root, error, notice }
    this.error = null;
    this.tab = 'files';
    this.currentPath = '';
    this.visible = false;
    this.peeking = false;
    this.navSeq = 0;
    this.rate = null;
    this.bookmarks = [];
    this.bookmarkUrls = new Set();

    this.filesTree = new HT.Tree({
      linkFor: (n) => this._codeLink(n),
      actionsFor: (n) => [
        { act: 'star', icon: 'bookmark', title: 'Bookmark', on: this.bookmarkUrls.has(this._codeLink(n)) },
        { act: 'copy', icon: 'copy', title: 'Copy path' },
      ],
      onAction: (act, n, el) => this._onRowAction(act, n, el),
      loadChildren: (n) => this._loadChildren(n),
      onOpen: (n) => this._openPreview('files', n),
      compact: () => this.s.compactFolders,
      colored: () => this.s.fileIcons,
      iconPack: () => this.s.iconPack,
      onError: (err) => this._toast(err.message),
      onTop: () => this._searchTarget(this._paneOfEl(this.filesTree.el)).focus(),
      onEscape: () => this._escape(this._paneOfEl(this.filesTree.el)),
      onExpandChange: () => this._updateExpandBtn(),
    });

    this.changesTree = new HT.Tree({
      linkFor: (n) => (n.type === 'tree' ? null : this._diffLink(n)),
      actionsFor: (n) => (n.type === 'tree' ? [] : [{ act: 'copy', icon: 'copy', title: 'Copy path' }]),
      onAction: (act, n, el) => this._onRowAction(act, n, el),
      renderMeta: (n) => this._diffMeta(n),
      onOpen: (n) => this._openPreview('changes', n) || this._openDiff(n),
      compact: () => this.s.compactFolders,
      colored: () => this.s.fileIcons,
      iconPack: () => this.s.iconPack,
      onTop: () => this._searchTarget(this._paneOfEl(this.changesTree.el)).focus(),
      onEscape: () => this._escape(this._paneOfEl(this.changesTree.el)),
      onExpandChange: () => this._updateExpandBtn(),
    });

    this._build();
    this._applyTheme();
    this._applyLayout();
    this._loadBookmarks();
    this._loadAccount();
    this._watchTheme();
    this._watchHeaderLayout();

    HT.api.onRate = (remaining, limit) => {
      this.rate = { remaining, limit };
      this._renderStats();
    };

    HT.store.onChange((changes, area) => this._onStorageChange(changes, area));
  }

  // ---------- DOM shell ----------

  _btn(icon, title, onClick, extra = {}) {
    return h('button', { class: 'ht-btn', type: 'button', title, 'aria-label': title, onClick, dataset: { icon }, ...extra }, HT.icon(icon));
  }

  _makePane(kind) {
    const pane = { kind };
    pane.search = h('input', {
      class: 'ht-search-input',
      type: 'text',
      placeholder: 'Go to file…',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Filter',
      onInput: HT.debounce(() => this._filter(pane), 80),
      onKeydown: (e) => this._onSearchKey(e, pane),
    });
    pane.expandBtn = this._btn('expandAll', 'Expand all folders', () => this._toggleExpandAll(pane));
    // The filter box stays folded into this icon until asked for (or until
    // something is typed while the pane has focus).
    pane.searchBtn = this._btn('search', 'Filter', () => this._toggleSearch(pane), { class: 'ht-btn ht-search-toggle', 'aria-pressed': 'false' });
    pane.bar = h(
      'div',
      { class: 'ht-search' },
      pane.search,
      pane.searchBtn,
      pane.expandBtn,
      this._btn('refresh', `Reload from ${HT.provider.name}`, () => this.refresh())
    );
    pane.body = h('div', { class: 'ht-body', role: 'tabpanel', tabindex: '-1', onKeydown: (e) => this._typeToSearch(e, pane) });
    // Each tab keeps its own scroll position and search text in this pane.
    pane.scrolls = {};
    pane.queries = {};
    pane.body.addEventListener(
      'scroll',
      () => {
        pane.body.classList.add('scrolling');
        clearTimeout(pane.scrollTimer);
        pane.scrollTimer = setTimeout(() => pane.body.classList.remove('scrolling'), 900);
      },
      { passive: true }
    );
    return pane;
  }

  // The tab a pane shows, and the pane showing a tab.
  _tabOf(pane) {
    return pane === this.second ? this.split : this.tab;
  }

  _paneOf(tab) {
    return tab && tab === this.split ? this.second : this.main;
  }

  _paneOfEl(el) {
    return this.second.el.contains(el) ? this.second : this.main;
  }

  // ---------- the folded filter box ----------

  _searchShown(pane) {
    return Boolean(pane.searchOpen || pane.search.value);
  }

  _syncSearch(pane) {
    const open = this._searchShown(pane);
    pane.el?.classList.toggle('search-closed', !open);
    pane.searchBtn.classList.toggle('on', open);
    // Open, the icon closes the box.
    if (pane.searchBtn.dataset.icon !== (open ? 'close' : 'search')) {
      pane.searchBtn.dataset.icon = open ? 'close' : 'search';
      pane.searchBtn.replaceChildren(HT.icon(pane.searchBtn.dataset.icon));
    }
    pane.searchBtn.setAttribute('aria-pressed', String(open));
    const label = open ? 'Hide the filter box' : pane.search.placeholder.replace(/…$/, '');
    pane.searchBtn.title = label;
    pane.searchBtn.setAttribute('aria-label', label);
  }

  _openSearch(pane) {
    pane.searchOpen = true;
    this._syncSearch(pane);
    pane.search.focus();
  }

  // Closing clears what was typed, so nothing stays filtered out of sight.
  _toggleSearch(pane) {
    if (!this._searchShown(pane)) return this._openSearch(pane);
    pane.searchOpen = false;
    const had = pane.search.value;
    pane.search.value = '';
    this._syncSearch(pane);
    if (had) this._filter(pane);
    pane.searchBtn.focus();
  }

  // Where focus goes "up" from the first row: the box when shown, else its icon.
  _searchTarget(pane) {
    return this._searchShown(pane) ? pane.search : pane.searchBtn;
  }

  // Typing a letter in a pane (rows focused) opens its filter box with it.
  _typeToSearch(e, pane) {
    // Esc in a preview or an opened item goes back, wherever the focus is in the pane.
    const tab = this._tabOf(pane);
    if (e.key === 'Escape' && !e.target.closest('input, textarea, select') && (this.previews?.[tab] || this.lists?.[tab]?.detail)) {
      e.preventDefault();
      this._escape(pane);
      return;
    }
    if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (this.tab === 'ci' && this.ci?.detail && pane === this._paneOf('ci')) return;
    if (this._tabOf(pane) === 'info') return;
    if (['pulls', 'issues'].includes(this._tabOf(pane))) return pane.search.focus();
    this._openSearch(pane);
  }

  _treeFor(tab) {
    return { files: this.filesTree, changes: this.changesTree }[tab] || null;
  }

  // GitLab's icon sprites arrived: redraw everything that shows icons.
  refreshIcons() {
    for (const el of this.shadow.querySelectorAll('[data-icon]')) el.replaceChildren(HT.icon(el.dataset.icon));
    this._applyLayout();
    this._updateExpandBtn();
    this._renderTabs();
    this._renderStats();
    if (this.settingsOpen) return;
    if (this.tab === 'ci') this._rerenderCI(this.ci);
    else this.renderBody();
  }

  _build() {
    this.host = h('hector-sidebar');
    this.host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:31;';
    // Closed, so scripts on the page can't reach into the sidebar.
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    // Keys pressed in the sidebar are its own. They leave the shadow root
    // retargeted to this host, where the page's shortcut handlers (GitHub's
    // "s", "t", "g c"…) can't tell they came from a search box or the tree.
    for (const type of ['keydown', 'keypress', 'keyup']) this.host.addEventListener(type, (e) => e.stopPropagation());
    this.shadow.append(h('style', null, HT.CSS));

    // The edge toggle: click opens; hovering shows a grip below the logo to
    // drag it up or down the edge.
    this.toggleBtn = h(
      'div',
      { class: 'ht-toggle' },
      h(
        'button',
        { class: 'ht-toggle-open', type: 'button', title: 'Open Hector (Alt+Shift+T)', 'aria-label': 'Open Hector', onClick: () => this.setDocked(true) },
        HT.icon('logo')
      ),
      h('span', { class: 'ht-toggle-grip', title: 'Drag to move, click to open', 'aria-hidden': 'true', onPointerdown: (e) => this._startToggleMove(e) }, HT.icon('grabber'))
    );

    // Ref, file count and API budget live in a footer status bar, so the tab
    // row can take the full height of GitHub's repository nav and line up
    // with its icons.
    this.statsEl = h('div', { class: 'ht-stats' });
    this.starBtn = this._btn('bookmark', 'Bookmark this page', () => this._bookmarkCurrent());
    this.pinBtn = this._btn('pin', 'Dock sidebar', () => this.setDocked(!this.s.docked));
    // Where bookmark and dock go when the row runs out of room (_fitTop).
    this.moreBtn = this._btn('more', 'More', (e) => this._toggleMore(e), { hidden: true, 'aria-haspopup': 'menu' });
    const actions = h(
      'div',
      { class: 'ht-footer-actions' },
      this.moreBtn,
      this.starBtn,
      this.pinBtn,
      (this.settingsBtn = this._btn('settings', 'Settings', () => this.toggleSettings())),
      this._btn('close', 'Hide sidebar', () => this._close())
    );
    // GitLab's own sidebar keeps everything at the top, and the row there has
    // room beside the tabs: the status and buttons go up into it.
    const statusOnTop = (this.statusOnTop = (HT.provider.site || HT.provider.id) === 'gitlab');
    const footer = statusOnTop ? null : h('footer', { class: 'ht-footer' }, this.statsEl, actions);

    this.tabsEl = h('nav', { class: 'ht-tabs', role: 'tablist', 'aria-label': 'Hector tabs', onKeydown: (e) => this._tabsKey(e) });
    // Two panes, built alike: the main one and the split one (hold a tab to
    // open it). Each has its own search, expand/collapse and reload buttons,
    // content and job view; `this.pane` is the one being rendered.
    this.main = this._makePane('main');
    this.main.el = h('div', { class: 'ht-main' }, this.main.bar, this.main.body);
    this.second = this._makePane('second');
    this.splitTitle = h('span', { class: 'ht-split-title' });
    this.second.el = h(
      'section',
      { class: 'ht-split', hidden: true, 'aria-label': 'Split view' },
      h(
        'div',
        { class: 'ht-split-head' },
        h(
          'span',
          { class: 'ht-split-grip', title: 'Drag to move', onMousedown: (e) => this._startSplitMove(e) },
          HT.icon('grabber')
        ),
        this.splitTitle,
        this._btn('close', 'Close split view', () => this.closeSplit())
      ),
      this.second.bar,
      this.second.body
    );
    this.second.bar.classList.add('ht-split-search');
    this.second.body.classList.add('ht-split-body');
    this.pane = this.main;
    this.body = this.main.body;
    this.toastEl = h('div', { class: 'ht-toast', role: 'status' });

    this.topBar = h('div', { class: 'ht-top' }, this.tabsEl, statusOnTop ? this.statsEl : null, statusOnTop ? actions : null);
    this.panel = h(
      'aside',
      {
        class: 'ht-panel',
        'aria-label': 'Hector',
        onMouseenter: () => clearTimeout(this._peekTimer),
        onMouseleave: () => this._peekLeave(),
      },
      this.topBar,
      (this.stack = h(
        'div',
        { class: 'ht-stack' },
        this.main.el,
        (this.splitGap = h('div', { class: 'ht-split-gap', hidden: true, title: 'Drag to resize', onMousedown: (e) => this._startSplitResize(e) })),
        this.second.el
      )),
      footer,
      this.toastEl,
      h('div', { class: 'ht-resizer', onMousedown: (e) => this._startResize(e) })
    );

    this.root = h('div', { class: 'ht-root', hidden: true, dataset: { site: HT.provider.site || HT.provider.id } }, this.toggleBtn, this.panel);
    if (statusOnTop) {
      // Refit whenever the row's size or contents change (not on the
      // attributes the fit itself sets, so it can't loop).
      let queued = false;
      const fit = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          this._fitTop();
        });
      };
      new ResizeObserver(fit).observe(this.topBar);
      new MutationObserver(fit).observe(this.topBar, { childList: true, subtree: true, characterData: true });
    }
    this.shadow.append(this.root);
    document.documentElement.append(this.host);
  }

  // The tab row on GitLab also holds the branch, the account and the
  // buttons. When it runs short, they give way in order: the branch and
  // file count, the account's name, the account, then bookmark and dock
  // move into a ⋯ menu. Past that the tabs scroll sideways.
  _fitTop() {
    if (!this.statusOnTop || this.root.hidden) return;
    const chip = this.accountEl;
    this.statsEl.classList.remove('gone');
    if (chip) {
      chip.hidden = false;
      chip.classList.remove('compact');
    }
    this.starBtn.hidden = false;
    this.pinBtn.hidden = false;
    this.moreBtn.hidden = true;
    const clipped = (el) => el && !el.hidden && el.scrollWidth > el.clientWidth + 1;
    const login = () => (chip?.classList.contains('compact') ? null : chip?.querySelector('.ht-account-login'));
    const fits = () => !clipped(this.tabsEl) && !(!this.statsEl.classList.contains('gone') && clipped(this.statsEl)) && !clipped(chip) && !clipped(login());
    const steps = [
      // Gone but still taking the leftover room, so the buttons stay at the right.
      () => this.statsEl.classList.add('gone'),
      () => chip?.classList.add('compact'),
      () => chip && (chip.hidden = true),
      () => {
        this.starBtn.hidden = true;
        this.pinBtn.hidden = true;
        this.moreBtn.hidden = false;
      },
    ];
    for (const step of steps) {
      if (fits()) return;
      step();
    }
  }

  _toggleMore(e) {
    e?.stopPropagation();
    if (this.moreMenu?.isConnected) {
      this.moreMenu.remove();
      return;
    }
    const close = () => this.moreMenu?.remove();
    const docked = this.s.docked;
    const marked = this.starBtn.classList.contains('on');
    this.moreMenu = h(
      'div',
      { class: 'ht-pop ht-more-pop', role: 'menu', onClick: (ev) => ev.stopPropagation() },
      this._popItem(marked, marked ? 'Remove bookmark' : 'Bookmark this page', null, 'menuitem', () => (close(), this._bookmarkCurrent())),
      this._popItem(docked, docked ? 'Undock (show on hover)' : 'Dock sidebar', null, 'menuitem', () => (close(), this.setDocked(!docked))),
      this.accountEl?.hidden ? this._popItem(false, this.account?.login ? `Account: ${this.account.login}` : 'Account', null, 'menuitem', () => (close(), this.toggleSettings(true))) : null
    );
    this.topBar.append(this.moreMenu);
    setTimeout(() => this.shadow.addEventListener('click', close, { once: true }));
  }

  ensureAttached() {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  // ---------- remembered UI state (last tab and split pane) ----------
  // Lives in storage.local, per site, so a new page opens on the tab you
  // last used instead of always on Files.

  _uiKey() {
    return `ui:${location.host}`;
  }

  // Once per page load; the background asks the update list at most every
  // 6 hours.
  checkUpdateQuietly() {
    HT.api.send({ type: 'update:check' }).then((res) => this._markUpdate(res), () => {});
  }

  async restoreState() {
    try {
      const key = this._uiKey();
      const ui = (await chrome.storage.local.get(key))[key];
      const ids = HT.DEFAULTS.tabOrder.filter((id) => id !== 'settings');
      // The tab last used on repository pages, and the one last used on pull requests.
      this._uiTab = ids.includes(ui?.tab) ? ui.tab : null;
      this._uiPullTab = ids.includes(ui?.pullTab) ? ui.pullTab : null;
      if (this._uiTab) this.tab = this._uiTab;
      if (ids.includes(ui?.split) && ui.split !== this.tab) this.split = ui.split;
      this._ciShowSkipped = Boolean(ui?.showSkipped);
      this._brSort = ui?.branchSort === 'recent' ? 'recent' : 'name';
    } catch {
      // Nothing remembered.
    }
  }

  _saveState() {
    clearTimeout(this._saveStateTimer);
    if (HT.changeId(this.ctx)) this._uiPullTab = this.tab;
    else this._uiTab = this.tab;
    this._saveStateTimer = setTimeout(() => {
      const ui = { tab: this._uiTab || this.tab, pullTab: this._uiPullTab || null, split: this.split || null, showSkipped: Boolean(this._ciShowSkipped), branchSort: this._brSort || 'name' };
      chrome.storage.local.set({ [this._uiKey()]: ui }).catch(() => {});
    }, 300);
  }

  // Arrow keys move between tabs (and switch to them), Home/End jump; Shift
  // with an arrow moves the tab itself, like Alt+arrows in the tab menu.
  _tabsKey(e) {
    const tabs = [...this.tabsEl.querySelectorAll('.ht-tab[data-tab]')];
    const i = tabs.indexOf(e.target.closest?.('.ht-tab'));
    if (i < 0) return;
    let to;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = tabs.length - 1;
    else return;
    e.preventDefault();
    const from = tabs[i].dataset.tab;
    const target = tabs[to].dataset.tab;
    if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      this._moveTab(from, target, e.key === 'ArrowRight');
      this.tabsEl.querySelector(`.ht-tab[data-tab="${CSS.escape(from)}"]`)?.focus();
      return;
    }
    if (target !== 'settings') this.setTab(target);
    this.tabsEl.querySelector(`.ht-tab[data-tab="${CSS.escape(target)}"]`)?.focus();
  }

  // ---------- layout / theme ----------

  _applyLayout() {
    const { dock, width, docked, fontSize } = this.s;
    const on = this.visible;
    // The first time it shows on a page load it's simply there, no slide-in.
    if (on && !this._shownOnce) {
      this._shownOnce = true;
      this.root.classList.add('instant');
      requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.remove('instant')));
    }
    this.root.hidden = !on;
    this.root.dataset.dock = dock;
    this.root.classList.toggle('tab-labels', this.s.showTabLabels);
    this.root.classList.toggle('docked', on && docked);
    this.root.classList.toggle('peek', on && !docked && this.peeking);
    this.root.style.setProperty('--ht-width', `${width}px`);
    this.root.style.setProperty('--ht-font', `${fontSize}px`);
    this.root.style.setProperty('--ht-split', `${this.s.splitSize}%`);
    if (this.s.toggleY) this.root.style.setProperty('--ht-toggle-y', `${this.s.toggleY}px`);
    else this.root.style.removeProperty('--ht-toggle-y');
    this.stack.dataset.split = this.s.splitPos;

    const html = document.documentElement;
    html.style.setProperty('--hector-width', `${width}px`);
    html.classList.toggle('hector-docked-left', on && docked && dock === 'left');
    html.classList.toggle('hector-docked-right', on && docked && dock === 'right');
    html.classList.remove('hector-early');
    // Pages without a repository hide the sidebar; that's not undocking.
    if (on) this._saveShell(docked);

    this.pinBtn.replaceChildren(HT.icon(docked ? 'unpin' : 'pin'));
    this.pinBtn.title = docked ? 'Undock (show on hover)' : 'Dock sidebar';
    this._syncSharedHeaders();
    this._syncTop();
    this._shiftFixedBars();
  }

  // Remember the docked sidebar's size and color for early.js, which makes
  // its room on the next page load before the page paints. Kept in this
  // browser only, and only while docked.
  _saveShell(docked) {
    const key = `shell:${location.host}`;
    if (!docked) {
      if (this._shell !== null) chrome.storage.local.remove(key).catch(() => {});
      this._shell = null;
      return;
    }
    const shell = { dock: this.s.dock, width: this.s.width, bg: getComputedStyle(this.panel).backgroundColor };
    const json = JSON.stringify(shell);
    if (json === this._shell) return;
    this._shell = json;
    chrome.storage.local.set({ [key]: shell }).catch(() => {});
  }

  // Share only the global controls/breadcrumb row. Repository navigation
  // (Code, Issues, Pull requests) stays beside the sidebar and content.
  _syncSharedHeaders() {
    const next = new Set();
    // GitLab's top bar sits beside its own navigation; the sidebar simply
    // starts at the top of the page there.
    const github = HT.provider.id === 'github';
    const repositoryHeader = github ? this._findHeader() : null;
    const repoNav = github ? document.querySelector('nav[aria-label="Repository"]') : null;
    let globalRow = repositoryHeader?.querySelector('.AppHeader-globalBar');
    if (!globalRow && repositoryHeader && repoNav) {
      const breadcrumbs = repositoryHeader.querySelector('nav[aria-label="Breadcrumbs"]');
      let row = breadcrumbs;
      while (row?.parentElement && row.parentElement !== repositoryHeader && !row.parentElement.contains(repoNav)) row = row.parentElement;
      if (row && !row.contains(repoNav)) globalRow = row;
      if (!globalRow) globalRow = [...repositoryHeader.children].find(el =>
        !el.contains(repoNav) && el.getBoundingClientRect().height > 24);
    }
    // Older GitHub headers without repository tabs are already a single row.
    if (!globalRow && repositoryHeader && !repositoryHeader.contains(repoNav)) globalRow = repositoryHeader;
    if (globalRow) next.add(globalRow);
    this._sharedGlobalRow = globalRow;
    this._repositoryNav = repoNav;
    if (github) for (const el of document.querySelectorAll('header[data-marketing-header], header.HeaderMktg, header.header-logged-out')) next.add(el);
    for (const el of next) {
      if ([...next].some(parent => parent !== el && parent.contains(el))) next.delete(el);
    }
    for (const el of this._sharedHeaders || []) {
      if (!next.has(el) || !this.visible) el.removeAttribute('data-hector-shared-header');
    }
    for (const el of next) {
      if (this.visible) {
        el.setAttribute('data-hector-shared-header', getComputedStyle(el).position === 'fixed' ? 'fixed' : 'flow');
        // A widened row must paint the same background across its entire width,
        // including the area outside its original parent header's content box.
        for (let source = el; source; source = source.parentElement) {
          const color = getComputedStyle(source).backgroundColor;
          if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') {
            el.style.setProperty('--hector-native-header-bg', color);
            break;
          }
        }
      }
    }
    this._sharedHeaders = next;
  }

  _syncTop() {
    if (!this.visible) return;
    this._syncPullTitleBar();
    const row = this._sharedGlobalRow;
    const nav = this._repositoryNav;
    // Use the start of the tab row, including any padding after global controls.
    const boundary = row?.isConnected && nav?.isConnected
      ? nav.getBoundingClientRect().top
      : row?.getBoundingClientRect().bottom || 0;
    // A site whose own top bar is fixed across the page (Bitbucket): start under it.
    const topBar = HT.provider.topBar?.();
    const fixedTop = topBar?.isConnected && getComputedStyle(topBar).position === 'fixed' ? topBar.getBoundingClientRect().bottom : 0;
    const edge = Math.max(0, boundary, fixedTop);
    this.root.classList.toggle('joined-header', Boolean(nav?.isConnected && nav.getBoundingClientRect().bottom > 0));
    if (nav?.isConnected) {
      const height = nav.getBoundingClientRect().height;
      if (height >= 40 && height <= 100) this.root.style.setProperty('--ht-top-height', `${height}px`);
    }
    // Sample the color actually painted in the nav row (translucent layers
    // composited), so the tab row matches it exactly.
    let headerBackground = null;
    if (this.s.theme === 'auto' && nav?.isConnected) {
      const r = nav.getBoundingClientRect();
      if (r.bottom > 0) headerBackground = this._paintedColorAt(this._pageX(), Math.max(r.top, 0) + 2);
    }
    if (headerBackground) this.root.style.setProperty('--bg-header', headerBackground);
    else this.root.style.removeProperty('--bg-header');
    this.root.style.setProperty('--ht-page-top', `${edge}px`);
  }

  // The color actually painted at a point: composite the backgrounds in the
  // stack from the top down until one is opaque.
  _paintedColorAt(x, y) {
    const layers = [];
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === this.host) continue;
      const c = this._rgb(getComputedStyle(el).backgroundColor);
      if (!c || c[3] === 0) continue;
      layers.push(c);
      if (c[3] >= 0.99) break;
    }
    if (!layers.length) return null;
    let [r, g, b] = layers[layers.length - 1][3] >= 0.99 ? layers.pop() : [255, 255, 255];
    for (const [lr, lg, lb, la] of layers.reverse()) {
      r = lr * la + r * (1 - la);
      g = lg * la + g * (1 - la);
      b = lb * la + b * (1 - la);
    }
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }

  // Docking pushes the page with a margin, but position:fixed bars are laid
  // out against the viewport and slide under the sidebar. Move short bars
  // that cross the sidebar edge. Dialogs, drawers and backdrops (tall or
  // modal) are left alone, as are the shared header and PR title strip,
  // which page.css already positions.
  _shiftFixedBars() {
    if (!this._shifted) this._shifted = new Map(); // el -> original inline styles
    const { dock, width, docked } = this.s;
    const active = this.visible && docked;

    for (const [el, orig] of this._shifted) {
      if (!el.isConnected || !active) {
        Object.assign(el.style, orig);
        this._shifted.delete(el);
      }
    }
    if (!active) return;

    const vw = document.documentElement.clientWidth;
    const probeX = dock === 'left' ? width + 4 : vw - width - 4;
    const seen = new Set();
    for (let y = 2; y < innerHeight; y += 36) {
      for (const el of document.elementsFromPoint(probeX, y)) {
        if (seen.has(el) || el === this.host || el === document.body || el === document.documentElement) continue;
        seen.add(el);
        if (getComputedStyle(el).position !== 'fixed') continue;
        if (el.closest('[data-hector-shared-header], [data-hector-pull-title], dialog, [role="dialog"], [aria-modal="true"]')) continue;
        const r = el.getBoundingClientRect();
        // Older GitLab keeps its navigation sidebar fixed at the left edge:
        // move it beside ours. Other tall fixed layers (drawers, overlays)
        // stay put.
        const sidePanel = HT.provider.id === 'gitlab' && el.matches('.super-sidebar, .nav-sidebar');
        if (!this._shifted.has(el) && !sidePanel && (r.height > 160 || r.height < 16)) continue;
        const overlaps = dock === 'left' ? r.left < width - 1 : r.right > vw - width + 1;
        if (!overlaps && !this._shifted.has(el)) continue;
        if (!this._shifted.has(el)) {
          const { left, right, width: w, maxWidth } = el.style;
          this._shifted.set(el, { left, right, width: w, maxWidth });
        }
        if (dock === 'left') el.style.left = `${width}px`;
        else el.style.right = `${width}px`;
        // Full-width bars: keep them inside the remaining page area.
        if (r.width >= vw - width - 2) {
          el.style.width = 'auto';
          el.style.maxWidth = `calc(100vw - ${width}px)`;
          if (dock === 'left') el.style.right = '0px';
          else el.style.left = '0px';
        }
      }
    }
  }

  _syncPullTitleBar() {
    // Only GitHub's PR title strip is viewport-fixed outside the page margin.
    // Do not touch unrelated fixed elements such as drawers or backdrops.
    const bars = new Set();
    if (this.visible && this.s.docked && this.ctx?.kind === 'pull') {
      for (const el of document.querySelectorAll('[data-component="PageHeader"][class*="stickyHeader"], .gh-header-sticky')) {
        const rect = el.getBoundingClientRect();
        if (getComputedStyle(el).position === 'fixed' && rect.height > 0 && rect.height <= 160) bars.add(el);
      }
    }
    for (const el of this._pullTitleBars || []) {
      if (!bars.has(el)) el.removeAttribute('data-hector-pull-title');
    }
    for (const el of bars) el.setAttribute('data-hector-pull-title', '');
    this._pullTitleBars = bars;
  }

  // Keeping the tab row glued to the page header needs a measurement every
  // scroll frame; finding the header rows and probing for fixed bars means
  // dozens of hit tests, so those run when scrolling ends (or, during a long
  // scroll, a few times a second), and on resize.
  _watchHeaderLayout() {
    let queued = 0; // 0 none, 1 light, 2 full
    let lastFull = 0;
    const FULL_EVERY = 250;
    const run = (full) => {
      const scheduled = queued > 0;
      queued = Math.max(queued, full ? 2 : 1);
      if (scheduled) return; // the pending frame picks up the higher mode
      requestAnimationFrame(() => {
        const mode = queued;
        queued = 0;
        if (!this.visible) return;
        if (mode === 2) {
          lastFull = performance.now();
          this._syncSharedHeaders();
          this._shiftFixedBars();
        }
        this._syncTop();
      });
    };
    window.addEventListener('scroll', () => run(performance.now() - lastFull > FULL_EVERY), { passive: true });
    window.addEventListener('resize', () => run(true));
    // Sticky bars often appear a moment after scrolling stops.
    window.addEventListener('scrollend', () => run(true), { passive: true });
  }

  _applyTheme() {
    for (const name of THEME_TOKENS) this.root.style.removeProperty(name);
    if (this.s.theme !== 'auto') {
      this.root.dataset.theme = this.s.theme;
      return;
    }
    // Match the site: copy the page's live colors (any GitHub or GitLab
    // theme, Dark Reader, userstyles...) onto our tokens.
    const page = getComputedStyle(document.documentElement);
    const read = (...names) => {
      for (const n of names) {
        const v = page.getPropertyValue(n).trim();
        if (v) return v;
      }
      return '';
    };
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const bg = this._rgb(bodyBg)?.[3] > 0 ? bodyBg : read('--bgColor-default', '--color-canvas-default', '--gl-background-color-default', '--ds-surface');
    const fg = getComputedStyle(document.body).color || read('--fgColor-default', '--color-fg-default', '--gl-text-color-default', '--ds-text');
    const rgb = this._rgb(bg);
    if (!rgb) {
      this.root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      return;
    }
    const dark = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128;
    this.root.dataset.theme = dark ? 'dark' : 'light';

    const tokens = {
      '--graph-button-bg': read('--button-default-bgColor-rest', '--gl-button-default-primary-background-color-default'),
      '--graph-button-fg': read('--button-default-fgColor-rest', '--gl-button-default-primary-foreground-color-default'),
      '--graph-button-border': read('--button-default-borderColor-rest', '--gl-button-default-primary-border-color-default'),
      '--graph-button-hover': read('--button-default-bgColor-hover', '--gl-button-default-primary-background-color-hover'),
      '--bg': bg,
      '--fg': fg,
      '--bg-2': read('--bgColor-muted', '--color-canvas-subtle', '--gl-background-color-subtle', '--ds-surface-sunken'),
      '--bg-overlay': read('--overlay-bgColor', '--color-canvas-overlay', '--gl-background-color-overlap', '--ds-surface-overlay'),
      '--shadow-overlay': read('--shadow-floating-small', '--color-overlay-shadow'),
      '--border-muted': read('--borderColor-muted', '--color-border-muted', '--gl-border-color-subtle', '--ds-border'),
      '--shadow-card': read('--shadow-resting-small'),
      '--bg-input': read('--bgColor-inset', '--color-canvas-inset', '--gl-background-color-subtle', '--ds-background-input') || bg,
      '--bg-hover': read('--control-transparent-bgColor-hover', '--color-action-list-item-default-hover-bg', '--gl-action-neutral-background-color-hover', '--ds-background-neutral-subtle-hovered'),
      '--bg-sel': read('--control-transparent-bgColor-selected', '--color-action-list-item-default-selected-bg', '--gl-action-neutral-background-color-active', '--ds-background-selected'),
      '--fg-2': read('--fgColor-muted', '--color-fg-muted', '--gl-text-color-subtle', '--ds-text-subtle'),
      '--border': read('--borderColor-default', '--color-border-default', '--gl-border-color-default', '--ds-border'),
      '--accent': read('--fgColor-accent', '--color-accent-fg', '--gl-text-color-link', '--ds-link'),
      '--accent-2': read('--fgColor-accent', '--color-accent-fg', '--gl-text-color-link', '--ds-link'),
      '--primary': read('--button-primary-bgColor-rest', '--bgColor-success-emphasis', '--color-btn-primary-bg', '--gl-button-confirm-primary-background-color-default', '--ds-background-brand-bold'),
      '--primary-fg': read('--button-primary-fgColor-rest', '--fgColor-onEmphasis', '--color-btn-primary-text', '--gl-button-confirm-primary-foreground-color-default', '--ds-text-inverse'),
      '--add': read('--fgColor-success', '--color-success-fg', '--gl-text-color-success', '--ds-text-success'),
      '--del': read('--fgColor-danger', '--color-danger-fg', '--gl-text-color-danger', '--ds-text-danger'),
      '--mod': read('--fgColor-attention', '--color-attention-fg', '--gl-text-color-warning', '--ds-text-warning'),
      '--ren': read('--fgColor-accent', '--color-accent-fg', '--gl-text-color-link', '--ds-link'),
      '--mark': read('--bgColor-attention-muted', '--color-attention-subtle', '--gl-highlight-target-background-color', '--ds-background-accent-yellow-subtler'),
      '--tab-active': read('--underlineNav-borderColor-active', '--color-primer-border-active', '--gl-tab-selected-indicator-color-default', '--ds-border-selected'),
    };
    // GitLab: the sidebar sits in GitLab's chrome, with its content in a
    // panel like GitLab's own (Pajamas tokens).
    if (HT.provider.id === 'gitlab') {
      Object.assign(tokens, {
        '--page-font': getComputedStyle(document.body).fontFamily,
        '--panel-bg': read('--gl-background-color-default'),
        '--panel-border': dark ? read('--gl-border-color-subtle') : 'transparent',
        '--panel-shadow': read('--gl-shadow-sm'),
        '--section-bg': read('--gl-background-color-section'),
        '--section-border': read('--gl-border-color-section'),
        '--highlight': read('--gl-highlight-target-background-color'),
        '--focus-ring': read('--gl-focus-ring-outer-color'),
      });
    }
    // Bitbucket: Atlassian's tokens for the selection, focus ring and font.
    if ((HT.provider.site || HT.provider.id) === 'bitbucket') {
      Object.assign(tokens, {
        '--page-font': getComputedStyle(document.body).fontFamily,
        '--highlight': read('--ds-background-selected'),
        '--focus-ring': read('--ds-border-focused'),
        '--section-border': read('--ds-border'),
      });
    }
    // GitHub's own ANSI palette for log colors.
    ANSI_NAMES.forEach((name, i) => {
      tokens[`--ansi-${i}`] = read(`--color-ansi-${name}`);
      tokens[`--ansi-${i + 8}`] = read(`--color-ansi-${name}-bright`);
    });
    for (const [name, value] of Object.entries(tokens)) {
      if (value) this.root.style.setProperty(name, value);
    }
    // Derived tokens follow whatever the page gave us.
    this.root.style.setProperty('--fg-3', 'color-mix(in srgb, var(--fg-2) 75%, var(--bg))');
    if (!tokens['--bg-hover']) this.root.style.setProperty('--bg-hover', 'color-mix(in srgb, var(--fg) 8%, var(--bg))');
    if (!tokens['--bg-2']) this.root.style.setProperty('--bg-2', 'color-mix(in srgb, var(--fg) 4%, var(--bg))');
    this._syncTop();
  }

  // An x just inside the page, beside the sidebar.
  _pageX() {
    const { dock, width, docked } = this.s;
    const offset = this.visible && docked ? width : 0;
    const vw = document.documentElement.clientWidth;
    return dock === 'left' ? offset + 3 : vw - offset - 3;
  }

  // GitHub's header: known selectors first, else the widest short element
  // pinned to the top of the page under the probe point.
  _findHeader() {
    // The signed-out marketing banner precedes a separate repository header.
    // Anchor to repository navigation first, so we align with its bottom edge
    // and keep the full sidebar visible until that header has scrolled away.
    for (const nav of document.querySelectorAll('nav[aria-label="Repository"]')) {
      const el = nav.closest('header') || nav;
      const r = el.getBoundingClientRect();
      if (r.height > 30 && r.width > innerWidth / 2) return el;
    }
    for (const el of document.querySelectorAll(GH_HEADER)) {
      const r = el.getBoundingClientRect();
      if (r.height > 30 && r.width > innerWidth / 2) return el;
    }
    if (this._ghHeader?.isConnected) return this._ghHeader;
    if (scrollY > 2) return null;
    let best = null;
    for (const el of document.elementsFromPoint(this._pageX(), 3)) {
      if (el === this.host || el === document.body || el === document.documentElement) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 1 && r.height >= 40 && r.height <= 200 && r.width > innerWidth / 2) {
        if (!best || r.height > best.getBoundingClientRect().height) best = el;
      }
    }
    this._ghHeader = best;
    return best;
  }

  // Resolve any CSS color to [r, g, b, a] via a probe element.
  _rgb(color) {
    if (!color) return null;
    if (!this._probe) {
      this._probe = h('span', { hidden: true });
      this.shadow.append(this._probe);
    }
    this._probe.style.color = '';
    this._probe.style.color = color;
    if (!this._probe.style.color) return null;
    const m = getComputedStyle(this._probe).color.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] == null ? 1 : Number(m[3])];
  }

  _watchTheme() {
    const reapply = HT.debounce(() => this._applyTheme(), 50);
    new MutationObserver(reapply).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-mode', 'data-light-theme', 'data-dark-theme', 'style', 'class'],
    });
    // Theme stylesheets (GitHub's lazy theme CSS, Dark Reader, userstyles) arrive late.
    new MutationObserver(reapply).observe(document.head, { childList: true });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reapply);
    window.addEventListener('load', reapply, { once: true });
  }

  setDocked(docked) {
    this.peeking = false;
    HT.store.set({ docked });
    this._applyLayout();
  }

  toggle() {
    if (this.visible) this.setDocked(!this.s.docked);
  }

  hide() {
    this.visible = false;
    this.navSeq++;
    this._applyLayout();
  }

  _close() {
    if (this.s.docked) this.setDocked(false);
    else {
      this.peeking = false;
      this._applyLayout();
    }
  }

  _peekLeave() {
    clearTimeout(this._peekTimer);
    if (this.s.docked) return;
    this._peekTimer = setTimeout(() => {
      // Stay open while the user is busy in the panel.
      if (this.settingsOpen || this.tabMenu?.isConnected || ([this.main.search, this.second.search].includes(this.shadow.activeElement) && this.shadow.activeElement.value)) return;
      this.peeking = false;
      this._applyLayout();
    }, 350);
  }

  // Esc in a pane: close the log search, then the job, then clear the
  // search; in the main pane, finally tuck an undocked sidebar away.
  _escape(pane = this.main) {
    const tab = this._tabOf(pane);
    if ((tab === 'pulls' || tab === 'issues') && this.lists?.[tab]?.detail) {
      this._closeListItem(tab);
      return;
    }
    if (this.previews?.[tab] && !pane.search.value) {
      this._closePreview(tab);
      return;
    }
    const detail = tab === 'ci' && this.ci?.detail;
    const { search } = pane;
    if (detail && !search.value && detail.searchOpen) {
      detail.searchOpen = false;
      this._rerenderCI(this.ci);
      pane.body.querySelector('.ht-ci-card-actions .ht-btn')?.focus();
    } else if (detail && !search.value) {
      this._closeJob(this.ci);
    } else if (search.value) {
      search.value = '';
      this._filter(pane);
      search.focus();
    } else if (pane.searchOpen) {
      this._toggleSearch(pane);
    } else if (pane === this.second) {
      this.closeSplit();
      this._searchTarget(this.main).focus();
    } else if (pane === this.main && !this.s.docked) {
      this.peeking = false;
      this._applyLayout();
    }
  }

  _startResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = this.s.width;
    const dir = this.s.dock === 'left' ? 1 : -1;
    const html = document.documentElement;
    html.classList.add('hector-resizing');
    this.root.classList.add('resizing');
    const move = (ev) => {
      this.s.width = Math.round(Math.max(200, Math.min(800, startWidth + (ev.clientX - startX) * dir)));
      this._applyLayout();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      html.classList.remove('hector-resizing');
      this.root.classList.remove('resizing');
      HT.store.set({ width: this.s.width });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up, { once: true });
  }

  // One button per pane: collapses when anything is open, otherwise expands
  // everything (folders, CI runs, or a job's steps).
  _toggleExpandAll(pane) {
    const tab = this._tabOf(pane);
    if (tab === 'ci') {
      this._toggleCIExpandAll();
      return;
    }
    const tree = this._treeFor(tab);
    if (!tree) return;
    if (tree.hasExpanded) tree.collapseAll();
    else tree.expandAll();
  }

  _updateExpandBtn() {
    for (const pane of [this.main, this.second]) {
      const tab = this._tabOf(pane);
      const tree = this.previews?.[tab] ? null : this._treeFor(tab);
      const ci = tab === 'ci';
      // Bookmarks have nothing to expand.
      pane.expandBtn.hidden = !tree && !ci;
      if (pane.expandBtn.hidden) continue;
      const collapse = ci ? this._ciHasExpanded() : tree.hasExpanded;
      const what = ci ? (this.ci?.detail ? 'steps' : 'runs') : 'folders';
      const label = `${collapse ? 'Collapse' : 'Expand'} all ${what}`;
      pane.expandBtn.replaceChildren(HT.icon(collapse ? 'collapseAll' : 'expandAll'));
      pane.expandBtn.title = label;
      pane.expandBtn.setAttribute('aria-label', label);
    }
  }

  _openOptions() {
    this.toggleSettings(true);
  }

  toggleSettings(open = !this.settingsOpen) {
    this.settingsOpen = open;
    this.root.classList.toggle('settings-open', open);
    this.settingsBtn.classList.toggle('active', open);
    this.settingsBtn.title = open ? 'Close settings' : 'Settings';
    if (open && !this.s.docked) {
      this.peeking = true;
      this._applyLayout();
    }
    this._renderTabs();
    this.renderBody({ split: false });
  }

  _toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  _onStorageChange(changes, area) {
    if (area === 'sync') {
      let rerender = false;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (!(key in HT.DEFAULTS)) continue;
        this.s[key] = newValue === undefined ? HT.DEFAULTS[key] : newValue;
        if (key === 'compactFolders' || key === 'fileIcons' || key === 'iconPack' || key === 'folderStyle') rerender = true;
        if (key === 'tabOrder' || key === 'hiddenTabs' || key === 'showTabLabels') {
          this._renderTabs();
          this.renderBody();
        }
      }
      this._applyTheme();
      this._applyLayout();
      if (rerender) {
        this.filesTree.render();
        this.changesTree.render();
      }
    }
    // This repository's CI settings changed, or a server was just allowed.
    const ciKey = this.ctx && `ci:${HT.url.repoKey(this.ctx)}`;
    if ((area === 'sync' && ciKey && changes[ciKey]) || (area === 'local' && changes.grantedAt)) {
      HT.ci.forget();
      this.ci = null;
      if (this.tab === 'ci' && !this.settingsOpen) this.renderBody({ split: false });
      if (this.split === 'ci') this._renderSplit();
    }
    // Custom tabs were added, changed or removed.
    if (area === 'sync' && changes.customTabs) {
      this.custom = null;
      this._renderTabs();
      if (!this.settingsOpen) this.renderBody();
    }
    if (area === 'local' && changes.bookmarks) this._loadBookmarks();
    if (area === 'local' && (changes.accounts || changes.tokens)) this._loadAccount();
    if (area === 'local' && changes.tokens) this.refresh();
  }

  // ---------- navigation & data ----------

  async navigate(ctx) {
    const seq = ++this.navSeq;
    this.ctx = ctx;
    this.previews = {};
    // A work item page opens the Dynamic tab (its details and activity),
    // coming from Files or the list; leaving it goes back there.
    const issueKey = ctx.issueNumber ? `${HT.url.repoKey(ctx)}#${ctx.issueNumber}` : null;
    if (issueKey !== this._issueKey) {
      const shown = !(this.s.hiddenTabs || []).includes('info');
      if (issueKey && shown && ['files', 'issues'].includes(this.tab)) {
        this._tabBeforeIssue = this.tab;
        this.tab = 'info';
      } else if (!issueKey && this._tabBeforeIssue && this.tab === 'info') {
        this.tab = this._tabBeforeIssue;
      }
      if (!issueKey) this._tabBeforeIssue = null;
      this._issueKey = issueKey;
    }
    this.visible = true;
    this.ensureAttached();
    this._applyLayout();
    this._applyTheme();

    const key = HT.url.repoKey(ctx);
    if (key !== this.repoKey) {
      this.repoKey = key;
      this.repo = null;
      this.code = null;
      this.pr = null;
      this.ci = null;
      this.main.search.value = '';
      this.second.search.value = '';
      this.filesTree.setRoot(null);
      this.changesTree.setRoot(null);
      this.filesTree.setFilter('');
      this.changesTree.setFilter('');
    }
    this.error = null;
    this._renderHeader();

    try {
      if (!this.repo) {
        this._renderTabs();
        this.renderBody();
        const ck = `repo:${key}`;
        const cached = await HT.cache.get(ck);
        if (seq !== this.navSeq) return;
        if (cached) {
          // Last time's answer now; the real one replaces it when it arrives.
          this.repo = cached;
          HT.provider.repo(ctx).then(
            (fresh) => {
              if (this.repoKey === key && fresh.defaultBranch !== this.repo?.defaultBranch) this.repo = fresh;
              HT.cache.set(ck, fresh);
            },
            (err) => {
              if ([401, 403, 404].includes(err.status)) HT.cache.drop(ck);
            }
          );
        } else {
          this.repo = await HT.provider.repo(ctx);
          if (seq !== this.navSeq) return;
          HT.cache.set(ck, this.repo);
        }
      }

      let ref;
      let path = '';
      if (ctx.kind === 'pull' || ctx.kind === 'commit') {
        if (this.pr?.id !== HT.changeId(ctx)) {
          this._loadPull(ctx);
          // Opening a pull request or commit from a tree tab goes to the tab
          // last used on one (at first, the preferred one); CI/CD, Commits,
          // Branches and Bookmarks stay where the user was.
          if (this.tab === 'files' || this.tab === 'changes') this.tab = this._uiPullTab || this.s.prDefaultTab;
        }
        const info = await this.pr.infoPromise;
        if (seq !== this.navSeq) return;
        if (ctx.kind === 'pull') {
          ref = info.headSha;
          this.refLabel = info.headRef;
        } else {
          ref = info.sha;
          this.refLabel = info.sha.slice(0, 7);
        }
      } else {
        this.pr = null;
        // Back from a pull request: the tab last used on repository pages.
        if (this.tab === 'changes') this.tab = this._uiTab && this._uiTab !== 'changes' ? this._uiTab : 'files';
        // A ref only in ?at= (Bitbucket) still names what's being viewed.
        if (ctx.segments.length || ctx.at) {
          const known = [this.code?.ref, this.repo.defaultBranch];
          ({ ref, path } = await HT.provider.resolveRef(ctx, ctx.segments, known));
          if (seq !== this.navSeq) return;
        } else {
          ref = this.repo.defaultBranch;
        }
        this.refLabel = /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
      }

      this.currentPath = path;
      this._ensureCode(ref);
    } catch (err) {
      if (seq !== this.navSeq) return;
      this.error = err;
    }
    try {
      this._renderHeader();
      this._renderTabs();
      this.renderBody();
    } catch (err) {
      this._renderBroken(err);
    }
  }

  // Drawing failed (most often: the page still runs a mix of an old and a
  // new Hector after an update). Say so instead of leaving the panel blank.
  _renderBroken(err) {
    HT.debug?.note('render', err);
    this.body.replaceChildren(
      h(
        'div',
        { class: 'ht-message' },
        h('strong', null, 'Hector needs this page reloaded'),
        h('p', null, `Something didn't load (${err.message}). This usually follows an update of Hector.`),
        h('div', { class: 'ht-message-actions' }, h('button', { class: 'ht-primary', type: 'button', onClick: () => location.reload() }, 'Reload page'))
      )
    );
  }

  refresh() {
    HT.api.clearMemo();
    HT.ci.forget();
    this.repo = null;
    this.code = null;
    this.pr = null;
    this.ci = null;
    this.commits = null;
    this.branches = null;
    this.custom = null;
    this.lists = null;
    this.itemCache = null;
    this.projInfo = null;
    this.previews = {};
    this._tcHints = null;
    if (this.ctx && this.visible) this.navigate(this.ctx);
  }

  _ensureCode(ref) {
    if (this.code?.ref === ref) return this.code.promise;
    const ctx = this.ctx;
    const ck = `tree:${HT.url.repoKey(ctx)}:${ref}`;
    const state = (this.code = { ref, loading: true });
    const LAZY_NOTICE = 'Large repository: folders load when opened, and search only covers folders you have opened.';
    const apply = ({ entries, complete }, partial = false) => {
      state.root = HT.buildTree(entries, { complete });
      state.lazy = !complete;
      // A partial listing is only a stand-in until the full one arrives.
      state.notice = complete || partial ? null : LAZY_NOTICE;
      state.count = complete ? entries.filter((e) => e.type === 'blob').length : null;
    };
    const showTop = (top) => {
      if (this.code !== state || state.root) return; // something better is already showing
      apply(top, true);
      state.partial = true;
      state.loading = false;
      this.renderBody();
      this._renderStats();
    };
    // Cheap fingerprint: same paths and hashes means nothing to redraw. It is
    // only needed when there is a cached listing to compare with, and is kept
    // on the listing (and so in the cache) so each one is hashed once.
    const fingerprint = (listing) => {
      if (listing.fp == null) {
        let h = listing.entries.length;
        for (const e of listing.entries) for (const ch of `${e.path}${e.sha || ''}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
        listing.fp = h;
      }
      return listing.fp;
    };
    state.promise = (async () => {
      const cached = await HT.cache.get(ck);
      if (cached && this.code === state) {
        apply(cached);
        state.loading = false;
        this.renderBody();
        this._renderStats();
      }
      try {
        const fresh = await HT.provider.tree(ctx, ref, showTop, { huge: (this.repo?.sizeKb || 0) > 3000000 });
        // A lazy tree somebody has already started opening stays: swapping it
        // for an equivalent one would throw away the folders they loaded.
        const inUse = !fresh.complete && state.root && state.lazy && (state.partial || this.filesTree.expanded.size > 0);
        if (inUse) {
          if (state.partial) {
            state.partial = false;
            state.notice = LAZY_NOTICE;
          }
        } else if (!cached || fingerprint(cached) !== fingerprint(fresh)) {
          // A complete tree arriving over a lazy one keeps the folders already open.
          if (state.root && state.lazy && fresh.complete) state.upgraded = true;
          if (this.code === state) apply(fresh);
          state.error = null;
        }
        HT.cache.set(ck, fresh);
      } catch (err) {
        // Don't keep showing what a failed sign-in can no longer see.
        if (!cached || [401, 403, 404].includes(err.status)) {
          state.error = err;
          state.root = null;
          HT.cache.drop(ck);
        }
      }
      state.loading = false;
      if (this.code === state) {
        this.renderBody();
        this._renderStats();
      }
    })();
    return state.promise;
  }

  async _loadChildren(node) {
    const entries = await HT.provider.children(this.ctx, this.code.ref, node);
    node.children = entries.map((e) => HT.makeNode(e.name, `${node.path}/${e.name}`, e.type, { sha: e.sha, size: e.size }));
    HT.sortTree(node);
    node.loaded = true;
  }

  // The Changes tab's change set: a pull request, or a single commit.
  _loadPull(ctx) {
    const { pullNumber } = ctx;
    const commit = ctx.kind === 'commit';
    const state = (this.pr = { id: HT.changeId(ctx), number: commit ? null : pullNumber, sha: commit ? ctx.sha : null, loading: true });
    state.infoPromise = commit ? HT.provider.commitInfo(ctx, ctx.sha) : HT.provider.pull(ctx, pullNumber);
    state.promise = (async () => {
      try {
        state.info = await state.infoPromise;
        if (commit) state.sha = state.info.sha;
        const files = commit
          ? await HT.provider.commitFiles(ctx, state.sha)
          : await HT.provider.pullFiles(ctx, pullNumber, state.info.changedFiles ?? Infinity);
        state.root = HT.buildTree(files.map((f) => ({ ...f, type: 'blob' })));
        state.count = files.length;
        if (state.info.changedFiles > files.length) {
          state.notice = `${HT.provider.name}'s API returns only the first ${files.length} of ${state.info.changedFiles} changed files.`;
        }
      } catch (err) {
        state.error = err;
      }
      state.loading = false;
      if (this.pr === state) {
        this._renderHeader();
        this._renderTabs();
        this.renderBody();
        this._renderStats();
      }
    })();
    state.infoPromise.catch(() => {});
  }

  // ---------- links ----------

  _base() {
    return HT.provider.base(this.ctx);
  }

  _codeLink(node) {
    if (!this.code) return null;
    if (node.type === 'commit') return null;
    return HT.provider.codeUrl(this.ctx, this.code.ref, node.path, node.type === 'tree');
  }

  _diffLink(node) {
    if (this.pr.sha) return HT.provider.commitDiffUrl(this.ctx, this.pr.sha, node.anchor);
    return HT.provider.diffUrl(this.ctx, this.pr.number, node.anchor);
  }

  // On the PR's (or commit's) diff page, scroll in place instead of reloading.
  _openDiff(node) {
    if (!(this.pr.sha ? HT.provider.onCommitPage(this.pr.sha) : HT.provider.onDiffPage(this.pr.number))) return false;
    const path = CSS.escape(node.path);
    const target = document.getElementById(node.anchor) || document.querySelector(`[data-tagsearch-path="${path}"], .diff-file[data-path="${path}"]`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -72);
      history.replaceState(history.state, '', `#${node.anchor}`);
    } else {
      location.hash = node.anchor;
    }
    return true;
  }

  // ---------- rendering ----------

  _activeTree() {
    return this._treeFor(this.tab);
  }


  _renderHeader() {
    if (!this.ctx) return;
    this._renderStats();
    this._updateStar();
  }

  // Built-in tabs: [id, icon, label]. 'changes' only exists on pull requests
  // and commits;
  // Settings is not a tab: the footer gear covers the sidebar with it.
  _tabDefs() {
    const n = this.pr?.info?.changedFiles ?? this.pr?.count;
    return [
      // What this page is about: a work item's or merge request's details
      // and activity, or the project's information.
      ['info', 'circle', 'Dynamic'],
      ['changes', 'diff', n != null ? `Changes ${HT.formatCount(n)}` : 'Changes'],
      ['files', 'files', 'Files'],
      ['commits', 'commit', 'Commits'],
      ['branches', 'branch', 'Branches'],
      ...(HT.provider.pulls ? [['pulls', 'pull', this._listName('pulls')]] : []),
      ...(HT.provider.issues ? [['issues', 'issue', this._listName('issues')]] : []),
      ['ci', 'actions', 'CI/CD'],
      ['bookmarks', 'bookmark', this.bookmarks.length ? `Bookmarks ${this.bookmarks.length}` : 'Bookmarks'],
      // The user's own tabs for this site.
      ...(HT.customTabs?.forSite(HT.provider.site || HT.provider.id) || []).map((t) => [t.id, t.icon, t.name]),
    ];
  }

  _sortTabs(defs) {
    // Tabs added since the order was saved go at the end (an old saved order
    // may still list 'settings', which is not a tab any more).
    const order = [...(this.s.tabOrder || HT.DEFAULTS.tabOrder)];
    for (const id of HT.DEFAULTS.tabOrder) if (!order.includes(id)) order.push(id);
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
    return defs.sort((a, b) => rank(a[0]) - rank(b[0]));
  }

  // Tabs turned on in the + menu that can show on this page.
  _shownTabs() {
    const hidden = this.s.hiddenTabs || [];
    return this._tabDefs().filter(([id]) => !hidden.includes(id) && (id !== 'changes' || this.ctx?.kind === 'pull' || this.ctx?.kind === 'commit'));
  }

  _renderTabs() {
    let tabs = this._shownTabs();
    if (!tabs.length) tabs = this._tabDefs().filter(([id]) => id === 'files');
    if (!tabs.some(([id]) => id === this.tab)) this.tab = tabs[0][0];
    const active = this.tab;
    // A split tab that can't show here any more (hidden, or Changes off a
    // pull request) closes the split.
    if (this.split && (this.split === this.tab || !tabs.some(([id]) => id === this.split))) {
      this.split = null;
      this.second.body.replaceChildren();
      this._renderSplit();
    }
    const menuOpen = Boolean(this.tabMenu?.isConnected);
    const ciDot = this._ciBadge();
    // The buttons are rebuilt: keep keyboard focus on the tab row if it was there.
    const focused = (this.tabsEl.contains(this.shadow.activeElement) && this.shadow.activeElement.dataset.tab) || null;
    this.tabsEl.replaceChildren(
      ...this._sortTabs(tabs).map(([id, icon, label]) =>
        h(
          'button',
          {
            class: `ht-tab${active === id ? ' active' : ''}${this.split === id ? ' split' : ''}`,
            type: 'button',
            role: 'tab',
            id: `ht-tab-${id}`,
            title:
              (id === 'ci' && ciDot ? `${label} · ${ciDot === 'running' ? 'something is running' : 'the latest run failed'}\n` : '') +
              (id === 'settings' ? label : this.split === id ? `${label} (shown below; hold or Shift+click to close)` : `${label} (hold, Shift+click or middle-click to show below)`),
            'aria-label': label,
            'aria-selected': String(active === id),
            'aria-controls': id === 'settings' ? null : this.split === id ? 'ht-panel-second' : 'ht-panel-main',
            tabindex: active === id ? '0' : '-1',
            dataset: { tab: id },
            onPointerdown: (e) => this._holdTab(e, id),
            onContextmenu: (e) => e.preventDefault(),
            onMousedown: (e) => e.button === 1 && e.preventDefault(), // no autoscroll on middle-click
            onAuxclick: (e) => {
              if (e.button === 1 && id !== 'settings') this.toggleSplit(id);
            },
            onClick: (e) => {
              if (this._held) this._held = false;
              else if (e.shiftKey) this.toggleSplit(id);
              else this.setTab(id);
            },
          },
          h('span', { class: 'ht-tab-inner' }, HT.icon(icon), h('span', { class: 'ht-tab-label' }, label)),
          id === 'ci' && ciDot ? h('span', { class: `ht-tab-dot ${ciDot}`, 'aria-hidden': 'true' }) : null
        )
      ),
      h(
        'button',
        {
          class: 'ht-tab ht-tab-add',
          type: 'button',
          title: 'Show, hide or reorder tabs',
          'aria-label': 'Show, hide or reorder tabs',
          'aria-haspopup': 'menu',
          'aria-expanded': String(menuOpen),
          onClick: (e) => {
            e.stopPropagation();
            this._toggleTabMenu();
          },
        },
        h('span', { class: 'ht-tab-inner' }, HT.icon('plus'))
      )
    );
    if (focused) (this.tabsEl.querySelector(`.ht-tab[data-tab="${CSS.escape(focused)}"]`) || this.tabsEl.querySelector('.ht-tab'))?.focus({ preventScroll: true });
    this.main.body.id = 'ht-panel-main';
    this.main.body.setAttribute('aria-labelledby', `ht-tab-${this.tab}`);
    this.second.body.id = 'ht-panel-second';
    if (this.split) this.second.body.setAttribute('aria-labelledby', `ht-tab-${this.split}`);
  }

  // A dot on the CI/CD tab while something runs for what is being viewed, or
  // when the newest run failed (from what the tab has loaded).
  _ciBadge() {
    const state = this.ci;
    if (!state || !this.repo || state.key !== this._ciTarget()?.key) return null;
    const newest = [state.runs?.[0], ...(state.ext || []).map((s) => s.builds?.[0]), state.other?.[0]].filter(Boolean);
    if (!newest.length) return null;
    if (newest.some((r) => r.status !== 'completed')) return 'running';
    if (newest.some((r) => ['failure', 'timed_out', 'error', 'startup_failure'].includes(r.conclusion))) return 'fail';
    return null;
  }

  // Move tab `from` before or after tab `to`; the order is saved in settings.
  _moveTab(from, to, after) {
    if (!from || from === to) return;
    const order = [...(this.s.tabOrder || HT.DEFAULTS.tabOrder)];
    for (const id of HT.DEFAULTS.tabOrder) if (!order.includes(id)) order.push(id);
    order.splice(order.indexOf(from), 1);
    order.splice(order.indexOf(to) + (after ? 1 : 0), 0, from);
    HT.store.set({ tabOrder: order });
    this._renderTabs();
  }

  // A GitHub-style action menu: one checkable row per tab, dragged (or
  // Alt+↑/↓) to reorder. Rows update in place, so the menu doesn't flash.
  _toggleTabMenu(open = !this.tabMenu?.isConnected) {
    const addBtn = this.tabsEl.querySelector('.ht-tab-add');
    if (!open) {
      if (!this.tabMenu?.isConnected) return;
      const hadFocus = this.tabMenu.contains(this.shadow.activeElement);
      this.tabMenu.remove();
      addBtn?.setAttribute('aria-expanded', 'false');
      if (hadFocus) addBtn?.focus();
      return;
    }
    const labels = { changes: 'Changes', files: 'Files', commits: 'Commits', branches: 'Branches', ci: 'CI/CD', bookmarks: 'Bookmarks', settings: 'Settings' };
    // Rows are divs: Firefox never starts a drag on a <button>.
    const items = this._sortTabs(this._tabDefs()).map(([id, icon, name]) =>
      h(
        'div',
        {
          class: 'ht-menu-item',
          tabindex: '-1',
          role: 'menuitemcheckbox',
          draggable: 'true',
          dataset: { tab: id },
          onClick: () => {
            const hidden = this.s.hiddenTabs || [];
            const on = !hidden.includes(id);
            // Keep at least one tab with content that can show on this page.
            const usable = this._shownTabs().filter(([t]) => t !== id && t !== 'settings');
            if (on && id !== 'settings' && !usable.length) return;
            HT.store.set({ hiddenTabs: on ? [...hidden, id] : hidden.filter((t) => t !== id) });
            this._renderTabs();
            this.renderBody();
            sync();
          },
        },
        h('span', { class: 'ht-menu-check' }, HT.icon('check')),
        HT.icon(icon),
        h('span', { class: 'ht-menu-label' }, labels[id] || name),
        id === 'changes' ? h('span', { class: 'ht-menu-desc' }, 'Pull requests') : null,
        h('span', { class: 'ht-menu-grip', 'aria-hidden': 'true' }, HT.icon('grabber'))
      )
    );
    const sync = () => {
      const hidden = this.s.hiddenTabs || [];
      for (const item of items) item.setAttribute('aria-checked', String(!hidden.includes(item.dataset.tab)));
    };
    sync();
    const divider = h('div', { class: 'ht-menu-divider', role: 'separator' });
    // Put the rows back in saved order after a move.
    const reorder = (focus) => {
      const ids = this._sortTabs(this._tabDefs()).map(([id]) => id);
      items.sort((a, b) => ids.indexOf(a.dataset.tab) - ids.indexOf(b.dataset.tab));
      for (const item of items) this.tabMenu.insertBefore(item, divider);
      focus?.focus();
    };
    const clearDrop = () => items.forEach((i) => i.classList.remove('drop-before', 'drop-after'));
    for (const item of items) {
      item.addEventListener('dragstart', (e) => {
        this._dragTab = item.dataset.tab;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this._dragTab);
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        clearDrop();
        this._dragTab = null;
      });
      item.addEventListener('dragover', (e) => {
        if (!this._dragTab || this._dragTab === item.dataset.tab) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = item.getBoundingClientRect();
        clearDrop();
        item.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = item.classList.contains('drop-after');
        clearDrop();
        this._moveTab(this._dragTab, item.dataset.tab, after);
        reorder();
      });
      item.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        e.stopPropagation();
        const i = items.indexOf(item);
        const to = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (!to) return;
        this._moveTab(item.dataset.tab, to.dataset.tab, e.key === 'ArrowDown');
        reorder(item);
      });
    }
    this.tabMenu = h(
      'div',
      { class: 'ht-menu', role: 'menu', 'aria-label': 'Tabs', onClick: (e) => e.stopPropagation(), onKeydown: (e) => this._menuKey(e, items) },
      h('div', { class: 'ht-menu-title' }, 'Tabs'),
      items,
      divider,
      h(
        'button',
        {
          class: 'ht-menu-item ht-menu-action',
          type: 'button',
          role: 'menuitem',
          onClick: () => {
            this._toggleTabMenu(false);
            this._openCustomTabs = true;
            this.toggleSettings(true);
          },
        },
        HT.icon('plus'),
        h('span', { class: 'ht-menu-label' }, 'New custom tab…')
      ),
      h('div', { class: 'ht-menu-note' }, 'Drag to reorder, or Alt+↑/↓.')
    );
    const panelRect = this.panel.getBoundingClientRect();
    const r = addBtn.getBoundingClientRect();
    this.tabMenu.style.top = `${r.bottom - panelRect.top + 4}px`;
    this.tabMenu.style.left = `${Math.max(8, Math.min(r.left - panelRect.left, panelRect.width - 200))}px`;
    this.panel.append(this.tabMenu);
    addBtn.setAttribute('aria-expanded', 'true');
    items[0]?.focus({ preventScroll: true });
    if (!this._menuCloser) {
      this._menuCloser = () => this._toggleTabMenu(false);
      this.shadow.addEventListener('click', this._menuCloser);
      document.addEventListener('click', this._menuCloser);
    }
  }

  _menuKey(e, items) {
    const i = items.indexOf(this.shadow.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._toggleTabMenu(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && i > -1) {
      e.preventDefault();
      items[i].click();
    } else if (e.key === 'Tab') {
      this._toggleTabMenu(false);
    }
  }

  setTab(tab) {
    if (tab === 'settings') {
      this.toggleSettings(true);
      return;
    }
    const { main, second } = this;
    // Clicking the tab shown below swaps the two panes.
    if (tab === this.split) {
      this.split = this.tab;
      [main.search.value, second.search.value] = [second.search.value, main.search.value];
      [main.scrolls, second.scrolls] = [second.scrolls, main.scrolls];
      [main.queries, second.queries] = [second.queries, main.queries];
      [main.searchOpen, second.searchOpen] = [second.searchOpen, main.searchOpen];
    } else if (tab !== this.tab) {
      // Leaving a tab: keep where it was scrolled to and what was typed, and
      // bring back the new tab's own.
      main.scrolls[this.tab] = main.body.scrollTop;
      main.queries[this.tab] = main.search.value;
      main.search.value = main.queries[tab] || '';
      main.searchOpen = false;
    }
    const restore = main.scrolls[tab] || 0;
    this.tab = tab;
    this._saveState();
    if (this.settingsOpen) {
      this.toggleSettings(false);
      this._renderSplit();
      this._renderStats();
    } else {
      this._renderTabs();
      this.renderBody();
      this._renderStats();
    }
    // Trees reveal the current file themselves; the other tabs come back
    // where they were left.
    if (!this._treeFor(tab)) main.body.scrollTop = restore;
  }

  // Hold a tab to show it below the current one; hold it again to close.
  toggleSplit(tab) {
    if (tab === 'settings') return;
    if (tab === this.split) {
      this.closeSplit();
      return;
    }
    if (tab === this.tab) {
      this._toast('Hold another tab to show it below this one');
      return;
    }
    this.split = tab;
    this.second.search.value = '';
    this.second.body.scrollTop = 0;
    this._saveState();
    this._renderTabs();
    this._renderSplit();
    this._updateExpandBtn();
  }

  closeSplit() {
    this.split = null;
    this.second.search.value = '';
    this.second.body.replaceChildren();
    this._saveState();
    this._renderTabs();
    this._renderSplit();
  }

  _holdTab(e, tab) {
    this._held = false;
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const { clientX: x, clientY: y } = e;
    const stop = () => {
      clearTimeout(timer);
      el.classList.remove('holding');
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointerleave', stop);
      el.removeEventListener('pointermove', move);
    };
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x, ev.clientY - y) > 6) stop();
    };
    const timer = setTimeout(() => {
      stop();
      this._held = true; // the click that ends this press shouldn't switch tabs
      this.toggleSplit(tab);
    }, 450);
    el.classList.add('holding');
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('pointermove', move);
  }

  // Hold the gap between the two panes to resize them.
  _startSplitResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = this.stack.getBoundingClientRect();
    const pos = this.s.splitPos;
    this.root.classList.add('resizing');
    const move = (ev) => {
      const pct =
        pos === 'bottom' ? ((box.bottom - ev.clientY) / box.height) * 100
        : pos === 'top' ? ((ev.clientY - box.top) / box.height) * 100
        : pos === 'right' ? ((box.right - ev.clientX) / box.width) * 100
        : ((ev.clientX - box.left) / box.width) * 100;
      this.s.splitSize = Math.round(Math.max(15, Math.min(80, pct)));
      this.root.style.setProperty('--ht-split', `${this.s.splitSize}%`);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      this.root.classList.remove('resizing');
      HT.store.set({ splitSize: this.s.splitSize });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up, { once: true });
  }

  // Drag the edge toggle's grip up or down; a click without a drag opens.
  _startToggleMove(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const start = e.clientY;
    const offset = start - this.toggleBtn.getBoundingClientRect().top;
    let moved = false;
    let y = 0;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientY - start) < 3) return;
      moved = true;
      this.root.classList.add('moving-toggle');
      y = Math.round(Math.min(Math.max(ev.clientY - offset, 0), innerHeight - this.toggleBtn.offsetHeight));
      this.root.style.setProperty('--ht-toggle-y', `${y}px`);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      this.root.classList.remove('moving-toggle');
      if (!moved) this.setDocked(true);
      else HT.store.set({ toggleY: y });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  }

  // Drag the grip to move the split pane to the top, bottom, left or right.
  _startSplitMove(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = this.stack.getBoundingClientRect();
    this.root.classList.add('moving');
    const move = (ev) => {
      const x = (ev.clientX - box.left) / box.width;
      const y = (ev.clientY - box.top) / box.height;
      const edges = { left: x, right: 1 - x, top: y, bottom: 1 - y };
      const [pos, near] = Object.entries(edges).sort((a, b) => a[1] - b[1])[0];
      if (near > 0.3 || pos === this.s.splitPos) return;
      this.s.splitPos = pos;
      this.stack.dataset.split = pos;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      this.root.classList.remove('moving');
      HT.store.set({ splitPos: this.s.splitPos });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up, { once: true });
  }

  // Render the top pane, and (unless told not to) the split pane.
  renderBody({ split = true } = {}) {
    if (split) this._renderSplit();
    if (this.settingsOpen) {
      // Keep an open settings panel (and its inputs/status) across data refreshes.
      if (!this.body.querySelector('.ht-settings')) {
        this.body.replaceChildren();
        try {
          this._renderSettings();
        } catch (err) {
          this._renderBroken(err);
        }
      }
      return;
    }
    this._renderPane(this.main);
  }

  // The split pane: the held tab, drawn by the same code as the main pane
  // (this.pane/this.body/this.tab point at it meanwhile).
  _renderSplit() {
    this.second.el.hidden = !this.split;
    this.splitGap.hidden = !this.split;
    this.root.classList.toggle('split', Boolean(this.split));
    if (!this.split) return;
    const def = this._tabDefs().find(([id]) => id === this.split);
    this.splitTitle.replaceChildren(HT.icon(def[1]), h('span', null, def[2]));
    const keep = { pane: this.pane, body: this.body, tab: this.tab };
    const scroll = this.second.body.scrollTop;
    Object.assign(this, { pane: this.second, body: this.second.body, tab: this.split });
    try {
      this._renderPane(this.second);
    } finally {
      Object.assign(this, keep);
    }
    this.second.body.scrollTop = scroll;
  }

  // Draw a pane's tab. The job view hides the pane's search bar and moves
  // its search box into the job card; any other view puts it back.
  _renderPane(pane) {
    const jobView = this.tab === 'ci' && Boolean(this.ci?.detail);
    // The CI list adds its own controls to the search bar again.
    pane.tools?.remove();
    pane.menu?.remove();
    // Lists of pull/merge requests and issues keep their search box in their
    // own header, like the site's list page.
    const listView = this.tab === 'pulls' || this.tab === 'issues';
    pane.el.classList.toggle('ci-job', jobView);
    // The Dynamic tab is for reading; its few controls sit in its own header.
    pane.el.classList.toggle('no-bar', this.tab === 'info' || listView);
    // Redrawing moves the search box; remember if it was being typed in.
    pane.typing = this.shadow.activeElement === pane.search ? [pane.search.selectionStart, pane.search.selectionEnd] : null;
    if (!jobView && !listView && pane.search.parentElement !== pane.bar) pane.bar.insertBefore(pane.search, pane.searchBtn);
    pane.search.placeholder = this._placeholder();
    this._syncSearch(pane);
    pane.body.replaceChildren();
    // A preview's head sticks to the very top of the pane.
    pane.body.classList.toggle('previewing', Boolean(this.previews?.[this.tab] && this._treeFor(this.tab)));
    this._renderContent();
    this._updateExpandBtn();
  }

  _placeholder() {
    const preview = this.previews?.[this.tab];
    if (preview) return `Search ${preview.node.name}…`;
    if (this.tab === 'pulls' || this.tab === 'issues') return 'Search or filter results…';
    if (this.tab === 'info') return this._dynTarget() ? 'Filter activity…' : 'Filter…';
    const custom = HT.customTabs.isCustom(this.tab) && HT.customTabs.list().find((t) => t.id === this.tab);
    if (custom) return custom.type === 'file' ? `Search ${custom.path}…` : `Filter ${custom.name}…`;
    return { bookmarks: 'Filter bookmarks…', ci: this.ci?.detail ? 'Search logs…' : `Filter ${HT.provider.terms.noRuns}…`, commits: 'Filter commits…', branches: 'Filter branches…' }[this.tab] || 'Go to file…';
  }

  // The search box of the pane showing CI.
  _ciSearch() {
    return this._paneOf('ci').search;
  }

  // Typing in a pane's search: trees filter in place; other tabs redraw.
  _filter(pane) {
    const tab = this._tabOf(pane);
    const tree = this.previews?.[tab] ? null : this._treeFor(tab);
    if (tree) tree.setFilter(pane.search.value);
    else if (pane === this.second) this._renderSplit();
    else this.renderBody({ split: false });
  }

  _onSearchKey(e, pane) {
    const tab = this._tabOf(pane);
    const tree = this.previews?.[tab] ? null : this._treeFor(tab);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (tree) tree.focusFirst();
      else pane.body.querySelector('.ht-row')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pane.body.querySelector('.ht-row')?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._escape(pane);
    }
  }

  // The search text of the pane being drawn.
  _query() {
    return this.pane.search.value;
  }

  // Redraw the pane(s) showing a tab.
  _refreshTab(tab) {
    if (tab === this.tab) this.renderBody({ split: false });
    if (tab === this.split) this._renderSplit();
  }

  _renderContent() {
    if (HT.customTabs.isCustom(this.tab)) {
      const def = HT.customTabs.list().find((t) => t.id === this.tab);
      if (def) this._renderCustomTab(def);
      return;
    }
    if (this.tab === 'bookmarks') {
      this._renderBookmarks();
      return;
    }
    if (this.tab === 'ci') {
      this._renderCI();
      return;
    }
    if (this.tab === 'commits') {
      this._renderCommits();
      return;
    }
    if (this.tab === 'branches') {
      this._renderBranches();
      return;
    }
    if (this.tab === 'pulls' || this.tab === 'issues') {
      this._renderList(this.tab);
      return;
    }
    if (this.tab === 'info') {
      this._renderDynamic();
      return;
    }
    if (this.error) {
      this._renderError(this.error);
      return;
    }
    const state = this.tab === 'changes' ? this.pr : this.code;
    const tree = this._activeTree();
    if (this.previews?.[this.tab]) {
      this._renderPreview(this.tab, this.previews[this.tab]);
      return;
    }
    if (!state || state.loading) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading tree…'));
      return;
    }
    if (state.error) {
      this._renderError(state.error);
      return;
    }
    if (state.notice && !state.noticeDismissed && !this.s.hideNotices) {
      const notice = h(
        'div',
        { class: 'ht-notice' },
        h('span', null, state.notice),
        h(
          'span',
          { class: 'ht-notice-actions' },
          h(
            'button',
            { class: 'ht-link', type: 'button', onClick: () => HT.store.set({ hideNotices: true }).then(() => notice.remove()) },
            "Don't show again"
          ),
          this._btn('close', 'Dismiss', () => {
            state.noticeDismissed = true;
            notice.remove();
          })
        )
      );
      this.body.append(notice);
    }
    this.body.append(tree.el);
    if (tree.root !== state.root) {
      tree.setRoot(state.root, { keepOpen: Boolean(state.upgraded) });
      if (this.tab === 'changes') {
        const walk = (n) => n.children?.forEach((c) => c.type === 'tree' && (tree.expanded.add(c.path), walk(c)));
        walk(state.root);
      }
    }
    if (tree.filterText !== this._query().trim()) tree.setFilter(this._query());
    if (this.tab === 'files') {
      tree.reveal(this.currentPath).catch((err) => this._toast(err.message));
    } else {
      tree.render();
    }
  }

  // ---------- file and diff preview ----------

  // A file clicked in Files shows its text here, one in Changes its diff;
  // ⌘/Ctrl-click (or Open) still opens the page. Off in Settings, files open.
  _openPreview(tab, node) {
    if (!this.s.previewFiles || node.type !== 'blob' || !this.ctx) return false;
    const pane = this._paneOf(tab);
    this.previews ||= {};
    this._treeScroll ||= {};
    this._treeScroll[tab] = pane.body.scrollTop;
    const st = { node, loading: true };
    this.previews[tab] = st;
    pane.search.value = '';
    pane.searchOpen = false;
    this._refreshTab(tab);
    pane.body.scrollTop = 0;
    this._loadPreview(tab, st);
    return true;
  }

  _closePreview(tab) {
    if (!this.previews?.[tab]) return;
    const pane = this._paneOf(tab);
    delete this.previews[tab];
    pane.search.value = '';
    pane.searchOpen = false;
    this._refreshTab(tab);
    pane.body.scrollTop = this._treeScroll?.[tab] || 0;
    pane.body.querySelector('.ht-row.selected')?.focus({ preventScroll: true });
  }

  async _loadPreview(tab, st) {
    const { node } = st;
    try {
      if (tab === 'changes') {
        const pr = this.pr;
        pr.patchTarget ||= pr.sha ? { sha: pr.sha } : { pull: pr.number };
        const patch = await HT.provider.filePatch(this.ctx, pr.patchTarget, node);
        st.rows = HT.parsePatch(patch);
      } else {
        const text = await HT.provider.repoFile(this.ctx, this.code.ref, node.path);
        if (text == null) st.error = 'This file has no text to show.';
        else if (/\u0000/.test(text.slice(0, 8000))) st.binary = true;
        else st.lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
      }
    } catch (err) {
      st.error = err.status === 404 ? 'Not found at this version.' : err.message;
      HT.debug?.note('preview', err);
    }
    st.loading = false;
    if (this.previews?.[tab] === st) this._refreshTab(tab);
  }

  _renderPreview(tab, st) {
    const { node } = st;
    const diff = tab === 'changes';
    const href = HT.safeUrl(diff ? this._diffLink(node) : this._codeLink(node));
    const open = h(
      'a',
      {
        class: 'ht-btn',
        href,
        title: diff ? 'Open the diff on the page' : 'Open the file on the page',
        'aria-label': 'Open on the page',
        onClick: (e) => {
          if (diff && !e.metaKey && !e.ctrlKey && this._openDiff(node)) e.preventDefault();
        },
      },
      HT.icon('external')
    );
    const copy = this._btn('copy', 'Copy path', async () => this._toast((await HT.copyText(node.path)) ? `Copied ${node.path}` : 'Copy failed'));
    const stat = diff && (node.additions || node.deletions) ? h('span', { class: 'ht-preview-stat' }, h('span', { class: 'ht-add' }, `+${node.additions || 0}`), h('span', { class: 'ht-del' }, `−${node.deletions || 0}`)) : null;
    this.body.append(
      h(
        'div',
        { class: 'ht-preview-head' },
        this._btn('chevron', diff ? 'Back to the changes (Esc)' : 'Back to the files (Esc)', () => this._closePreview(tab), { class: 'ht-btn ht-back' }),
        h('span', { class: 'ht-icon' }, HT.nodeIcon(node, false, this.s.iconPack, this.s.fileIcons)),
        h('span', { class: 'ht-preview-name', title: node.previous ? `${node.previous} → ${node.path}` : node.path }, node.name, h('span', { class: 'ht-dir' }, node.path.slice(0, -node.name.length).replace(/\/$/, ''))),
        stat,
        copy,
        open
      )
    );
    if (st.loading) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), diff ? 'Loading the diff…' : 'Loading the file…'));
      return;
    }
    if (st.error || st.binary) {
      this.body.append(h('div', { class: 'ht-empty' }, st.binary ? 'A binary file. ' : `${st.error} `, href ? h('a', { class: 'ht-link', href }, 'Open it on the page') : null));
      return;
    }
    const q = this._query().trim().toLowerCase();
    const LIMIT = 5000;
    const view = h('div', { class: `ht-file-view ht-preview-view${diff ? ' ht-diff' : ''}`, role: 'document' });
    let shown = 0;
    let more = 0;
    // Colored once per file, in order, so comments and strings spanning lines keep their color.
    const lang = HT.highlight?.forFile(node.name);
    st.tokens ||= lang ? HT.highlight.lines(diff ? st.rows.map((r) => (r.kind === 'hunk' ? '' : r.text)) : st.lines, lang) : [];
    const line = (cls, nums, text, tokens) => {
      if (shown >= LIMIT) return more++;
      shown++;
      const body = text && tokens ? HT.highlight.nodes(tokens) : text || ' ';
      view.append(h('div', { class: `ht-file-line${cls ? ` ${cls}` : ''}` }, ...nums.map((n) => h('span', { class: 'ht-file-no' }, n == null ? '' : String(n))), h('span', { class: 'ht-file-text' }, body)));
    };
    if (diff) {
      if (!st.rows.length) {
        const why = node.status === 'renamed' ? 'Renamed, with no changes inside.' : 'No diff to show here (a binary file, or one too large).';
        this.body.append(h('div', { class: 'ht-empty' }, `${why} `, href ? h('a', { class: 'ht-link', href }, 'Open it on the page') : null));
        return;
      }
      st.rows.forEach((r, i) => {
        if (q && (r.kind === 'hunk' || !r.text.toLowerCase().includes(q))) return;
        if (r.kind === 'hunk') line('ht-diff-hunk', [null, null], r.text);
        else line(`ht-diff-${r.kind}`, [r.old, r.new], r.text, st.tokens[i]);
      });
    } else {
      st.lines.forEach((text, i) => {
        if (!q || text.toLowerCase().includes(q)) line('', [i + 1], text, st.tokens[i]);
      });
    }
    if (!shown) view.append(h('div', { class: 'ht-empty' }, q ? `No lines match “${q}”` : 'Empty file.'));
    this.body.append(view);
    if (more) this.body.append(h('div', { class: 'ht-empty' }, `${more.toLocaleString()} more lines. `, href ? h('a', { class: 'ht-link', href }, 'Open it on the page') : null));
  }

  // ---------- the Dynamic tab ----------

  // The work item or merge request this page shows, if any.
  _dynTarget() {
    const ctx = this.ctx;
    if (!ctx || !HT.provider.item) return null;
    if (ctx.issueNumber) return { kind: 'issue', n: ctx.issueNumber };
    if (ctx.kind === 'pull') return { kind: 'pull', n: ctx.pullNumber };
    return null;
  }

  _renderDynamic() {
    const target = this._dynTarget();
    if (target) return this._renderDynItem(target);
    if (HT.provider.projectInfo) return this._renderProject();
    this.body.append(h('div', { class: 'ht-empty' }, 'Open a repository page to see its information here.'));
  }

  // One work item's or merge request's details and activity, loaded once
  // and shared by the Dynamic tab and the lists' in-sidebar view.
  _itemState(target, tab) {
    this.itemCache ||= new Map();
    const key = `${this.repoKey}|${target.kind}|${target.n}`;
    let st = this.itemCache.get(key);
    if (!st) {
      st = { key, loading: true, tabs: new Set() };
      this.itemCache.set(key, st);
      Promise.all([HT.provider.item(this.ctx, target.kind, target.n), HT.provider.activity(this.ctx, target.kind, target.n).catch((err) => ((st.activityError = err), []))])
        .then(
          ([item, activity]) => Object.assign(st, { item, activity, loading: false }),
          (err) => Object.assign(st, { error: err, loading: false })
        )
        .then(() => this.itemCache?.get(key) === st && st.tabs.forEach((t) => this._refreshTab(t)));
    }
    st.tabs.add(tab);
    return st;
  }

  // `tab` is the tab drawing it; `back` (from a list) returns to the list.
  _renderDynItem(target, { tab = 'info', back = null } = {}) {
    const st = this._itemState(target, tab);
    const tools = this._dynTools(target, tab, st);
    const backBtn = back ? this._btn('chevron', 'Back to the list (Esc)', back, { class: 'ht-btn ht-back' }) : null;
    if (st.loading || st.error) {
      this.body.append(h('div', { class: 'ht-dyn-bar' }, backBtn, h('span', { class: 'ht-dyn-bar-fill' }), tools));
      if (st.loading) this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading…'));
      else this.body.append(h('div', { class: 'ht-empty' }, `${st.error.message} `, h('button', { class: 'ht-link', type: 'button', onClick: () => (this.itemCache.delete(st.key), this._refreshTab(tab)) }, 'Retry')));
      return;
    }
    const it = st.item;
    const pull = target.kind === 'pull';
    const ref = pull ? HT.provider.terms.pullRef(it.number) : `#${it.number}`;
    const stateLabel = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }[it.state] || it.state;
    const wrap = h('div', { class: 'ht-dyn' });
    wrap.append(
      h(
        'div',
        { class: 'ht-dyn-head' },
        h('div', { class: 'ht-dyn-title-row' }, backBtn, h('div', { class: 'ht-dyn-title' }, it.title), tools),
        h(
          'div',
          { class: 'ht-dyn-sub' },
          h('span', { class: `ht-state-pill ht-pill-${it.state}` }, stateLabel),
          h('span', null, [it.type ? it.type[0].toUpperCase() + it.type.slice(1) : pull ? HT.provider.terms.pull[0].toUpperCase() + HT.provider.terms.pull.slice(1) : 'Issue', ref, it.created ? `created ${HT.timeAgo(it.created)}` : '', it.author ? `by ${it.author}` : ''].filter(Boolean).join(' · '))
        )
      )
    );
    // Details, like the site's sidebar.
    const rows = [];
    const row = (label, value) => value && rows.push(h('div', { class: 'ht-dyn-row' }, h('span', { class: 'ht-dyn-key' }, label), h('span', { class: 'ht-dyn-val' }, value)));
    const people = (list) => (list?.length ? list.join(', ') : h('span', { class: 'ht-muted' }, 'None'));
    row('Assignees', people(it.assignees));
    if (pull) row('Reviewers', people(it.reviewers));
    if (pull && it.head) row('Branches', h('span', { class: 'ht-item-branch' }, HT.icon('branch'), `${it.head} → ${it.base}`));
    row('Labels', it.labels?.length ? h('span', { class: 'ht-labels' }, it.labels.map((l) => this._labelPill(l))) : h('span', { class: 'ht-muted' }, 'None'));
    row('Milestone', it.milestone ? (HT.safeUrl(it.milestone.url) ? h('a', { class: 'ht-link', href: HT.safeUrl(it.milestone.url) }, it.milestone.title) : it.milestone.title) : h('span', { class: 'ht-muted' }, 'None'));
    if (it.due || it.milestone?.due) row('Due', new Date(it.due || it.milestone.due).toLocaleDateString());
    if (it.weight != null) row('Weight', String(it.weight));
    if (it.estimate || it.timeSpent) row('Time', [it.timeSpent ? `${it.timeSpent} spent` : '', it.estimate ? `of ${it.estimate}` : ''].filter(Boolean).join(' '));
    if (it.closed && it.state !== 'open') row(it.state === 'merged' ? 'Merged' : 'Closed', HT.timeAgo(it.closed));
    wrap.append(h('div', { class: 'ht-dyn-section' }, h('h3', { class: 'ht-dyn-h' }, 'Details'), ...rows));

    // The description, folded to a few lines until asked for.
    if (it.description?.trim()) {
      const body = h('div', { class: `ht-entry-body ht-md ht-desc${st.descOpen ? ' open' : ''}` }, this._richBlocks(it.description.trim()));
      const more = h('button', { class: 'ht-link', type: 'button', onClick: () => ((st.descOpen = !st.descOpen), this._refreshTab(tab)) }, st.descOpen ? 'Show less' : 'Show all');
      wrap.append(h('div', { class: 'ht-dyn-section' }, h('h3', { class: 'ht-dyn-h' }, 'Description'), body, it.description.length > 400 || it.description.split('\n').length > 8 ? more : null));
    }

    // Activity, filtered by the menu's choices (and what's typed, on the Dynamic tab).
    const q = back ? '' : this._query().trim().toLowerCase();
    const show = this._dynShow || 'all';
    let acts = (st.activity || []).filter((a) => (show === 'comments' ? a.comment != null && !a.action : show === 'history' ? a.comment == null || a.action : true));
    if (q) acts = acts.filter((a) => `${a.author} ${a.action || ''} ${a.comment || ''} ${[...(a.labels || []), ...(a.added || []), ...(a.removed || [])].map((l) => l.name).join(' ')}`.toLowerCase().includes(q));
    if (this._dynNewest) acts = [...acts].reverse();
    const list = h('ol', { class: 'ht-activity' });
    for (const a of acts) list.append(this._activityRow(a));
    const count = (st.activity || []).length;
    wrap.append(
      h(
        'div',
        { class: 'ht-dyn-section' },
        h('h3', { class: 'ht-dyn-h' }, 'Activity', count ? h('span', { class: 'ht-badge ht-badge-count' }, String(count)) : null),
        st.activityError ? h('p', { class: 'ht-help' }, `The activity couldn't be read: ${st.activityError.message}`) : null,
        acts.length ? list : h('p', { class: 'ht-help' }, q ? `Nothing matches “${q}”.` : 'No activity yet.')
      )
    );
    this.body.append(wrap);
  }

  // One activity entry: a comment as a card, anything else as a line.
  _activityRow(a) {
    const when = a.date ? h('span', { class: 'ht-entry-time', title: new Date(a.date).toLocaleString() }, HT.timeAgo(a.date)) : null;
    if (a.comment != null && !a.action) {
      return h(
        'li',
        { class: 'ht-entry ht-entry-comment' },
        h('div', { class: 'ht-entry-card' }, h('div', { class: 'ht-entry-card-head' }, h('strong', null, a.author), ' ', when), h('div', { class: 'ht-entry-body ht-md' }, this._richBlocks(a.comment)))
      );
    }
    const line = h('div', { class: 'ht-entry-line' }, h('strong', null, a.author), ' ');
    if (a.labelEvent) {
      if (a.added.length) line.append('added ', ...a.added.map((l) => this._labelPill(l)), ` label${a.added.length === 1 ? '' : 's'}`);
      if (a.added.length && a.removed.length) line.append(' and ');
      if (a.removed.length) line.append('removed ', ...a.removed.map((l) => this._labelPill(l)), ` label${a.removed.length === 1 ? '' : 's'}`);
    } else {
      line.append(...this._richText(a.action, true));
      if (a.labels) line.append(' ', ...a.labels.map((l) => this._labelPill(l)), a.labelWord ? ' label' : '');
    }
    line.append(' ', when);
    return h('li', { class: 'ht-entry ht-entry-event' }, line, a.comment ? h('div', { class: 'ht-entry-body ht-entry-quote ht-md' }, this._richBlocks(a.comment)) : null);
  }

  // Markdown blocks as nodes (never HTML): headings, lists and task lists,
  // quotes, code fences, rules and tables. The text inside each goes through
  // _richText; HTML comments (as in issue templates) are dropped.
  _richBlocks(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const out = [];
    let para = [];
    const flush = () => {
      if (para.length) out.push(h('p', { class: 'ht-md-p' }, this._richText(para.join('\n'))));
      para = [];
    };
    const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
    const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
    const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
    const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    const cells = (line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/(?<!\\)\|$/, '')
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, '|'));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = line.match(FENCE))) {
        flush();
        const code = [];
        while (++i < lines.length && !lines[i].trim().startsWith(m[1])) code.push(lines[i]);
        out.push(h('pre', { class: 'ht-md-pre' }, h('code', null, code.join('\n'))));
      } else if (!line.trim()) flush();
      else if (para.length && /^\s{0,3}(=+|-+)\s*$/.test(line)) {
        // A setext heading: the paragraph above, underlined.
        const level = line.trim()[0] === '=' ? 1 : 2;
        const title = para.join(' ');
        para = [];
        out.push(h('div', { class: `ht-md-h ht-md-h${level}` }, this._richText(title, true)));
      } else if ((m = line.match(HEAD))) {
        flush();
        out.push(h('div', { class: `ht-md-h ht-md-h${m[1].length}` }, this._richText(m[2], true)));
      } else if (RULE.test(line)) {
        flush();
        out.push(h('hr', { class: 'ht-md-hr' }));
      } else if (line.includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flush();
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'c' : 'r') : null));
        const cell = (tag, text, n) => h(tag, { class: align[n] ? `ht-md-al-${align[n]}` : null }, this._richText(text || '', true));
        const body = [];
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
          const row = cells(lines[i]);
          body.push(h('tr', null, head.map((_, n) => cell('td', row[n], n))));
        }
        i--;
        out.push(
          h(
            'div',
            { class: 'ht-md-table' },
            h('table', null, h('thead', null, h('tr', null, head.map((t, n) => cell('th', t, n)))), body.length ? h('tbody', null, body) : null)
          )
        );
      } else if (/^\s{0,3}>/.test(line)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i--;
        out.push(h('blockquote', { class: 'ht-md-quote' }, this._richBlocks(quote.join('\n'))));
      } else if ((m = line.match(ITEM)) && (!para.length || m[1].length === 0)) {
        flush();
        // The list's items, each with its indent; lines that follow an item without a marker continue it.
        const items = [];
        for (; i < lines.length; i++) {
          const it = lines[i].match(ITEM);
          if (it) items.push({ indent: it[1].replace(/\t/g, '    ').length, ordered: /\d/.test(it[2]), start: parseInt(it[2], 10), text: it[3] });
          else if (lines[i].trim() && /^\s/.test(lines[i]) && !FENCE.test(lines[i])) items[items.length - 1].text += `\n${lines[i].trim()}`;
          else break;
        }
        i--;
        out.push(this._mdList(items));
      } else para.push(line);
    }
    flush();
    return out;
  }

  // Nested lists from a run of items with their indents.
  _mdList(items) {
    const first = items[0];
    const list = h(first.ordered ? 'ol' : 'ul', { class: 'ht-md-list', start: first.ordered && first.start !== 1 ? String(first.start) : null });
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const task = it.text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      const li = h(
        'li',
        { class: task ? 'ht-md-task' : null },
        task ? h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ', tabindex: '-1' }) : null,
        task ? ' ' : null,
        this._richText(task ? task[2] : it.text)
      );
      const sub = [];
      while (n + 1 < items.length && items[n + 1].indent > first.indent) sub.push(items[++n]);
      if (sub.length) li.append(this._mdList(sub));
      list.append(li);
    }
    return list;
  }

  // A GitLab upload's path within its project ("/uploads/<secret>/<file>"),
  // written relative or as the project's full address.
  _uploadPath(url) {
    if (HT.provider.id !== 'gitlab') return null;
    const base = HT.provider.base(this.ctx);
    const path = url.startsWith(`${base}/uploads/`) ? url.slice(base.length) : url;
    return /^\/uploads\/[0-9a-f]{16,64}\/[^/?#\\]+$/.test(path) ? path : null;
  }

  // GitLab's uploads sit behind the sign-in, so the background reads them
  // (with the token, else the session) and the image shows from its data.
  // Read once per page (Reload reads again); a failure leaves its name.
  _uploadImg(path, alt, href) {
    const img = h('img', { alt });
    this._uploads ||= new Map();
    const key = `${this.ctx.fullPath}${path}`;
    if (!this._uploads.has(key)) {
      const ask = HT.api.send({ type: 'upload', host: location.host, provider: 'gitlab', project: this.ctx.fullPath, path });
      this._uploads.set(key, ask.then((res) => (res?.ok ? res.data : null), () => null));
    }
    this._uploads.get(key).then((data) => {
      if (data) img.src = data;
      else img.replaceWith(h('span', { class: 'ht-link' }, HT.icon('file'), ' ', alt));
    });
    return img;
  }

  // Images the site serves itself: its own origin, and GitHub's attachment hosts.
  _ownImage(url) {
    try {
      const u = new URL(url);
      if (u.origin === location.origin) return true;
      return HT.provider.id === 'github' && u.protocol === 'https:' && /^(private-)?user-images\.githubusercontent\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  }

  // Markdown-ish text as nodes (never HTML): GitLab's {-removed-} and
  // {+added+} title changes, **bold**, `code`, [links](…), and references
  // to issues (#12), merge requests (!3) and commits become links.
  _richText(text, inline = false) {
    const out = [];
    const ctx = this.ctx;
    // A path on the site; GitLab's uploads are relative to the project.
    const local = (url) => (!url.startsWith('/') ? url : HT.provider.id === 'gitlab' && url.startsWith('/uploads/') ? `${HT.provider.base(ctx)}${url}` : `${ctx.origin}${url}`);
    const source = inline ? String(text).replace(/\s*\n\s*/g, ' ') : String(text);
    const re = /\{-([\s\S]*?)-\}|\{\+([\s\S]*?)\+\}|\*\*([^*]+)\*\*|`([^`\n]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w/])([\w.-]+\/[\w.-]+)?([#!])(\d+)\b|(?<![\w/])\b([0-9a-f]{7,40})\b|!\[([^\]]*)\]\(([^)\s]+)\)(?:\{[^}\n]*\})?|(?<![\w*])\*([^*\n]+)\*(?![\w*])|~~([^~\n]+)~~|\\([\\`*_{}\[\]()#+\-.!|~<>])/g;
    let last = 0;
    for (const m of source.matchAll(re)) {
      if (m.index > last) out.push(source.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] != null) out.push(h('del', { class: 'ht-del-text' }, m[1]));
      else if (m[2] != null) out.push(h('ins', { class: 'ht-ins-text' }, m[2]));
      else if (m[3] != null) out.push(h('strong', null, this._richText(m[3], true)));
      else if (m[4] != null) out.push(h('code', { class: 'ht-code-inline' }, m[4]));
      else if (m[5] != null) {
        const href = HT.safeUrl(local(m[6]));
        out.push(href ? h('a', { class: 'ht-link', href }, m[5]) : m[5]);
      } else if (m[9] != null) {
        const n = Number(m[9]);
        const other = m[7];
        let href = null;
        if (!other) href = m[8] === '#' ? HT.provider.issueUrl?.(ctx, n) : HT.provider.id === 'gitlab' ? HT.provider.pullUrl(ctx, n) : null;
        out.push(href ? h('a', { class: 'ht-link', href: HT.safeUrl(href) }, m[0]) : m[0]);
      } else if (m[10] != null) {
        const href = HT.provider.commitUrl ? HT.safeUrl(HT.provider.commitUrl(ctx, m[10])) : null;
        out.push(href ? h('a', { class: 'ht-link ht-sha', href }, m[10].slice(0, 8)) : m[10]);
      } else if (m[12] != null) {
        // An image stored on the site itself shows, as the page shows it; one
        // from anywhere else stays a link, so no other server learns of the visit.
        const href = HT.safeUrl(local(m[12]));
        const alt = m[11] || 'image';
        if (!href) out.push(alt);
        else if (this._uploadPath(m[12])) out.push(h('a', { class: 'ht-md-img', href, title: alt }, this._uploadImg(this._uploadPath(m[12]), alt, href)));
        else if (this._ownImage(href)) out.push(h('a', { class: 'ht-md-img', href, title: alt }, h('img', { src: href, alt, loading: 'lazy', referrerpolicy: 'same-origin' })));
        else out.push(h('a', { class: 'ht-link', href }, HT.icon('file'), ' ', alt));
      } else if (m[13] != null) out.push(h('em', null, this._richText(m[13], true)));
      else if (m[14] != null) out.push(h('del', null, this._richText(m[14], true)));
      else if (m[15] != null) out.push(m[15]); // a character escaped with a backslash
    }
    if (last < source.length) out.push(source.slice(last));
    return out;
  }

  // The Dynamic tab's controls, in its header: what to show (and in which
  // order, on a work item), open on the page, and reload.
  _dynTools(target, tab = 'info', st = null) {
    const tools = h('span', { class: 'ht-dyn-tools' });
    const open = this._dynMenu === tab;
    const filtered = target ? (this._dynShow || 'all') !== 'all' || this._dynNewest : (this.s.infoHidden || []).length > 0;
    const redo = () => this._refreshTab(tab);
    tools.append(
      this._btn(
        'filter',
        target ? 'Activity: what and in which order' : 'Choose what to show',
        (e) => {
          e.stopPropagation();
          this._dynMenu = open ? false : tab;
          if (this._dynMenu) setTimeout(() => this.shadow.addEventListener('click', () => this._dynMenu && ((this._dynMenu = false), redo()), { once: true }));
          redo();
        },
        { class: `ht-btn${filtered ? ' on' : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': String(open) }
      )
    );
    const url = target ? HT.safeUrl(st?.item?.url) : null;
    if (url && !location.href.startsWith(url)) tools.append(h('a', { class: 'ht-btn', href: url, title: 'Open on the page', 'aria-label': 'Open on the page' }, HT.icon('external')));
    tools.append(
      this._btn('refresh', 'Reload', () => {
        if (target) this.itemCache?.delete(st?.key);
        else this.projInfo = null;
        this._uploads = null;
        HT.api.clearMemo();
        redo();
      })
    );
    if (!open) return tools;
    const menu = h('div', { class: 'ht-pop ht-dyn-pop', role: 'menu', onClick: (e) => e.stopPropagation() });
    if (target) {
      const show = this._dynShow || 'all';
      for (const [id, text] of [['all', 'All activity'], ['comments', 'Comments only'], ['history', 'History only']]) {
        menu.append(this._popItem(show === id, text, null, 'menuitemradio', () => ((this._dynShow = id), (this._dynMenu = false), redo())));
      }
      menu.append(
        h('div', { class: 'ht-pop-sep' }),
        this._popItem(!this._dynNewest, 'Oldest first', null, 'menuitemradio', () => ((this._dynNewest = false), (this._dynMenu = false), redo())),
        this._popItem(Boolean(this._dynNewest), 'Newest first', null, 'menuitemradio', () => ((this._dynNewest = true), (this._dynMenu = false), redo()))
      );
    } else {
      const hidden = new Set(this.s.infoHidden || []);
      const home = this._onRepoHome();
      for (const [id, text] of PROJECT_FIELDS) {
        const where = home && ON_PAGE.has(id) ? 'other pages' : !home && HOME_ONLY.has(id) ? 'home page' : null;
        menu.append(
          this._popItem(!hidden.has(id), text, where, 'menuitemcheckbox', () => {
            if (hidden.has(id)) hidden.delete(id);
            else hidden.add(id);
            HT.store.set({ infoHidden: [...hidden] }).then(redo);
          })
        );
      }
    }
    tools.append(menu);
    return tools;
  }

  // The project's information, in the parts the user chose (filter menu).
  _renderProject() {
    if (this.projInfo?.key !== this.repoKey) {
      const st = (this.projInfo = { key: this.repoKey, loading: true });
      HT.provider
        .projectInfo(this.ctx)
        .then((data) => Object.assign(st, { data, loading: false }), (err) => Object.assign(st, { error: err, loading: false }))
        .then(() => this.projInfo === st && this._refreshTab('info'));
    }
    const st = this.projInfo;
    const tools = this._dynTools(null);
    if (st.loading) {
      this.body.append(h('div', { class: 'ht-dyn-bar' }, tools), h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading…'));
      return;
    }
    if (st.error) {
      this.body.append(h('div', { class: 'ht-dyn-bar' }, tools), h('div', { class: 'ht-empty' }, `${st.error.message} `, h('button', { class: 'ht-link', type: 'button', onClick: () => ((this.projInfo = null), this._refreshTab('info')) }, 'Retry')));
      return;
    }
    const d = st.data;
    const ctx = this.ctx;
    const q = this._query().trim().toLowerCase();
    const home = this._onRepoHome();
    const hidden = new Set(this.s.infoHidden || []);
    const on = new Set(PROJECT_FIELDS.map(([f]) => f).filter((f) => !hidden.has(f) && !(home && ON_PAGE.has(f)) && !(!home && HOME_ONLY.has(f))));
    const wrap = h('div', { class: 'ht-dyn' });
    const section = (title, ...kids) => {
      const el = h('div', { class: 'ht-dyn-section' }, title ? h('h3', { class: 'ht-dyn-h' }, title) : null, ...kids);
      if (!q || el.textContent.toLowerCase().includes(q)) wrap.append(el);
    };
    const num = (n) => (n == null ? null : HT.formatCount(n));
    const isGitlab = HT.provider.id === 'gitlab';
    // The page's own panel already names the project.
    if (home) wrap.append(h('div', { class: 'ht-dyn-bar' }, tools));
    else wrap.append(h('div', { class: 'ht-dyn-head' }, h('div', { class: 'ht-dyn-title-row' }, h('div', { class: 'ht-dyn-title' }, `${ctx.owner}/${ctx.repo}`), tools), d.archived ? h('div', { class: 'ht-dyn-sub' }, h('span', { class: 'ht-state-pill ht-pill-closed' }, 'Archived')) : null));
    for (const field of PROJECT_FIELDS.map(([f]) => f).filter((f) => on.has(f))) {
      if (field === 'outline') {
        const outline = this._readmeOutline(st);
        if (outline) section('README', outline);
      } else if (field === 'activity') {
        if (!HT.provider.recentActivity) continue;
        if (!st.activity) {
          st.activity = { loading: true };
          HT.provider.recentActivity(ctx).then(
            (items) => Object.assign(st.activity, { items, loading: false }),
            (err) => Object.assign(st.activity, { error: err, loading: false })
          ).then(() => this.projInfo === st && this._refreshTab('info'));
        }
        const a = st.activity;
        if (a.loading) section('Recent activity', h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading…'));
        else if (a.error) section('Recent activity', h('p', { class: 'ht-help' }, `Couldn't read the activity: ${a.error.message}`));
        else {
          const items = a.items.filter((x) => !q || `${x.author} ${x.action}`.toLowerCase().includes(q)).slice(0, 25);
          const list = h('ol', { class: 'ht-activity' }, items.map((x) => this._activityRow(x)));
          const el = h('div', { class: 'ht-dyn-section' }, h('h3', { class: 'ht-dyn-h' }, 'Recent activity'), items.length ? list : h('p', { class: 'ht-help' }, q ? `Nothing matches “${q}”.` : 'Nothing lately.'));
          wrap.append(el);
        }
      } else if (field === 'about' && (d.description || d.homepage || d.topics?.length)) {
        section(
          'About',
          d.description ? h('p', { class: 'ht-dyn-text' }, this._richText(d.description)) : null,
          HT.safeUrl(d.homepage) ? h('p', null, h('a', { class: 'ht-link', href: HT.safeUrl(d.homepage) }, d.homepage.replace(/^https?:\/\//, ''))) : null,
          d.topics?.length ? h('span', { class: 'ht-labels' }, d.topics.map((t) => this._labelPill({ name: t }))) : null
        );
      } else if (field === 'stats') {
        const stat = (icon, value, label, href) => (value == null ? null : h(href ? 'a' : 'span', { class: 'ht-stat', href: HT.safeUrl(href) || null, title: label }, HT.icon(icon), h('strong', null, value), ` ${label}`));
        section(
          null,
          h(
            'div',
            { class: 'ht-stats-grid' },
            stat('star', num(d.stars), 'stars'),
            stat('branch', num(d.forks), 'forks'),
            stat('issue', num(d.openIssues), isGitlab ? 'open work items' : 'open issues', HT.provider.issuesUrl?.(ctx)),
            stat('pull', num(d.openPulls), isGitlab ? 'open merge requests' : 'open pull requests', HT.provider.pullsUrl?.(ctx)),
            stat('commit', num(d.commits), 'commits')
          )
        );
      } else if (field === 'languages' && d.languages?.length) {
        const langs = [...d.languages].sort((a, b) => b.pct - a.pct);
        const bar = h('div', { class: 'ht-lang-bar' }, langs.map((l) => h('span', { style: `width:${l.pct.toFixed(2)}%;background:${langColor(l.name)}`, title: `${l.name} ${l.pct.toFixed(1)}%` })));
        const legend = h('div', { class: 'ht-lang-legend' }, langs.slice(0, 8).map((l) => h('span', null, h('i', { style: `background:${langColor(l.name)}` }), h('strong', null, l.name), ` ${l.pct.toFixed(1)}%`)));
        section('Languages', bar, legend);
      } else if (field === 'release' && d.release) {
        const href = HT.safeUrl(d.release.url);
        section('Latest release', h('p', null, HT.icon('deploy'), ' ', href ? h('a', { class: 'ht-link', href }, d.release.name) : d.release.name, d.release.date ? h('span', { class: 'ht-muted' }, ` · ${HT.timeAgo(d.release.date)}`) : null));
      } else if (field === 'details') {
        const rows = [];
        const row = (label, value) => value && rows.push(h('div', { class: 'ht-dyn-row' }, h('span', { class: 'ht-dyn-key' }, label), h('span', { class: 'ht-dyn-val' }, value)));
        row('Default branch', d.defaultBranch);
        row('License', d.license);
        row('Visibility', d.visibility ? d.visibility[0].toUpperCase() + d.visibility.slice(1) : null);
        row('Last activity', d.lastActivity ? HT.timeAgo(d.lastActivity) : null);
        row('Created', d.created ? new Date(d.created).toLocaleDateString() : null);
        row('Size', d.sizeKb != null ? HT.formatBytes?.(d.sizeKb * 1024) || `${HT.formatCount(d.sizeKb)} KB` : null);
        if (rows.length) section('Details', ...rows);
      } else if (field === 'clone' && (d.clone?.https || d.clone?.ssh)) {
        const copyRow = (label, url) =>
          url &&
          h(
            'div',
            { class: 'ht-clone' },
            h('span', { class: 'ht-dyn-key' }, label),
            h('code', { class: 'ht-code-inline', title: url }, url),
            this._btn('copy', `Copy the ${label} address`, async () => this._toast((await HT.copyText(url)) ? 'Copied' : 'Copy failed'))
          );
        section('Clone', copyRow('HTTPS', d.clone.https), copyRow('SSH', d.clone.ssh));
      }
    }
    this.body.append(wrap);
  }

  // The repository's home page: where the site shows its own project panel.
  _onRepoHome() {
    const ctx = this.ctx;
    if (!ctx || ctx.kind !== 'repo' || ctx.issueNumber) return false;
    try {
      return location.pathname.replace(/\/+$/, '').toLowerCase() === new URL(HT.provider.base(ctx)).pathname.replace(/\/+$/, '').toLowerCase();
    } catch {
      return false;
    }
  }

  // The README's headings, to jump to them in the README the page shows.
  _readmeOutline(st) {
    const root = this.code?.root;
    const file = root?.children?.find((n) => n.type === 'blob' && /^readme(\.(md|markdown|mdown))?$/i.test(n.name));
    if (!file) return null;
    if (!st.readme) {
      st.readme = { loading: true };
      HT.provider.repoFile(this.ctx, this.code.ref, file.path).then(
        (text) => Object.assign(st.readme, { text: text || '', loading: false }),
        () => Object.assign(st.readme, { text: '', loading: false })
      ).then(() => this.projInfo === st && this._refreshTab('info'));
    }
    if (st.readme.loading) return h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading…');
    const heads = [];
    let fence = false;
    for (const line of st.readme.text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const m = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) heads.push({ level: m[1].length, text: m[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim() });
    }
    if (!heads.length) return null;
    const top = Math.min(...heads.map((x) => x.level));
    // The sites' heading anchors: lowercase, punctuation dropped, spaces to hyphens.
    const slug = (t) => {
      const s = t.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      return HT.provider.id === 'gitlab' ? s.replace(/-+/g, '-') : s;
    };
    const used = new Map();
    return h(
      'ul',
      { class: 'ht-outline' },
      heads.slice(0, 60).map((x) => {
        let id = slug(x.text);
        const n = used.get(id) || 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        return h(
          'li',
          { style: `--depth:${x.level - top}` },
          h(
            'a',
            {
              class: 'ht-link',
              href: `#${id}`,
              onClick: (e) => {
                const target = document.getElementById(`user-content-${id}`) || document.getElementById(id);
                if (!target) return;
                e.preventDefault();
                target.scrollIntoView({ block: 'start', behavior: 'smooth' });
                history.replaceState(history.state, '', `#${id}`);
              },
            },
            x.text
          )
        );
      })
    );
  }

  // ---------- pull/merge requests and issues/work items ----------

  _listName(kind) {
    if (kind === 'pulls') return HT.provider.id === 'gitlab' ? 'Merge requests' : 'Pull requests';
    return HT.provider.id === 'gitlab' ? 'Work items' : 'Issues';
  }

  _listState(kind) {
    this.lists ||= {};
    let st = this.lists[kind];
    if (st?.key !== this.repoKey) {
      st = { key: this.repoKey, state: 'open', items: [], page: 0, more: false, total: null, loading: false, error: null, counts: null };
      this.lists[kind] = st;
    }
    return st;
  }

  async _loadList(kind, st) {
    st.loading = true;
    st.error = null;
    const page = st.page + 1;
    const want = st.state;
    try {
      const res = await HT.provider[kind](this.ctx, want, page);
      if (this.lists?.[kind] !== st || st.state !== want) return;
      st.items.push(...res.items);
      st.page = page;
      st.more = res.more;
      if (res.total != null) st.total = res.total;
    } catch (err) {
      if (this.lists?.[kind] !== st || st.state !== want) return;
      st.error = err;
      HT.debug?.note(kind, err);
    }
    st.loading = false;
    this._refreshTab(kind);
  }

  _renderList(kind) {
    if (!this.ctx) return;
    const st = this._listState(kind);
    // One of them opened in the sidebar.
    if (st.detail) {
      this._renderDynItem({ kind: kind === 'pulls' ? 'pull' : 'issue', n: st.detail }, { tab: kind, back: () => this._closeListItem(kind) });
      return;
    }
    const name = this._listName(kind);
    const lower = name.toLowerCase();
    const states = kind === 'pulls' ? [['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed'], ['all', 'All']] : [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']];
    if (!st.page && !st.loading && !st.error) this._loadList(kind, st);
    if (!st.counts && HT.provider.listCounts) {
      st.counts = {};
      HT.provider.listCounts(this.ctx, kind).then((c) => {
        if (this.lists?.[kind] !== st) return;
        st.counts = c;
        this._refreshTab(kind);
      }, () => {});
    }
    const q = this._query().trim();
    this.body.append(this._listHead(kind, st, states, q));
    if (st.loading && !st.items.length) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), `Loading ${lower}…`));
      return;
    }
    const list = h('ul', { class: 'ht-list ht-item-list' });
    const current = kind === 'pulls' && this.ctx.kind === 'pull' ? this.ctx.pullNumber : kind === 'issues' ? this.ctx.issueNumber : null;
    // Label rows fold to two lines once laid out, and again when the pane's width changes.
    st.labelsRO?.disconnect();
    st.labelsRO = new ResizeObserver((entries) => this._fitLabels(entries.map((e) => e.target)));
    for (const it of st.items) {
      if (q && !this._listMatch(kind, it, q)) continue;
      const row = this._itemRow(kind, it, it.number === current);
      const labels = row.querySelector('.ht-labels');
      if (labels) st.labelsRO.observe(labels);
      list.append(row);
    }
    if (st.error) {
      list.append(
        h(
          'li',
          { class: 'ht-empty' },
          `${st.error.message} `,
          h('button', { class: 'ht-link', type: 'button', onClick: () => this._loadList(kind, st) }, 'Retry')
        )
      );
    } else if (!list.children.length) {
      const which = st.state === 'all' ? '' : `${st.state} `;
      list.append(h('li', { class: 'ht-empty' }, q ? `No ${lower} match “${q}”` : `No ${which}${lower}.`));
    }
    if (st.more && !st.error) {
      list.append(
        h(
          'li',
          { class: 'ht-empty' },
          st.loading ? 'Loading…' : h('button', { class: 'ht-link', type: 'button', onClick: () => this._loadList(kind, st) }, 'Load more')
        )
      );
    }
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    this.body.append(list);
  }

  // One pull/merge request or issue, laid out like the site's own lists:
  // type or state icon, title, "#12 · created 3d ago by X", label pills,
  // and comments and last update at the right.
  _itemRow(kind, it, isCurrent) {
    const ref = kind === 'pulls' ? HT.provider.terms.pullRef(it.number) : `#${it.number}`;
    const gitlab = HT.provider.id === 'gitlab';
    let icon;
    if (kind === 'issues' && gitlab) icon = HT.glIcons.icon(`work-item-${it.type || 'issue'}`) || HT.icon('issue');
    else if (kind === 'issues') icon = HT.icon(it.state === 'closed' ? 'issueClosed' : 'issue');
    else icon = HT.icon(it.state === 'merged' ? 'merged' : 'pull');
    const stateCls = kind === 'issues' && gitlab ? 'ht-state-plain' : `ht-state-${kind === 'issues' && it.state === 'closed' ? 'done' : it.state}`;
    const created = it.created ? `created ${HT.timeAgo(it.created)}` : '';
    const by = it.author ? `by ${it.author}` : '';
    const line = [ref, [created, by].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const branch = it.head && it.base ? h('span', { class: 'ht-item-branch', title: `${it.head} into ${it.base}` }, HT.icon('branch'), `${it.head} → ${it.base}`) : null;
    const st = this._listState(kind);
    const open = st.labelsOpen?.has(it.number);
    const labels = (it.labels || []).length
      ? h(
          'span',
          { class: 'ht-labels', dataset: open ? { open: '1' } : null },
          it.labels.map((l) => this._labelPill(l)),
          h('button', {
            class: 'ht-label ht-label-more ht-folded',
            type: 'button',
            tabindex: '-1',
            onClick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              st.labelsOpen ||= new Set();
              if (open) st.labelsOpen.delete(it.number);
              else st.labelsOpen.add(it.number);
              this._refreshTab(kind);
            },
          })
        )
      : null;
    const badge = it.state === 'draft' ? 'Draft' : gitlab && it.state !== 'open' ? it.state[0].toUpperCase() + it.state.slice(1) : null;
    return h(
      'li',
      { role: 'none' },
      h(
        'a',
        {
          class: `ht-row ht-item${isCurrent ? ' selected' : ''}`,
          href: HT.safeUrl(it.url),
          dataset: { n: String(it.number) },
          onClick: (e) => {
            if (!this.s.previewFiles || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            this._openListItem(kind, it.number);
          },
          tabindex: '-1',
          title: `${ref} ${it.title}`,
          'aria-current': isCurrent ? 'page' : null,
        },
        h('span', { class: `ht-icon ${stateCls}`, title: it.type || it.state }, icon),
        h(
          'span',
          { class: 'ht-name' },
          h('span', { class: 'ht-item-title' }, badge ? h('span', { class: 'ht-badge' }, badge) : null, it.title),
          h('span', { class: 'ht-item-sub' }, line),
          branch,
          labels
        ),
        h(
          'span',
          { class: 'ht-item-side' },
          it.comments ? h('span', { class: 'ht-item-count', title: `${it.comments} comment${it.comments === 1 ? '' : 's'}` }, HT.icon('comment'), String(it.comments)) : null,
          it.date ? h('span', { class: 'ht-item-updated', title: new Date(it.date).toLocaleString() }, `updated ${HT.timeAgo(it.date)}`) : null
        )
      )
    );
  }

  // A row's labels take two lines at most; the rest fold behind a "+N" chip
  // that opens them, and an open row gets a chip to fold them again. The
  // chip sits on the same line as the last shown label: that label is
  // shortened with an ellipsis to make room, or folded too when there is
  // none. Pills past the second line are measured after layout, then hidden.
  _fitLabels(boxes) {
    const GAP = 4;
    const MIN = 44; // the least a shortened label is worth showing at
    const plan = [];
    for (const box of boxes) {
      const pills = [...box.querySelectorAll('.ht-label:not(.ht-label-more)')];
      const more = box.querySelector('.ht-label-more');
      if (!more || !pills.length) continue;
      const open = box.dataset.open === '1';
      plan.push({ box, pills, more, open, keep: pills.length, done: open, title: open ? 'Show fewer labels' : 'Show all labels' });
    }
    // Everything shown at full width first, so measuring sees the full set.
    for (const p of plan) {
      for (const pill of p.pills) {
        pill.classList.remove('ht-folded');
        pill.style.maxWidth = '';
      }
      p.more.textContent = p.open ? '−' : '';
      p.more.classList.toggle('ht-folded', !p.open);
      p.more.title = p.title;
    }
    for (let round = 0; round < 8; round++) {
      const writes = [];
      // Read: which pills sit past the second line, and whether the chip shares
      // the last shown pill's line.
      for (const p of plan) {
        if (p.done || !p.box.clientWidth) continue;
        const top = p.pills[0].offsetTop;
        const line = p.pills[0].offsetHeight + GAP;
        let keep = p.keep;
        while (keep > 0 && p.pills[keep - 1].offsetTop - top >= line * 2) keep--;
        if (keep === p.pills.length) {
          p.done = true;
          continue;
        }
        if (keep !== p.keep || p.more.classList.contains('ht-folded')) {
          writes.push(() => {
            p.keep = keep;
            p.pills.forEach((pill, i) => pill.classList.toggle('ht-folded', i >= keep));
            p.more.textContent = `+${p.pills.length - keep}`;
            p.more.classList.remove('ht-folded');
          });
          continue;
        }
        if (keep === 0) {
          p.done = true;
          continue;
        }
        const last = p.pills[keep - 1];
        if (p.more.offsetTop === last.offsetTop) {
          p.done = true;
          continue;
        }
        // The chip wrapped: shorten the last pill so it fits beside it, else fold that pill too.
        // A pill shortened once and still short of room is folded, not shortened again.
        const room = Math.floor(p.box.getBoundingClientRect().right - last.getBoundingClientRect().left - p.more.getBoundingClientRect().width - GAP) - 1;
        const tried = last.style.maxWidth !== '';
        writes.push(() => {
          if (room >= MIN && !tried) {
            last.style.maxWidth = `${Math.floor(room)}px`;
          } else {
            p.keep = keep - 1;
            last.classList.add('ht-folded');
            last.style.maxWidth = '';
            p.more.textContent = `+${p.pills.length - p.keep}`;
            if (p.keep === 0) p.done = true;
          }
        });
      }
      if (!writes.length) break;
      for (const w of writes) w();
    }
  }

  // A label as the sites draw it: its own color, with readable text.
  _labelPill(l) {
    const bg = /^#[0-9a-f]{3,8}$/i.test(l.color || '') ? l.color : null;
    let fg = /^#[0-9a-f]{3,8}$/i.test(l.text || '') ? l.text : null;
    if (bg && !fg) {
      const hex = bg.length === 4 ? bg.slice(1).split('').map((c) => c + c).join('') : bg.slice(1, 7);
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      fg = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1f2328' : '#ffffff';
    }
    return h('span', { class: 'ht-label', title: l.name, style: bg ? `background:${bg};color:${fg}` : null }, l.name);
  }

  // The list's header, as on the site's list page: a tab per state with
  // its count, the search box, and how many items there are. The site's
  // list and a reload sit at the right of the tabs.
  _listHead(kind, st, states, q) {
    const pane = this._paneOf(kind);
    const pick = (id) => {
      if (id === st.state) return;
      Object.assign(st, { state: id, items: [], page: 0, more: false, total: null, loading: false, error: null });
      this._refreshTab(kind);
    };
    const tabs = h(
      'div',
      { class: 'ht-list-tabs', role: 'tablist' },
      states.map(([id, text]) =>
        h(
          'button',
          { class: `ht-list-tab${id === st.state ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(id === st.state), onClick: () => pick(id) },
          text,
          st.counts?.[id] != null ? h('span', { class: 'ht-list-badge' }, HT.formatCount(st.counts[id])) : null
        )
      )
    );
    const url = HT.safeUrl(kind === 'pulls' ? HT.provider.pullsUrl(this.ctx) : HT.provider.issuesUrl(this.ctx));
    const site = `Open ${this._listName(kind).toLowerCase()} on ${HT.provider.name}`;
    const tools = h(
      'span',
      { class: 'ht-list-tools' },
      url ? h('a', { class: 'ht-btn', href: url, title: site, 'aria-label': site }, HT.icon('external')) : null,
      this._btn('refresh', 'Reload', () => {
        delete this.lists[kind];
        HT.api.clearMemo();
        this._refreshTab(kind);
      })
    );
    const search = h('div', { class: 'ht-list-search' }, pane.search, h('span', { class: 'ht-list-search-icon' }, HT.icon('search')));
    const total = st.total ?? (st.more ? null : st.items.length);
    let count = '';
    if (!st.loading || st.items.length) {
      const shown = q ? st.items.filter((it) => this._listMatch(kind, it, q)).length : null;
      const all = total != null ? HT.formatCount(total) : `${st.items.length}+`;
      count = q ? `${shown} of ${all} items` : `${all} item${total === 1 ? '' : 's'}`;
    }
    const head = h('div', { class: 'ht-list-head' }, h('div', { class: 'ht-list-tabrow' }, tabs, tools), search, count ? h('div', { class: 'ht-list-total' }, count) : null);
    // Drawing again moved the box: keep typing where it was.
    if (pane.typing) {
      const caret = pane.typing;
      pane.typing = null;
      queueMicrotask(() => {
        pane.search.focus({ preventScroll: true });
        pane.search.setSelectionRange(...caret);
      });
    }
    return head;
  }

  // A row clicked in the list opens in the sidebar (⌘/Ctrl-click: the page).
  _openListItem(kind, n) {
    const st = this._listState(kind);
    const pane = this._paneOf(kind);
    st.scroll = pane.body.scrollTop;
    st.detail = n;
    this._refreshTab(kind);
    pane.body.scrollTop = 0;
  }

  _closeListItem(kind) {
    const st = this._listState(kind);
    const pane = this._paneOf(kind);
    const n = st.detail;
    st.detail = null;
    this._refreshTab(kind);
    pane.body.scrollTop = st.scroll || 0;
    [...pane.body.querySelectorAll('.ht-item')].find((r) => r.dataset.n === String(n))?.focus({ preventScroll: true });
  }

  _listMatch(kind, it, q) {
    const ref = kind === 'pulls' ? HT.provider.terms.pullRef(it.number) : `#${it.number}`;
    return HT.fuzzy(q, `${it.title} ${ref} ${it.author || ''} ${it.head || ''} ${(it.labels || []).map((l) => l.name).join(' ')}`);
  }

  _diffMeta(node) {
    if (node.type === 'tree') return null;
    const icon = { added: 'diffAdded', removed: 'diffRemoved', renamed: 'diffRenamed', copied: 'diffRenamed' }[node.status] || 'diffModified';
    const counts = node.additions || node.deletions;
    return h(
      'span',
      { class: 'ht-meta' },
      counts ? h('span', { class: 'ht-add' }, `+${node.additions || 0}`) : null,
      counts ? h('span', { class: 'ht-del' }, `−${node.deletions || 0}`) : null,
      h(
        'span',
        { class: `ht-status ht-status-${node.status}`, title: node.previous ? `${node.status} from ${node.previous}` : node.status },
        HT.icon(icon)
      )
    );
  }

  // Branch or PR, file count and API budget, shown in the footer.
  _renderStats() {
    const parts = [];
    const ctx = this.ctx;
    if (ctx?.kind === 'pull') {
      const title = this.pr?.info?.title;
      const num = HT.provider.terms.pullRef(ctx.pullNumber);
      parts.push(h('span', { class: 'ht-stat-ref', title: title ? `${num} ${title}` : '' }, HT.icon('pull'), num));
    } else if (ctx?.kind === 'commit') {
      const sha = this.pr?.sha || ctx.sha;
      const title = this.pr?.info?.title;
      parts.push(h('span', { class: 'ht-stat-ref', title: title ? `${sha.slice(0, 7)} ${title}` : sha }, HT.icon('commit'), sha.slice(0, 7)));
    } else if (ctx) {
      const ref = this.refLabel || this.repo?.defaultBranch;
      if (ref) parts.push(h('span', { class: 'ht-stat-ref', title: ref }, HT.icon('branch'), h('span', { class: 'ht-stat-ref-text' }, ref)));
    }
    const state = { changes: this.pr, ci: this.ci }[this.tab] || this.code;
    if (state?.count != null) {
      const run = HT.provider.terms.run;
      const label = { changes: 'changed', ci: state.count === 1 ? run : `${run}s` }[this.tab] || 'files';
      parts.push(h('span', { title: `${state.count.toLocaleString()} ${label}` }, `${HT.formatCount(state.count)} ${label}`));
    }
    this.statsEl.replaceChildren(...parts.flatMap((p, i) => (i ? [h('span', { class: 'ht-dot' }, '·'), p] : [p])));
    this._renderAccountChip();
  }

  // Keep the sidebar identity compact; authentication details live in Settings.
  // The API budget lives in the tooltip and only shows when it runs low.
  _renderAccountChip() {
    if (!this.accountEl) {
      this.accountEl = h('button', { class: 'ht-account-chip', type: 'button', onClick: () => this.toggleSettings(true) });
      this.statsEl.after(this.accountEl);
    }
    const account = this.account;
    const rate = this.rate;
    const low = rate && rate.remaining < Math.max(10, rate.limit * 0.1);
    const budget = rate ? `${rate.remaining.toLocaleString()} of ${rate.limit.toLocaleString()} API requests left` : '';
    if (!account) {
      // Who is this? A token saved by an older build has no stored login, and
      // GitLab may be using the browser's GitLab session: look it up once.
      const authed = HT.provider.id !== 'github' || (rate && rate.limit > 60);
      if (authed && !this._accountLookup) this._lookupAccount();
      const signedIn = HT.provider.id === 'github' && rate && rate.limit > 60;
      this.accountEl.className = `ht-account-chip ht-link${low ? ' low' : ''}`;
      this.accountEl.replaceChildren(signedIn ? 'Signed in' : 'Sign in');
      this.accountEl.title = signedIn ? budget : `Not signed in: public repos only. ${budget}`.trim();
      return;
    }
    this.accountEl.className = `ht-account-chip${low ? ' low' : ''}`;
    this.accountEl.replaceChildren(
      account.avatar ? h('img', { class: 'ht-account-avatar', src: HT.avatarUrl(account.avatar, 32), alt: '' }) : null,
      h('span', { class: 'ht-account-login' }, account.login),
      ...this._supporterBadges(account.login)
    );
    this.accountEl.title = `Signed in as ${account.login}${budget ? `\n${budget}` : ''}`;
  }

  _supporterBadges(login) {
    if (location.host !== 'github.com') return [];
    const is = (list) => list.some((l) => l.toLowerCase() === login.toLowerCase());
    return [
      is(SUPPORTERS.contributors) && h('span', { class: 'ht-supporter', title: 'Hector contributor' }, HT.icon('ghCode')),
      is(SUPPORTERS.donors) && h('span', { class: 'ht-supporter donor', title: 'Hector donor' }, HT.icon('ghHeart')),
    ].filter(Boolean);
  }

  async _loadAccount() {
    const { accounts = {} } = await chrome.storage.local.get('accounts');
    this.account = accounts[location.host] || null;
    this._accountLookup = false;
    this._renderAccountChip();
  }

  async _lookupAccount() {
    this._accountLookup = true;
    try {
      const user = await HT.provider.user();
      const { hasToken } = await HT.api.send({ type: 'token:status', host: location.host });
      if (!hasToken) {
        // Signed in to GitLab in this browser: shown, not saved.
        this.account = { ...user, method: 'session' };
        this._renderAccountChip();
        return;
      }
      const { accounts = {} } = await chrome.storage.local.get('accounts');
      accounts[location.host] = { ...user, method: 'token' };
      await chrome.storage.local.set({ accounts });
    } catch {
      // Leave the generic label.
    }
  }

  _signInHint() {
    if (location.host === 'github.com') return 'Sign in with GitHub to browse private repositories.';
    if (HT.provider.id === 'gitlab') return 'Sign in to GitLab in this browser, or add an access token in settings.';
    if (HT.provider.id === 'bitbucket') return 'Add an Atlassian API token (email:token) or app password in settings to browse private repositories.';
    if (HT.provider.id === 'bitbucket-server') return 'Sign in to Bitbucket in this browser, or add an HTTP access token in settings.';
    return 'Add an access token in settings to browse private repositories.';
  }

  _renderError(err) {
    HT.debug?.note('shown', err);
    let title = 'Something went wrong';
    let text = err.message;
    let settings = false;
    if (err.status === -1) {
      title = 'Reload needed';
    } else if (err.status === -2) {
      title = 'Extension not responding';
      text = `${err.message}. Try Retry; if it keeps failing, reload Hector from the browser's add-ons page.`;
    } else if (err.rateLimited) {
      title = 'API rate limit reached';
      const reset = err.rateReset ? ` It resets at ${new Date(err.rateReset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
      const name = HT.provider.name;
      text = err.hasToken
        ? `You've used all of your ${name} API requests for now.${reset}`
        : `${name} allows few API requests without signing in.${reset} ${this._signInHint()}`;
      settings = !err.hasToken;
    } else if (err.status === 401) {
      title = 'Token rejected';
      text = `Your ${HT.provider.name} sign-in or access token is no longer valid. Sign in again in settings.`;
      settings = true;
    } else if (err.status === 404) {
      title = 'Repository not accessible';
      text = err.hasToken
        ? 'Not found, or your token cannot read this repository. Check the token\'s repository access.'
        : `This repository is private or does not exist. ${this._signInHint()}`;
      settings = true;
    } else if (err.status === 409) {
      title = 'Empty repository';
      text = 'This repository has no commits yet.';
    }
    this.body.append(
      h(
        'div',
        { class: 'ht-message' },
        h('strong', null, title),
        h('p', null, text),
        h(
          'div',
          { class: 'ht-message-actions' },
          settings ? h('button', { class: 'ht-primary', type: 'button', onClick: () => this._openOptions() }, 'Open settings') : null,
          err.status !== -1 ? h('button', { class: 'ht-secondary', type: 'button', onClick: () => this.refresh() }, 'Retry') : null
        )
      )
    );
  }

  // ---------- bookmarks ----------

  async _loadBookmarks() {
    this.bookmarks = await HT.store.bookmarks();
    this.bookmarkUrls = new Set(this.bookmarks.map((b) => b.url));
    this._updateStar();
    this._renderTabs();
    if (this.tab === 'bookmarks' || this.split === 'bookmarks') this._refreshTab('bookmarks');
    // Stars on file rows, in whichever panes show a tree.
    for (const tab of new Set([this.tab, this.split])) this._treeFor(tab)?.render();
  }

  async _toggleBookmark(item) {
    const list = await HT.store.bookmarks();
    const idx = list.findIndex((b) => b.url === item.url);
    if (idx > -1) list.splice(idx, 1);
    else list.unshift({ ...item, added: Date.now() });
    await HT.store.saveBookmarks(list);
    this._toast(idx > -1 ? 'Bookmark removed' : 'Bookmarked');
    return idx === -1;
  }

  _currentBookmark() {
    if (!this.ctx) return null;
    const { host, owner, repo, kind, pullNumber } = this.ctx;
    const repoName = `${owner}/${repo}`;
    if (kind === 'pull') {
      return {
        url: HT.provider.pullUrl(this.ctx, pullNumber),
        title: `${HT.provider.terms.pullRef(pullNumber)} ${this.pr?.info?.title || ''}`.trim(),
        kind: 'pull',
        repo: repoName,
        host,
      };
    }
    return { url: this._base(), title: repoName, kind: 'repo', repo: repoName, host };
  }

  _updateStar() {
    const cur = this._currentBookmark();
    const on = Boolean(cur && this.bookmarkUrls.has(cur.url));
    this.starBtn.classList.toggle('on', on);
    this.starBtn.title = on ? 'Remove bookmark' : 'Bookmark this page';
  }

  _bookmarkCurrent() {
    const cur = this._currentBookmark();
    if (cur) this._toggleBookmark(cur);
  }

  async _onRowAction(act, node, el) {
    if (act === 'copy') {
      const ok = await HT.copyText(node.path);
      this._toast(ok ? 'Path copied' : 'Copy failed');
      el.replaceChildren(HT.icon(ok ? 'check' : 'close'));
      setTimeout(() => el.replaceChildren(HT.icon('copy')), 1200);
    } else if (act === 'star') {
      const on = await this._toggleBookmark({
        url: this._codeLink(node),
        title: node.path,
        kind: node.type === 'tree' ? 'dir' : 'file',
        repo: `${this.ctx.owner}/${this.ctx.repo}`,
        ref: this.refLabel,
        host: this.ctx.host,
      });
      el.classList.toggle('on', on);
    }
  }

  _renderBookmarks() {
    const q = this._query().trim();
    const { search } = this.pane;
    const items = q ? this.bookmarks.filter((b) => HT.fuzzy(q, `${b.repo} ${b.title}`)) : this.bookmarks;
    if (!this.bookmarks.length) {
      this.body.append(
        h(
          'div',
          { class: 'ht-message' },
          h('strong', null, 'No bookmarks yet'),
          h('p', null, 'Use the star on any file, folder, repository or pull request to keep it here. Bookmarks sync across tabs.')
        )
      );
      return;
    }
    if (!items.length) {
      this.body.append(h('div', { class: 'ht-empty' }, `No bookmarks match “${q}”`));
      return;
    }
    const groups = new Map();
    for (const b of items) {
      const key = b.host === 'github.com' ? b.repo : `${b.host}/${b.repo}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const icons = { repo: 'repo', pull: 'pull', dir: 'folder', file: 'file' };
    const list = h('ul', { class: 'ht-list ht-bookmarks' });
    for (const [repo, entries] of groups) {
      list.append(h('li', { class: 'ht-group' }, repo));
      for (const b of entries) {
        const remove = h('span', { class: 'ht-act on', role: 'button', title: 'Remove bookmark' }, HT.icon('close'));
        const row = h(
          'a',
          { class: 'ht-row', href: b.url, tabindex: '-1', title: b.url, style: '--depth:0' },
          h('span', { class: 'ht-icon' }, HT.icon(icons[b.kind] || 'file')),
          h('span', { class: 'ht-name' }, b.kind === 'repo' ? 'Repository' : b.title, b.ref ? h('span', { class: 'ht-dir' }, b.ref) : null),
          h('span', { class: 'ht-row-actions' }, remove)
        );
        remove.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._toggleBookmark(b);
        });
        row.addEventListener('keydown', (e) => {
          const rows = [...list.querySelectorAll('.ht-row')];
          const i = rows.indexOf(row);
          if (e.key === 'ArrowDown') rows[i + 1]?.focus();
          else if (e.key === 'ArrowUp') (i === 0 ? this._searchTarget(this.pane) : rows[i - 1]).focus();
          else if (e.key === 'Delete' || e.key === 'Backspace') this._toggleBookmark(b);
          else return;
          e.preventDefault();
        });
        list.append(h('li', { role: 'none' }, row));
      }
    }
    this.body.append(list);
  }

  // ---------- Commits and branches ----------

  // What the Commits tab lists: a pull request's own commits, or the history
  // of the branch or commit being viewed.
  _commitsSource() {
    const ctx = this.ctx;
    if (ctx?.kind === 'pull' && HT.provider.pullCommits && this.repo) {
      const n = ctx.pullNumber;
      return { key: `pull:${n}`, label: HT.provider.terms.pullRef(n), scope: `Commits in ${HT.provider.terms.pullRef(n)}`, icon: 'pull', load: (page) => HT.provider.pullCommits(ctx, n, page) };
    }
    const target = this._ciTarget();
    if (!target) return null;
    const ref = target.sha || target.ref;
    const scope = ctx?.kind === 'commit' ? `History up to ${target.label}` : ctx?.kind === 'pull' ? `History of ${target.label}` : `History of ${target.label}`;
    return { key: target.key, label: target.label, scope, icon: target.sha ? 'commit' : 'branch', ref: target.sha ? null : target.ref, load: (page) => HT.provider.commits(ctx, ref, page) };
  }

  // The pull request's commits, or the branch being browsed, newest first,
  // grouped by day. 30 per page.
  _renderCommits() {
    const target = this._commitsSource();
    if (!target) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading commits…'));
      return;
    }
    if (this.commits?.key !== target.key) {
      const st = (this.commits = { key: target.key, load: target.load, items: [], page: 0, more: true, loading: true });
      // Each commit's pipeline state, for a branch's history: one request.
      if (target.ref && HT.provider.commitStatuses) {
        HT.provider.commitStatuses(this.ctx, target.ref).then(
          (statuses) => this.commits === st && ((st.statuses = statuses), this._refreshTab('commits')),
          () => {}
        );
      }
      const ck = `commits:${HT.url.repoKey(this.ctx)}:${target.key}`;
      // The first page from last time, then the real one on top of it.
      HT.cache.get(ck).then((snap) => {
        if (this.commits === st && snap && !st.items.length) {
          Object.assign(st, { items: snap.items, more: snap.more, page: 1 });
          this._refreshTab('commits');
        }
        this._loadCommits(st, { first: true, ck });
      });
    }
    const st = this.commits;
    if (st.error && !st.items.length) {
      this._renderError(st.error);
      return;
    }
    if (st.loading && !st.items.length) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading commits…'));
      return;
    }
    const q = this._query().trim();
    const shown = q ? st.items.filter((c) => HT.fuzzy(q, `${c.title} ${c.author} ${c.sha.slice(0, 7)}`)) : st.items;
    // The commit page being viewed is marked in the list.
    const here = this.ctx?.kind === 'commit' ? this.pr?.sha || this.ctx.sha : null;
    this.body.append(h('div', { class: 'ht-scope' }, HT.icon(target.icon), h('span', null, target.scope)));
    const list = h('ul', { class: 'ht-list ht-commit-list' });
    if (!shown.length) list.append(h('li', { class: 'ht-empty' }, q ? `No commits match “${q}”` : `No commits on ${target.label}.`));
    let day = '';
    for (const c of shown) {
      const when = c.date ? new Date(c.date) : null;
      const label = when ? when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      if (label !== day) {
        day = label;
        list.append(h('li', { class: 'ht-group ht-commit-day' }, HT.icon('commit'), label || 'Unknown date'));
      }
      list.append(h('li', { class: 'ht-commit-item', role: 'none' }, this._commitCard(c, st, here && c.sha.startsWith(here))));
    }
    if (st.more && !q) {
      list.append(
        h(
          'li',
          { class: 'ht-more' },
          st.loading
            ? h('span', { class: 'ht-loading-row' }, h('span', { class: 'ht-spinner' }), 'Loading…')
            : h('button', { class: 'ht-secondary', type: 'button', onClick: () => this._loadCommits(st) }, `Load more (${HT.formatCount(st.items.length)} shown)`)
        )
      );
    }
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    this.body.append(list);
    this._fillCommitDetails(st);
  }

  // A commit as GitLab's commit list draws it (commit_list_item.vue): a card
  // with the author's picture, the title over "<author> authored <when>",
  // then Verified and the pipeline, the short SHA, copy, browse files, and
  // a chevron that opens the rest of the message. In a narrow sidebar it
  // takes GitLab's narrow form: no picture, the title wraps, SHA, pipeline
  // and Verified on a line of their own, copy and browse behind a ⋮ menu.
  _commitCard(c, st, selected) {
    const run = st.statuses?.get(c.sha);
    const more = st.details?.get(c.sha);
    const verified = c.verified || more?.verified;
    const open = st.open?.has(c.sha);
    const short = c.sha.slice(0, 8);
    const tree = HT.provider.codeUrl ? HT.safeUrl(HT.provider.codeUrl(this.ctx, c.sha, '', true)) : null;
    const copy = () => navigator.clipboard?.writeText(c.sha).then(() => this._toast(`Copied ${short}`), () => this._toast(c.sha));
    const browse = (e) => (e.metaKey || e.ctrlKey ? window.open(tree, '_blank', 'noopener') : location.assign(tree));
    const stop = (fn) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    };
    const button = (icon, title, act, cls = '') =>
      h('button', { class: `ht-commit-btn${cls}`, type: 'button', title, 'aria-label': title, tabindex: '-1', onClick: stop(act) }, HT.icon(icon));
    const toggle = () => {
      st.open ||= new Set();
      if (open) st.open.delete(c.sha);
      else st.open.add(c.sha);
      this._refreshTab('commits');
    };
    const badge = verified ? h('span', { class: 'ht-verified', title: 'Signed with a verified signature' }, 'Verified') : null;
    const pipeline = () => (run ? this._commitCi(run) : null);
    const expand = (cls) =>
      c.body ? button(open ? 'chevronDown' : 'chevron', open ? 'Hide the description' : 'Show the description', toggle, ` ht-commit-expand${open ? ' open' : ''}${cls}`) : null;
    const menu = st.menu === c.sha;
    const row = h(
      'a',
      {
        class: `ht-row ht-commit${selected ? ' selected' : ''}`,
        href: HT.safeUrl(c.url),
        tabindex: '-1',
        title: c.title,
        'aria-current': selected ? 'page' : null,
        dataset: { key: `commit:${c.sha}` },
      },
      this._commitAvatar(c.author, c.avatar || more?.avatar),
      h(
        'span',
        { class: 'ht-commit-main' },
        h(
          'span',
          { class: 'ht-name' },
          h('span', { class: 'ht-commit-title' }, c.title),
          h('span', { class: 'ht-commit-sub' }, h('span', { class: 'ht-commit-author' }, c.author || 'Someone'), ' authored ', c.date ? h('span', { title: new Date(c.date).toLocaleString() }, HT.timeAgo(c.date)) : null)
        ),
        h(
          'span',
          { class: 'ht-commit-side' },
          // Narrow: the SHA, the pipeline and Verified, under the author.
          h('span', { class: 'ht-commit-badges-narrow' }, h('code', { class: 'ht-commit-sha' }, short), pipeline(), badge?.cloneNode(true)),
          h('span', { class: 'ht-commit-badges' }, badge, pipeline()),
          h(
            'span',
            { class: 'ht-commit-actions' },
            h('code', { class: 'ht-commit-sha' }, short),
            button('copy', 'Copy commit SHA', copy),
            tree ? button('folderOpen', 'Browse commit files', browse) : null,
            // GitLab keeps the rule and chevron's room when there's no description.
            h('span', { class: `ht-commit-rule${c.body ? '' : ' ht-invisible'}` }),
            expand('') || h('span', { class: 'ht-commit-btn ht-invisible' })
          )
        )
      ),
      expand(' ht-commit-narrow'),
      h(
        'span',
        { class: 'ht-commit-more ht-commit-narrow' },
        button('moreV', 'More actions', () => {
          st.menu = menu ? null : c.sha;
          // A click anywhere else closes it.
          if (st.menu) setTimeout(() => this.shadow.addEventListener('click', () => st.menu && ((st.menu = null), this._refreshTab('commits')), { once: true }));
          this._refreshTab('commits');
        }),
        menu
          ? h(
              'span',
              { class: 'ht-pop ht-commit-menu', role: 'menu' },
              h('button', { class: 'ht-menu-item', type: 'button', role: 'menuitem', onClick: stop(() => ((st.menu = null), copy(), this._refreshTab('commits'))) }, 'Copy commit SHA'),
              tree ? h('button', { class: 'ht-menu-item', type: 'button', role: 'menuitem', onClick: stop((e) => ((st.menu = null), browse(e))) }, 'Browse commit files') : null
            )
          : null
      )
    );
    return h('div', { class: 'ht-commit-card' }, row, open && c.body ? h('div', { class: 'ht-commit-desc' }, c.body) : null);
  }

  // GitLab's ci-icon: the status's borderless glyph in a ring tinted by its
  // variant (the page's own --ci-icon-* colors).
  _commitCi(run) {
    const [icon, , label] = this._ciStatus(run.status, run.conclusion);
    const name = { ciOk: 'success', ciFail: 'failed', ciWarn: 'warning', ciRunning: 'running', ciQueued: run.conclusion === 'manual' ? 'manual' : 'pending', ciSkip: run.conclusion === 'cancelled' ? 'canceled' : 'skipped' }[icon];
    const variant = { success: 'success', failed: 'danger', warning: 'warning', pending: 'warning', running: 'info' }[name] || 'neutral';
    const glyph = HT.provider.id === 'gitlab' ? HT.glIcons.icon(`status_${name}_borderless`) : null;
    return h('span', { class: `ht-ci-ring ht-ci-ring-${variant}`, title: `Pipeline: ${label}`, 'aria-label': `Pipeline: ${label}` }, h('span', { class: 'ht-ci-ring-glyph' }, glyph || HT.icon(icon)));
  }

  // The author's picture over their initial, which stays if it doesn't load.
  // Only pictures the site serves (or GitHub's avatar host) are shown.
  _commitAvatar(author, url) {
    const box = h('span', { class: 'ht-avatar ht-commit-avatar', 'aria-hidden': 'true' }, (author || '?').trim().charAt(0).toUpperCase() || '?');
    const safe = url && HT.safeUrl(url);
    if (safe && (this._ownImage(safe) || safe.startsWith('https://avatars.githubusercontent.com/'))) {
      const img = h('img', { src: safe, alt: '', loading: 'lazy', referrerpolicy: 'same-origin', onError: () => img.remove() });
      box.append(img);
    }
    return box;
  }

  // Pictures and Verified for the commits shown, where the list leaves them
  // out (GitLab): asked once per commit, in one query per batch.
  _fillCommitDetails(st) {
    if (!HT.provider.commitDetails) return;
    st.details ||= new Map();
    const want = st.items.map((c) => c.sha).filter((sha) => !st.details.has(sha)).slice(0, 100);
    if (!want.length) return;
    for (const sha of want) st.details.set(sha, null);
    HT.provider.commitDetails(this.ctx, want).then(
      (found) => {
        if (this.commits !== st) return;
        for (const [sha, d] of found) st.details.set(sha, d);
        this._refreshTab('commits');
      },
      () => {}
    );
  }

  async _loadCommits(st, { first = false, ck = null } = {}) {
    if (st.loading && !first) return;
    st.loading = true;
    this._refreshTab('commits');
    try {
      const { items, more } = await st.load(first ? 1 : st.page + 1);
      if (this.commits !== st) return;
      const seen = new Set(first ? items.map((c) => c.sha) : st.items.map((c) => c.sha));
      if (first) {
        // Fresh first page, then whatever was already shown beneath it.
        st.items = [...items, ...st.items.filter((c) => !seen.has(c.sha))];
        st.page = Math.max(st.page, 1);
        if (!st.items.length || st.page === 1) st.more = more;
        if (ck) HT.cache.set(ck, { items, more });
      } else {
        st.items.push(...items.filter((c) => !seen.has(c.sha)));
        st.page += 1;
        st.more = more;
      }
      st.error = null;
    } catch (err) {
      if (st.items.length) this._toast(err.message);
      st.error = err;
    }
    st.loading = false;
    if (this.commits === st) this._refreshTab('commits');
  }

  // Branches as a tree: `feat/x` and `feat/y` sit under a `feat` folder
  // (chains of single folders collapse into one row). The default branch is
  // pinned on top with the current one, rows carry the last commit where
  // the site tells it, and hover shows copy and compare. A menu sorts by
  // name or recent activity and shows or hides merged branches.
  _renderBranches() {
    if (!this.repo) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading branches…'));
      return;
    }
    const key = HT.url.repoKey(this.ctx);
    if (this.branches?.key !== key) {
      const st = (this.branches = { key, items: null, open: new Set() });
      HT.cache.get(`branches:${key}`).then((snap) => {
        if (this.branches === st && snap && !st.items) {
          this._setBranches(st, snap.items, snap.more);
          this._refreshTab('branches');
        }
        this._loadBranches(st);
      });
    }
    const st = this.branches;
    if (st.error) {
      this._renderError(st.error);
      return;
    }
    if (!st.items) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading branches…'));
      return;
    }
    const body = this.body;
    this.body.append(h('div', { class: 'ht-branch-toolbar' },
      h('span', { class: 'ht-branch-count' }, `${HT.formatCount(st.items.length)}${st.more ? '+' : ''} branches`),
      h('div', { class: 'ht-branch-views', role: 'group', 'aria-label': 'Branch view' },
        [['List', false], ['Graph', true]].map(([label, graphMode]) => h('button', {
          type: 'button', class: 'ht-branch-view', 'aria-pressed': String(Boolean(st.graphMode) === graphMode),
          dataset: { view: label.toLowerCase() },
          onClick: () => {
            st.graphMode = graphMode;
            this._refreshTab('branches');
            body.querySelector(`[data-view="${label.toLowerCase()}"]`)?.focus();
          },
        }, label)))));
    if (st.graphMode) {
      this._renderBranchGraph(st);
      return;
    }
    const q = this._query().trim();
    const def = this.repo.defaultBranch;
    const current = this._currentBranch(st.items);
    // On a pull request: the branch it merges into.
    const base = this.ctx?.kind === 'pull' ? this.pr?.info?.baseRef : null;
    const hasDates = st.items.some((b) => b.date);
    const hasMerged = st.items.some((b) => b.merged != null);
    const sort = hasDates && this._brSort === 'recent' ? 'recent' : 'name';
    let matched = q ? st.items.filter((b) => HT.fuzzy(q, b.name)) : st.items;
    const keep = (b) => b.name === def || b.name === current || b.name === base;
    const hiddenMerged = hasMerged ? matched.filter((b) => b.merged && !keep(b)).length : 0;
    if (hasMerged && !this._brShowMerged) matched = matched.filter((b) => !b.merged || keep(b));
    this._branchMount(st, { hasDates, hasMerged, sort, hiddenMerged });

    // Shown merged branches get their own group under the others, so
    // showing them visibly adds rows instead of only raising folder counts.
    const mergedGroup = this._brShowMerged ? matched.filter((b) => b.merged && !keep(b)) : [];
    const active = mergedGroup.length ? matched.filter((b) => !mergedGroup.includes(b)) : matched;
    const tree = (items) => {
      const root = { children: new Map() };
      for (const b of items) {
        let node = root;
        const parts = b.name.split('/');
        parts.forEach((part, i) => {
          if (!node.children.has(part)) node.children.set(part, { name: part, path: parts.slice(0, i + 1).join('/'), children: new Map() });
          node = node.children.get(part);
        });
        node.branch = b;
      }
      return root;
    };
    const root = tree(active);
    const list = h('ul', { class: 'ht-list ht-branch-list' });
    if (!matched.length) {
      list.append(h('li', { class: 'ht-empty' }, q ? `No branches match “${q}”` : hiddenMerged ? 'Only merged branches here.' : 'No branches.'));
    }
    const count = (node) => (node.branch ? 1 : 0) + [...node.children.values()].reduce((n, c) => n + count(c), 0);
    const newest = (node) => [...node.children.values()].reduce((t, c) => Math.max(t, newest(c)), node.branch?.date ? Date.parse(node.branch.date) || 0 : 0);
    const byName = (a, b) => a.name.localeCompare(b.name);
    const order = sort === 'recent' ? (a, b) => newest(b) - newest(a) || byName(a, b) : byName;

    // The pull request's head branch, the commit's branch, or the one browsed.
    const pull = this.ctx?.kind === 'pull' ? HT.provider.terms.pullRef(this.ctx.pullNumber) : null;
    const currentLabel = pull || (this.ctx?.kind === 'commit' ? 'this commit' : 'current');
    const currentTitle = pull ? `${pull} comes from this branch` : this.ctx?.kind === 'commit' ? 'The commit being viewed is this branch\'s latest' : 'The branch being viewed';
    const leaf = (node, depth, label = node.name) => {
      const b = node.branch;
      const isCurrent = b.name === current;
      const sub = [b.title, b.sha?.slice(0, 7), b.date ? HT.timeAgo(b.date) : ''].filter(Boolean).join(' · ');
      const copy = h(
        'button',
        {
          class: 'ht-act',
          type: 'button',
          title: 'Copy branch name',
          tabindex: '-1',
          onClick: async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ok = await HT.copyText(b.name);
            this._toast(ok ? `Copied ${b.name}` : 'Copy failed');
          },
        },
        HT.icon('copy')
      );
      const compare =
        b.name !== def && HT.provider.compareUrl
          ? h(
              'a',
              { class: 'ht-act', href: HT.safeUrl(HT.provider.compareUrl(this.ctx, def, b.name)), title: `Compare with ${def}`, tabindex: '-1', onClick: (e) => e.stopPropagation() },
              HT.icon('diff')
            )
          : null;
      return h(
        'li',
        { role: 'none' },
        h(
          'a',
          {
            class: `ht-row ht-flat${b.title ? ' ht-two' : ''}${isCurrent ? ' selected' : ''}`,
            href: HT.safeUrl(HT.provider.branchUrl(this.ctx, b.name)),
            tabindex: '-1',
            title: b.title ? `${b.name}: ${b.title}` : b.name,
            style: `--depth:${depth}`,
            'aria-current': isCurrent ? 'true' : null,
            dataset: { key: `branch:${b.name}` },
          },
          h('span', { class: 'ht-chevron' }),
          h('span', { class: 'ht-icon' }, HT.icon('branch')),
          h('span', { class: 'ht-name' }, h('span', { class: 'ht-branch-name' }, depth ? label : b.name), sub ? h('span', { class: 'ht-dir' }, sub) : null),
          isCurrent && (b.name !== def || currentLabel !== 'current') ? h('span', { class: 'ht-badge ht-badge-accent', title: currentTitle }, currentLabel) : null,
          b.name === def ? h('span', { class: 'ht-badge' }, 'default') : null,
          b.name === base ? h('span', { class: 'ht-badge', title: `${HT.provider.terms.pullRef(this.ctx.pullNumber)} merges into ${b.name}` }, 'base') : null,
          b.merged && b.name !== def ? h('span', { class: 'ht-badge' }, 'merged') : null,
          b.protected ? h('span', { class: 'ht-meta', title: 'Protected' }, HT.icon('lock')) : null,
          h('span', { class: 'ht-row-actions' }, copy, compare)
        )
      );
    };
    // `group` keeps the merged group's folders opened apart from the others.
    const walk = (node, depth, group = '') => {
      const kids = [...node.children.values()];
      const folders = kids.filter((c) => c.children.size).sort(order);
      const leaves = kids.filter((c) => !c.children.size).sort(order);
      for (let f of folders) {
        // "release/v2/x" with nothing else under release or v2: one row.
        let label = f.name;
        while (!f.branch && f.children.size === 1 && [...f.children.values()][0].children.size) {
          f = [...f.children.values()][0];
          label += `/${f.name}`;
        }
        const key = group + f.path;
        const open = q ? true : st.open.has(key);
        list.append(
          h(
            'li',
            { role: 'none' },
            h(
              'div',
              {
                class: 'ht-row',
                tabindex: '-1',
                role: 'button',
                style: `--depth:${depth}`,
                'aria-expanded': String(open),
                title: `${f.path}/ · ${count(f)} branch${count(f) === 1 ? '' : 'es'}`,
                dataset: { key: `branch-dir:${key}` },
                onClick: () => {
                  if (st.open.has(key)) st.open.delete(key);
                  else st.open.add(key);
                  this._refreshTab('branches');
                },
              },
              h('span', { class: 'ht-chevron' }, HT.icon('chevron')),
              h('span', { class: 'ht-icon' }, HT.icon(open ? 'folderOpen' : 'folder')),
              h('span', { class: 'ht-name' }, label),
              h('span', { class: 'ht-badge ht-badge-count' }, String(count(f)))
            )
          )
        );
        if (open) walk(f, depth + 1, group);
        // A branch can share its name with a folder only in old repos; show it too.
        if (f.branch && open) list.append(leaf(f, depth + 1));
      }
      for (const l of leaves) list.append(leaf(l, depth));
    };
    // The default branch first, then the current one, outside the folders.
    for (const name of [...new Set([def, base, current].filter(Boolean))]) {
      const b = matched.find((x) => x.name === name);
      if (!b) continue;
      const top = !name.includes('/') && root.children.get(name);
      if (top && top.children.size) continue; // also a folder: leave it in the tree
      list.append(leaf({ name, branch: b, children: new Map() }, 0));
      if (top) root.children.delete(name);
      else if (name.includes('/')) {
        // Pinned on top; its row in the tree stays for context.
      }
    }
    walk(root, 0);
    if (mergedGroup.length) {
      list.append(h('li', { class: 'ht-group' }, `Merged · ${mergedGroup.length}`));
      walk(tree(mergedGroup), 0, 'merged:');
    }
    if (st.more) list.append(h('li', { class: 'ht-empty' }, `Showing the first ${HT.formatCount(st.items.length)} branches.`));
    if (hiddenMerged && !q) {
      const shown = Boolean(this._brShowMerged);
      list.append(
        h(
          'li',
          { class: 'ht-empty' },
          `${hiddenMerged} merged branch${hiddenMerged === 1 ? '' : 'es'} ${shown ? 'shown' : 'hidden'}. `,
          h('button', { class: 'ht-link', type: 'button', onClick: () => { this._brShowMerged = !shown; this._refreshTab('branches'); } }, shown ? 'Hide' : 'Show')
        )
      );
    }
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    this.body.append(list);
  }

  // The branch the page is about: a pull request's head, the branch whose
  // latest commit is the commit being viewed, or the branch being browsed.
  _currentBranch(items = []) {
    const ctx = this.ctx;
    if (ctx?.kind === 'pull') return this.pr?.info?.headRef || null;
    if (ctx?.kind === 'commit') {
      const sha = this.pr?.sha || ctx.sha;
      return items.find((b) => b.sha && b.sha.startsWith(sha))?.name || null;
    }
    return this.code?.ref || this.repo?.defaultBranch || null;
  }

  // Sort and filter for the Branches tab, in the pane's search bar.
  _branchMount(st, { hasDates, hasMerged, sort, hiddenMerged }) {
    if (!hasDates && !hasMerged) return;
    const pane = this._paneOf('branches');
    const tools = h('span', { class: 'ht-ci-tools' });
    const on = sort === 'recent' || Boolean(hasMerged && this._brShowMerged);
    tools.append(
      this._btn(
        'filter',
        'Sort and filter branches',
        (e) => {
          e.stopPropagation();
          this._brMenu = !this._brMenu;
          if (this._brMenu) {
            setTimeout(() =>
              this.shadow.addEventListener('click', () => {
                if (!this._brMenu) return;
                this._brMenu = false;
                this._refreshTab('branches');
              }, { once: true })
            );
          }
          this._refreshTab('branches');
        },
        { class: `ht-btn${on ? ' on' : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': String(Boolean(this._brMenu)) }
      )
    );
    pane.tools = tools;
    pane.bar.insertBefore(tools, pane.expandBtn);
    if (!this._brMenu) return;
    const pick = (patch) => () => {
      Object.assign(this, patch);
      this._brMenu = false;
      this._saveState();
      this._refreshTab('branches');
    };
    const menu = h('div', { class: 'ht-pop', role: 'menu', onClick: (e) => e.stopPropagation() });
    if (hasDates) {
      menu.append(
        h('div', { class: 'ht-pop-title' }, 'Sort'),
        this._popItem(sort === 'name', 'By name', null, 'menuitemradio', pick({ _brSort: 'name' })),
        this._popItem(sort === 'recent', 'Recently updated', null, 'menuitemradio', pick({ _brSort: 'recent' }))
      );
    }
    if (hasMerged) {
      if (hasDates) menu.append(h('div', { class: 'ht-pop-sep' }));
      menu.append(this._popItem(Boolean(this._brShowMerged), 'Show merged branches', hiddenMerged || null, 'menuitemcheckbox', pick({ _brShowMerged: !this._brShowMerged })));
    }
    pane.menu = menu;
    pane.bar.append(menu);
  }

  // One row of a popover menu (CI source filter, branch sort).
  _popItem(on, text, count, role, onClick) {
    return h(
      'button',
      { class: `ht-pop-item${on ? ' on' : ''}`, type: 'button', role, 'aria-checked': String(on), onClick },
      h('span', { class: 'ht-pop-check' }, HT.icon('check')),
      h('span', null, text),
      count != null ? h('span', { class: 'ht-pop-count' }, HT.formatCount(count)) : null
    );
  }

  _renderBranchGraph(st) {
    const q = this._query().trim();
    const current = this._currentBranch(st.items) || this.repo.defaultBranch;
    const candidates = st.items.filter((b) => !q || HT.fuzzy(q, b.name));
    const branches = [...candidates].sort((a, b) =>
      Number(b.name === this.repo.defaultBranch) - Number(a.name === this.repo.defaultBranch) ||
      Number(b.name === current) - Number(a.name === current) || a.name.localeCompare(b.name)).slice(0, 8);
    const key = JSON.stringify(branches.map((b) => [b.name, b.sha]));
    if (st.graph?.key !== key) {
      const graph = (st.graph = { key, loading: true, commits: [], errors: [] });
      this._loadBranchGraph(st, graph, branches);
    }
    const graph = st.graph;
    if (!branches.length) {
      this.body.append(h('div', { class: 'ht-empty' }, q ? `No branches match “${q}”` : 'No branches.'));
      return;
    }

    if (graph.loading) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading graph…'));
      return;
    }
    if (graph.errors.length) {
      this.body.append(h('div', { class: 'ht-graph-note' },
        `Could not load: ${graph.errors.join(', ')}.`,
        h('button', { type: 'button', class: 'ht-btn ht-graph-toggle', onClick: () => {
          st.graph = null; this._refreshTab('branches');
        } }, 'Retry')));
    }
    if (!graph.commits.length) {
      this.body.append(h('div', { class: 'ht-empty' }, 'No commit history available.'));
      return;
    }
    const rows = HT.layoutBranchGraph(graph.commits);
    const rowHeight = 44;
    const positions = new Map(rows.map((r, i) => [r.commit.sha, { ...r, y: i * rowHeight + rowHeight / 2 }]));
    const color = (lane) => `var(--graph-${lane % 6})`;
    const width = Math.max(36, ...rows.map((r) => (r.lane + 1) * 16 + 12));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', rows.length * rowHeight);
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ht-graph-lines');
    const shape = (tag, attrs) => {
      const el = document.createElementNS(svg.namespaceURI, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    };
    for (const { commit, lane } of rows) {
      const { y } = positions.get(commit.sha);
      const x = lane * 16 + 12;
      for (const parent of commit.parents || []) {
        const target = positions.get(parent);
        const py = target?.y ?? y + rowHeight / 2 - 2;
        const px = target ? target.lane * 16 + 12 : x;
        // Bend into the reserved parent lane immediately, then run vertically.
        // A long diagonal would appear to intersect unrelated commits.
        const d = x === px ? `M ${x} ${y} V ${py}` :
          `M ${x} ${y} C ${x} ${y + 12}, ${px} ${y + 10}, ${px} ${y + 22} V ${py}`;
        shape('path', { d,
          fill: 'none', stroke: color(target?.lane ?? lane), 'stroke-width': 1.5, 'stroke-linecap': 'round',
          ...(target ? {} : { 'stroke-dasharray': '2 3' }) });
      }
    }
    for (const { commit, lane } of rows) shape('circle', {
      cx: lane * 16 + 12, cy: positions.get(commit.sha).y, r: 4,
      fill: commit.parents?.length > 1 ? 'var(--panel-bg, var(--bg))' : color(lane),
      stroke: color(lane), 'stroke-width': 1.5,
    });
    const list = h('ol', { class: 'ht-graph-commits', 'aria-label': 'Commit history, newest first' });
    for (const { commit } of rows) {
      const labels = branches.filter((b) => b.sha === commit.sha);
      const url = HT.safeUrl(HT.provider.commitUrl(this.ctx, commit.sha));
      const when = commit.date ? HT.timeAgo(commit.date) : '';
      list.append(h('li', { class: 'ht-graph-commit' },
        h('a', {
          class: 'ht-graph-title', href: url,
          title: `${commit.title || commit.sha}\n${commit.author || 'Unknown author'}${commit.date ? ` · ${commit.date}` : ''}`,
        }, commit.title || commit.sha.slice(0, 7)),
        h('div', { class: 'ht-graph-meta' },
          labels.length ? h('span', { class: 'ht-graph-labels' }, labels.map((b) => h('a', {
            class: `ht-graph-ref${b.name === current ? ' ht-graph-current' : ''}`,
            href: HT.safeUrl(HT.provider.branchUrl(this.ctx, b.name)),
            title: `${b.name}${b.name === current ? ' (current branch)' : ''}${b.name === this.repo.defaultBranch ? ' (default)' : ''}`,
          }, HT.icon('branch'), h('span', null, b.name)))) :
            h('span', { class: 'ht-graph-author' }, commit.author || 'Unknown author'),
          h('a', { class: 'ht-graph-sha', href: url, 'aria-label': `Commit ${commit.sha}` }, commit.sha.slice(0, 7)),
          when ? h('span', { class: 'ht-graph-time', title: commit.date }, when) : null)));
    }
    this.body.append(h('div', { class: 'ht-branch-graph' }, svg, list));
    this.body.append(h('details', { class: 'ht-graph-history-note' },
      h('summary', null, `${rows.length} commits · ${branches.length} branches`),
      h('p', null, `Showing up to 30 recent commits per branch, for ${branches.length} of ${candidates.length}${st.more ? '+' : ''} matching branches. Filter branches to choose which history appears. Dotted lines continue beyond this history.`)));
  }

  async _loadBranchGraph(st, graph, branches) {
    const ctx = this.ctx;
    const provider = HT.provider;
    // Two requests at a time keeps large repositories from flooding the API.
    let next = 0;
    const commits = new Map();
    const worker = async () => {
      while (next < branches.length) {
        if (this.branches !== st || st.graph !== graph) return;
        const branch = branches[next++];
        try {
          const result = await provider.commits(ctx, branch.sha || branch.name, 1, 30);
          for (const commit of result.items) commits.set(commit.sha, commit);
        } catch {
          graph.errors.push(branch.name);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (this.branches !== st || st.graph !== graph) return;
    graph.commits = [...commits.values()];
    graph.loading = false;
    this._refreshTab('branches');
  }

  _setBranches(st, items, more) {
    const first = !st.items;
    st.items = items;
    st.more = more;
    // A handful of folders open by default; a big repository starts closed.
    if (first && items.length <= 40) {
      for (const b of items) {
        const parts = b.name.split('/');
        for (let i = 1; i < parts.length; i++) st.open.add(parts.slice(0, i).join('/'));
      }
    }
  }

  async _loadBranches(st) {
    try {
      const { items, more } = await HT.provider.branches(this.ctx);
      if (this.branches !== st) return;
      this._setBranches(st, items, more);
      st.error = null;
      HT.cache.set(`branches:${st.key}`, { items, more });
    } catch (err) {
      if (!st.items) st.error = err;
    }
    if (this.branches === st) this._refreshTab('branches');
  }

  // ---------- CI/CD (GitHub Actions runs / GitLab pipelines, deployments) ----------

  // Runs for the PR's head commit, or for the branch being browsed.
  _ciTarget() {
    if (!this.repo) return null;
    if (this.ctx.kind === 'pull') {
      const sha = this.pr?.info?.headSha;
      // The head branch is a hint for CIs that build by branch (Jenkins multibranch).
      return sha ? { key: `sha:${sha}`, sha, branch: this.pr.info.headRef, label: HT.provider.terms.pullRef(this.ctx.pullNumber) } : null;
    }
    const ref = this.code?.ref || this.repo.defaultBranch;
    if (/^[0-9a-f]{40}$/i.test(ref)) return { key: `sha:${ref}`, sha: ref, label: ref.slice(0, 7) };
    return { key: `ref:${ref}`, ref, label: ref };
  }

  _ensureCI() {
    const target = this._ciTarget();
    if (!target) return null;
    if (this.ci?.key !== target.key) {
      clearTimeout(this._ciTimer);
      const state = (this.ci = { key: target.key, target, loading: true, limit: 25, extLimit: 10, expanded: new Set(), jobs: new Map() });
      // Paint last time's list at once; the load below refreshes it.
      HT.cache.get(`ci:${HT.url.repoKey(this.ctx)}:${target.key}`).then((snap) => {
        if (!snap || this.ci !== state || state.runs) return;
        Object.assign(state, snap);
        this._rerenderCI(state);
        this._renderStats();
      });
      this._loadCI(state);
    }
    return this.ci;
  }

  // Not memoized: statuses change. The background's ETag cache keeps
  // unchanged polls cheap (304s don't count against the rate limit).
  async _loadCI(state) {
    const ctx = this.ctx;
    try {
      // The site's own pipelines can be turned off per repository.
      state.native = (await HT.store.repoCI(HT.url.repoKey(ctx))).native !== false;
      const none = { runs: [], total: 0, more: false };
      // "Load more" raises the limit.
      const [{ runs, total, more }, deployments] = await Promise.all([
        state.native ? HT.provider.runs(ctx, state.target, state.limit) : none,
        state.native ? HT.provider.deployments(ctx, state.target).catch(() => []) : [],
        this._loadExternalCI(state),
        this._loadOtherCI(state),
      ]);
      const seen = new Set();
      state.runs = runs.filter((r) => !seen.has(r.id) && seen.add(r.id));
      state.count = total;
      state.more = more;
      state.deployments = deployments;
      state.error = null;
      if (!state.ext?.some((s) => s.error)) {
        HT.cache.set(`ci:${HT.url.repoKey(ctx)}:${state.target.key}`, {
          native: state.native, runs: state.runs, count: state.count, more: state.more,
          deployments: state.deployments, ext: state.ext, other: state.other,
        });
      }
      const runIds = new Set(state.expanded);
      if (state.detail) runIds.add(state.detail.runId);
      // External builds are their own job; they refresh with their source.
      await Promise.all([...runIds].filter((id) => !String(id).startsWith('ext:')).map((id) => this._loadJobs(state, id)));
    } catch (err) {
      if (!state.runs) state.error = err;
      else this._toast(err.message);
    }
    state.loading = false;
    state.loadingMore = false;
    if (this.ci !== state) return;
    if (this.tab === 'ci' || this.split === 'ci') {
      this._rerenderCI(state);
      this._renderStats();
    }
    this._renderTabs(); // the CI/CD tab's status dot
    this._scheduleCIPoll(state);
  }

  // Builds from the repository's external CI servers (TeamCity, Jenkins,
  // custom endpoints). state.ext is a list, one entry per source:
  //   { type, label, server, builds, url?, note?, error?, needsAccess? }
  // plus, when no TeamCity source is set, a suggestion from a teamcity.toml
  // or GitLab's TeamCity integration ({ suggest: { server, ids, from } }).
  async _loadExternalCI(state) {
    const ctx = this.ctx;
    const { target } = state;
    const key = HT.url.repoKey(ctx);
    const conf = await HT.store.repoCI(key);
    const sources = HT.ci.sources(conf);
    const base = this._ciOpts(target, key);
    base.limit = state.extLimit || 10;
    const results = await Promise.all(
      sources.map(async (source) => {
        const adapter = HT.ci.types[source.type];
        const entry = { type: source.type, label: HT.ci.label(source), server: HT.ci.originOf(source.server), builds: [] };
        try {
          Object.assign(entry, await adapter.load({ ...base, source }));
        } catch (err) {
          entry.error = err;
        }
        return entry;
      })
    );
    // A teamcity.toml or GitLab integration only suggests a server: the user
    // confirms it in the CI/CD tab (a repository file must not change
    // settings or send requests on its own). "Not now", or removing the
    // server in Settings, hides the suggestion for this repository.
    if (!sources.some((s) => s.type === 'teamcity') && !conf.hintOff) {
      const integ = await this._teamcityHint(ctx).catch(() => null);
      const server = integ && HT.ci.originOf(integ.url);
      if (server) results.push({ type: 'teamcity', label: 'TeamCity', server, builds: [], suggest: { server, ids: HT.teamcityIds(integ.buildType), from: integ.from } });
    }
    for (const r of results) for (const b of r.builds || []) if (state.jobs.has(HT.ci.runId(b))) state.jobs.set(HT.ci.runId(b), { list: [b] });
    state.ext = results;
  }

  // What an external CI adapter needs to find this repository's builds.
  _ciOpts(target, repoKey) {
    const ctx = this.ctx;
    return {
      repoKey,
      repo: { owner: ctx.owner, repo: ctx.repo, host: ctx.host },
      target: { ...target, isDefault: target.ref === this.repo?.defaultBranch },
      recentShas: () => (target.sha ? Promise.resolve([target.sha]) : HT.provider.recentShas(ctx, target.ref)),
      integration: () => this._teamcityHint(ctx),
      statuses: (sha) => HT.provider.externalStatuses(ctx, sha),
    };
  }

  // GitHub and Bitbucket Server: checks and statuses from other CIs on the
  // head commit (GitLab lists those as external pipelines already).
  async _loadOtherCI(state) {
    if (HT.provider.id !== 'github' && !HT.provider.statusCI) return;
    const { target } = state;
    try {
      const sha = target.sha || (await HT.provider.recentShas(this.ctx, target.ref))[0];
      state.other = sha ? await HT.provider.externalStatuses(this.ctx, sha) : [];
    } catch {
      state.other = [];
    }
  }

  _scheduleCIPoll(state) {
    const busy =
      state.runs?.some((r) => r.status !== 'completed') ||
      state.deployments?.some((d) => d.busy) ||
      state.ext?.some((s) => s.builds?.some((b) => b.status !== 'completed')) ||
      state.other?.some((j) => j.status !== 'completed');
    clearTimeout(this._ciTimer);
    if (!busy || this.ci !== state) return;
    this._ciTimer = setTimeout(() => {
      if (this.ci === state && this._ciShown()) this._loadCI(state);
      else if (this.ci === state) state.stale = true;
    }, 15000);
  }

  async _loadJobs(state, runId) {
    const entry = state.jobs.get(runId) || {};
    state.jobs.set(runId, { ...entry, loading: !entry.list });
    try {
      const run = state.runs?.find((r) => r.id === runId);
      state.jobs.set(runId, { list: await HT.provider.jobs(this.ctx, runId, run) });
    } catch (err) {
      state.jobs.set(runId, { error: err });
    }
  }

  // Map a run/job/deployment status to an icon and color.
  _ciStatus(status, conclusion) {
    if (status && status !== 'completed') {
      if (status === 'in_progress') return ['ciRunning', 'running', 'In progress'];
      return ['ciQueued', 'queued', status[0].toUpperCase() + status.slice(1).replace('_', ' ')];
    }
    switch (conclusion) {
      case 'success': return ['ciOk', 'ok', 'Success'];
      case 'failure': case 'timed_out': case 'startup_failure': case 'error': return ['ciFail', 'fail', conclusion === 'timed_out' ? 'Timed out' : 'Failed'];
      case 'action_required': return ['ciWarn', 'warn', 'Action required'];
      case 'allowed_failure': return ['ciWarn', 'warn', 'Failed (allowed to fail)'];
      case 'manual': return ['ciQueued', 'muted', 'Manual'];
      case 'cancelled': return ['ciSkip', 'muted', 'Cancelled'];
      case 'inactive': return ['ciSkip', 'muted', 'Inactive'];
      default: return ['ciSkip', 'muted', conclusion ? conclusion[0].toUpperCase() + conclusion.slice(1) : 'Skipped'];
    }
  }

  _ciIcon(status, conclusion) {
    const [icon, tone, label] = this._ciStatus(status, conclusion);
    return h('span', { class: `ht-icon ht-ci ht-ci-${tone}`, title: label }, HT.icon(icon));
  }

  _renderCI() {
    const state = this._ensureCI();
    if (!state || (state.loading && !state.runs)) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), `Loading ${HT.provider.terms.noRuns}…`));
      return;
    }
    if (state.stale) {
      state.stale = false;
      this._loadCI(state);
    }
    if (state.error) {
      this._renderError(state.error);
      return;
    }
    if (state.detail) {
      this._renderJobDetail(state);
      return;
    }
    const q = this._query().trim();
    const list = h('ul', { class: 'ht-list ht-ci-list' });
    // One timeline for every source, newest first; the filter icon narrows it.
    const all = this._ciEntries(state, q);
    const sources = [...new Map(all.map((e) => [e.src, e.label])).entries()];
    const src = sources.some(([id]) => id === this._ciSource) ? this._ciSource : 'all';
    const entries = src === 'all' ? all : all.filter((e) => e.src === src);
    const skipped = (state.runs || []).filter((r) => r.conclusion === 'skipped' && (!q || HT.fuzzy(q, r.name || ''))).length;

    if (state.deployments?.length && !q && src === 'all') {
      list.append(h('li', { class: 'ht-group' }, 'Deployments'));
      for (const d of state.deployments) {
        const conclusion = d.state === 'error' ? 'failure' : d.state;
        list.append(
          h(
            'li',
            { role: 'none' },
            h(
              'a',
              { class: 'ht-row', href: d.url, target: '_blank', rel: 'noopener', tabindex: '-1', title: `${d.environment}: ${d.state} · ${d.ref}`, style: '--depth:0' },
              h('span', { class: 'ht-chevron' }),
              d.busy ? this._ciIcon(d.state === 'in_progress' ? 'in_progress' : 'queued') : this._ciIcon('completed', conclusion),
              h('span', { class: 'ht-name' }, d.environment, h('span', { class: 'ht-dir' }, `${d.ref} · ${HT.timeAgo(d.when)}`)),
              h('span', { class: 'ht-row-actions' }, h('span', { class: 'ht-act', title: 'Open' }, HT.icon('external')))
            )
          )
        );
      }
    }

    this._ciMount(state, { all, sources, src, skipped });
    const noted = src === 'all' || src.startsWith('ext:') ? this._ciNotes(list, state, src) : false;
    if (!entries.length) {
      let msg = null;
      if (q) msg = `No ${HT.provider.terms.noRuns} match “${q}”`;
      else if (skipped && !this._ciShowSkipped) msg = 'Only skipped runs here.';
      else if (!noted) {
        msg = state.native === false
          ? `${HT.provider.name}'s ${HT.provider.terms.noRuns} are hidden for this repository (Settings).`
          : `No ${HT.provider.terms.noRuns} for ${state.target.label}.`;
      }
      if (msg) list.append(h('li', { class: 'ht-empty' }, msg));
    }
    const mixed = sources.length > 1;
    for (const e of entries) {
      if (e.kind === 'run') this._ciRunRow(list, state, e.item, mixed);
      else if (e.kind === 'ext') this._ciBuildRow(list, state, e.item, mixed, e.source);
      else this._ciOtherRow(list, state, e.item);
    }
    const more = state.more || Boolean(state.ext?.some((s) => (s.builds?.length || 0) >= (state.extLimit || 10)));
    if (entries.length && more) {
      list.append(
        h(
          'li',
          { class: 'ht-more' },
          state.loadingMore
            ? h('span', { class: 'ht-loading-row' }, h('span', { class: 'ht-spinner' }), 'Loading…')
            : h(
                'button',
                {
                  class: 'ht-secondary',
                  type: 'button',
                  onClick: () => {
                    state.limit += 25;
                    state.extLimit = (state.extLimit || 10) + 25;
                    state.loadingMore = true;
                    this._rerenderCI(state);
                    this._loadCI(state);
                  },
                },
                `Load more (${HT.formatCount(entries.length)} shown${state.count != null && src === 'all' ? ` · ${HT.formatCount(state.count)} ${HT.provider.name} total` : ''})`
              )
        )
      );
    }
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    this.body.append(list);
  }

  // Every source's runs as one list, newest first. Skipped runs (workflows
  // whose conditions didn't match) are mostly noise; hidden unless asked.
  _ciEntries(state, q) {
    const out = [];
    const when = (x) => Date.parse(x.run_started_at || x.started_at || x.created_at || x.completed_at || '') || 0;
    for (const r of state.runs || []) {
      if ((q && !HT.fuzzy(q, r.name || '')) || (r.conclusion === 'skipped' && !this._ciShowSkipped)) continue;
      out.push({ src: HT.provider.id, label: HT.provider.name, time: when(r), kind: 'run', item: r });
    }
    for (const s of state.ext || []) {
      for (const b of s.builds || []) {
        if (q && !HT.fuzzy(q, `${s.label} ${b.name}`)) continue;
        out.push({ src: HT.ci.sourceKey(s), label: s.label, time: when(b), kind: 'ext', item: b, source: s });
      }
    }
    for (const j of state.other || []) {
      if (q && !HT.fuzzy(q, `${j.ci} ${j.name}`)) continue;
      out.push({ src: `ci:${j.ci}`, label: j.ci, time: when(j), kind: 'other', item: j });
    }
    return out.sort((a, b) => b.time - a.time);
  }

  // The CI controls live in the pane's search bar, beside its filter icon:
  // a source filter (source, skipped runs) and a link to everything on the
  // site.
  _ciMount(state, { all, sources, src, skipped }) {
    const pane = this._paneOf('ci');
    const tools = h('span', { class: 'ht-ci-tools' });
    const filtered = src !== 'all' || this._ciShowSkipped;
    if (sources.length > 1 || skipped || this._ciShowSkipped) {
      const label = src === 'all' ? 'Show only one source' : `Showing ${sources.find(([id]) => id === src)[1]} only`;
      tools.append(
        this._btn(
          'filter',
          label,
          (e) => {
            e.stopPropagation();
            this._ciMenu = !this._ciMenu;
            if (this._ciMenu) {
              // Any click elsewhere closes the menu.
              setTimeout(() =>
                this.shadow.addEventListener('click', () => {
                  if (!this._ciMenu) return;
                  this._ciMenu = false;
                  this._rerenderCI(state);
                }, { once: true })
              );
            }
            this._rerenderCI(state);
          },
          { class: `ht-btn${filtered ? ' on' : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': String(Boolean(this._ciMenu)) }
        )
      );
    }
    const site = `Open all ${HT.provider.terms.noRuns} on ${HT.provider.name}`;
    tools.append(h('a', { class: 'ht-btn ht-ci-site', href: HT.provider.ciUrl(this.ctx), title: site, 'aria-label': site }, HT.icon('external')));
    pane.tools = tools;
    pane.bar.insertBefore(tools, pane.expandBtn);
    if (!this._ciMenu) return;

    const item = (...args) => this._popItem(...args);
    const pick = (id) => () => {
      this._ciSource = id;
      this._ciMenu = false;
      this._rerenderCI(state);
    };
    const menu = h('div', { class: 'ht-pop', role: 'menu', onClick: (e) => e.stopPropagation() }, item(src === 'all', 'All', all.length, 'menuitemradio', pick('all')));
    for (const [id, text] of sources) menu.append(item(src === id, text, all.filter((e) => e.src === id).length, 'menuitemradio', pick(id)));
    if (skipped || this._ciShowSkipped) {
      menu.append(
        h('div', { class: 'ht-pop-sep' }),
        item(this._ciShowSkipped, 'Show skipped runs', skipped, 'menuitemcheckbox', () => {
          this._ciShowSkipped = !this._ciShowSkipped;
          this._saveState();
          this._rerenderCI(state);
        })
      );
    }
    pane.menu = menu;
    pane.bar.append(menu);
  }

  _ciRunRow(list, state, run, mixed) {
    const open = state.expanded.has(run.id);
    // The row toggles its jobs; the provider's page is one click away on the icon.
    const row = h(
      'div',
      {
        class: 'ht-row',
        tabindex: '-1',
        role: 'button',
        title: `${run.name} #${run.run_number}: ${run.display_title}`,
        style: '--depth:0',
        'aria-expanded': String(open),
        dataset: { key: `run:${run.id}` },
        onClick: () => this._toggleRunJobs(state, run.id),
      },
      h('span', { class: 'ht-chevron' }, HT.icon('chevron')),
      this._ciIcon(run.status, run.conclusion),
      h('span', { class: 'ht-name' }, run.name, h('span', { class: 'ht-dir' }, `#${run.run_number} · ${mixed ? `${HT.provider.name} · ` : ''}${run.event.replace(/_/g, ' ')} · ${HT.timeAgo(run.run_started_at || run.created_at)}`)),
      this._externalAction(run.html_url, `Open ${HT.provider.terms.run} on ${HT.provider.name}`)
    );
    list.append(h('li', { role: 'none' }, row));
    if (open) this._appendJobs(list, state, run);
  }

  // A build from an external CI opens straight into its steps and log.
  _ciBuildRow(list, state, b, mixed, source) {
    const time = this._jobTime(b);
    const when = HT.timeAgo(b.started_at || b.created_at);
    const id = HT.ci.runId(b);
    list.append(
      h(
        'li',
        { role: 'none' },
        h(
          'div',
          {
            class: 'ht-row ht-ci-flat',
            tabindex: '-1',
            role: 'button',
            title: `${b.name}${b.run_number != null ? ` #${b.run_number}` : ''}${b.statusText || b.description ? `: ${b.statusText || b.description}` : ''}`,
            style: '--depth:0',
            dataset: { key: id },
            onClick: () => this._openJob(state, id, b.id, b),
          },
          h('span', { class: 'ht-chevron' }),
          this._ciIcon(b.status, b.conclusion),
          h(
            'span',
            { class: 'ht-name' },
            b.name,
            h('span', { class: 'ht-dir' }, [b.run_number != null ? `#${b.run_number}` : '', mixed ? source.label : '', b.branch || state.target.label, when].filter(Boolean).join(' · '))
          ),
          time ? h('span', { class: 'ht-meta ht-ci-time' }, time) : null,
          this._externalAction(b.html_url, `Open build on ${source.label}`)
        )
      )
    );
  }

  // GitHub: another CI's check on the head commit.
  _ciOtherRow(list, state, job) {
    const time = this._jobTime(job);
    list.append(
      h(
        'li',
        { role: 'none' },
        h(
          'div',
          {
            class: 'ht-row ht-ci-flat',
            tabindex: '-1',
            role: 'button',
            title: `${job.ci}: ${job.name}${job.description ? ` — ${job.description}` : ''}`,
            style: '--depth:0',
            dataset: { key: `job:${job.id}` },
            onClick: () => this._openExternal(state, job),
          },
          h('span', { class: 'ht-chevron' }),
          this._ciIcon(job.status, job.conclusion),
          h('span', { class: 'ht-name' }, job.name, h('span', { class: 'ht-dir' }, job.ci)),
          time ? h('span', { class: 'ht-meta ht-ci-time' }, time) : null,
          this._externalAction(job.html_url, `Open on ${job.ci}`)
        )
      )
    );
  }

  // Set-up notes of the external CI servers (permission, errors, a suggested
  // server), one per source, or only the source being filtered. Returns
  // whether any was shown.
  _ciNotes(list, state, src = 'all') {
    let shown = false;
    const note = (...children) => {
      list.append(h('li', { class: 'ht-empty ht-ci-note' }, ...children));
      shown = true;
    };
    const key = HT.url.repoKey(this.ctx);
    for (const s of state.ext || []) {
      if (src !== 'all' && src !== HT.ci.sourceKey(s)) continue;
      if (s.suggest) {
        const { server, ids, from } = s.suggest;
        const source = from === 'file' ? 'Its teamcity.toml' : `Its ${HT.provider.name} integration`;
        note(
          h('span', null, `${source} points to TeamCity on ${new URL(server).host}${ids ? ` (${ids})` : ''}.`),
          h(
            'button',
            {
              class: 'ht-link',
              type: 'button',
              onClick: async () => {
                const sources = [...HT.ci.sources(await HT.store.repoCI(key)), { type: 'teamcity', server, ...(ids ? { ids } : {}) }];
                await HT.store.setRepoCI(key, { sources, teamcity: null, hintOff: null });
                this._askAccess(server);
              },
            },
            'Show its builds here'
          ),
          h('button', { class: 'ht-link', type: 'button', onClick: () => HT.store.setRepoCI(key, { hintOff: true }) }, 'Not now')
        );
      } else if (s.needsAccess) {
        note(
          h('span', null, `Hector needs your permission to read ${s.label} builds from ${new URL(s.needsAccess).host}.`),
          h('button', { class: 'ht-link', type: 'button', onClick: () => this._askAccess(s.needsAccess) }, 'Allow access')
        );
      } else if (s.error || s.note) {
        note(
          h('span', null, s.error ? `Couldn't load ${s.label} builds. ${s.error.message}` : s.note),
          h('button', { class: 'ht-link', type: 'button', onClick: () => this.toggleSettings(true) }, 'Settings')
        );
      }
    }
    return shown;
  }

  // Where the repository says its TeamCity is: GitLab's TeamCity integration,
  // else a teamcity.toml at the root of the default branch. { url, buildType }
  // or null. Remembered per repository until a refresh.
  _teamcityHint(ctx) {
    const key = HT.url.repoKey(ctx);
    if (this._tcHints?.key !== key) this._tcHints = { key, promise: null };
    this._tcHints.promise ||= (async () => {
      const integration = await HT.provider.teamcityIntegration?.(ctx).catch(() => null);
      if (integration) return { ...integration, from: 'integration' };
      const ref = this.repo?.defaultBranch;
      if (!ref) return null;
      const text = await HT.provider.repoFile?.(ctx, ref, 'teamcity.toml').catch(() => null);
      const found = text ? HT.teamcity.parseConfig(text) : null;
      return found && { ...found, from: 'file' };
    })();
    return this._tcHints.promise;
  }

  // Opens the small window that asks for access to a server.
  // ---------- Custom tabs ----------

  _renderCustomTab(def) {
    const v = HT.customTabs.vars(this);
    if (!v || (!this.code && !this.pr)) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading…'));
      return;
    }
    const q = this._query().trim();
    const list = h('ul', { class: 'ht-list ht-custom-list' });
    const row = (href, icon, title, sub, date) =>
      h(
        'li',
        { role: 'none' },
        h(
          'a',
          { class: `ht-row ht-flat${sub ? ' ht-two' : ''}`, href, target: '_blank', rel: 'noopener noreferrer', tabindex: '-1', title: sub ? `${title}\n${sub}` : title, style: '--depth:0' },
          h('span', { class: 'ht-chevron' }),
          h('span', { class: 'ht-icon' }, HT.icon(icon)),
          h('span', { class: 'ht-name' }, h('span', { class: 'ht-custom-title' }, title), sub ? h('span', { class: 'ht-dir' }, sub) : null),
          date ? h('span', { class: 'ht-meta', title: date }, HT.timeAgo(date)) : null
        )
      );
    list.addEventListener('keydown', (e) => this._ciKey(e, list));

    if (def.type === 'links') {
      for (const l of def.links) {
        const href = HT.customTabs.link(l.url, v);
        if (!href || (q && !HT.fuzzy(q, l.label))) continue;
        list.append(row(href, 'external', l.label, new URL(href).host));
      }
      if (!list.children.length) list.append(h('li', { class: 'ht-empty' }, q ? `No links match “${q}”` : 'No links for this page.'));
      this.body.append(list);
      return;
    }

    const ref = this.code?.ref || v.ref;
    const target = def.type === 'file' ? `${def.path}@${ref}` : HT.customTabs.fill(def.feed.url, v);
    this.custom ||= new Map();
    let st = this.custom.get(def.id);
    if (st?.target !== target) {
      st = { target, loading: true };
      this.custom.set(def.id, st);
      this._loadCustom(def, st, v, ref);
    }
    if (st.loading) {
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading…'));
      return;
    }
    if (st.needsAccess) {
      this.body.append(
        h(
          'div',
          { class: 'ht-empty' },
          `Hector isn't allowed to reach ${new URL(st.needsAccess).host} yet. `,
          h('button', { class: 'ht-link', type: 'button', onClick: () => HT.api.send({ type: 'access:request', origin: st.needsAccess, why: `For the “${def.name}” tab.` }).catch(() => {}) }, 'Allow access')
        )
      );
      return;
    }
    if (st.error) {
      this.body.append(
        h(
          'div',
          { class: 'ht-empty' },
          st.error,
          ' ',
          h('button', { class: 'ht-link', type: 'button', onClick: () => (this.custom.delete(def.id), this._refreshTab(def.id)) }, 'Retry')
        )
      );
      return;
    }

    if (def.type === 'file') {
      const open = HT.safeUrl(HT.provider.codeUrl(this.ctx, ref, def.path, false));
      this.body.append(
        h('div', { class: 'ht-scope' }, HT.icon('file'), h('span', null, `${def.path} at ${this.refLabel || ref}`), open ? h('a', { class: 'ht-link ht-scope-link', href: open }, 'Open ↗') : null)
      );
      const lines = st.text.replace(/\r?\n$/, '').split(/\r?\n/);
      const needle = q.toLowerCase();
      const view = h('div', { class: 'ht-file-view', role: 'document' });
      let shown = 0;
      lines.forEach((line, i) => {
        if (needle && !line.toLowerCase().includes(needle)) return;
        shown++;
        view.append(h('div', { class: 'ht-file-line' }, h('span', { class: 'ht-file-no' }, String(i + 1)), h('span', { class: 'ht-file-text' }, line || ' ')));
      });
      if (!shown) view.append(h('div', { class: 'ht-empty' }, `No lines match “${q}”`));
      this.body.append(view);
      return;
    }

    for (const it of st.items) {
      if (q && !HT.fuzzy(q, `${it.title} ${it.subtitle}`)) continue;
      list.append(row(it.link, def.icon, it.title || '(untitled)', it.subtitle, it.date));
    }
    if (!list.children.length) list.append(h('li', { class: 'ht-empty' }, q ? `Nothing matches “${q}”` : 'The feed is empty.'));
    this.body.append(list);
  }

  async _loadCustom(def, st, v, ref) {
    try {
      if (def.type === 'file') {
        const text = await HT.provider.repoFile(this.ctx, ref, def.path).catch((err) => {
          if (err.status === 404) return null;
          throw err;
        });
        if (text == null) st.error = `There's no ${def.path} at ${this.refLabel || ref}.`;
        else st.text = text.length > 500000 ? `${text.slice(0, 500000)}\n… (cut at 500 KB)` : text;
      } else {
        const res = await HT.api.send({ type: 'feed', url: st.target });
        if (res?.needsAccess) st.needsAccess = new URL(st.target).origin;
        else if (!res?.ok) st.error = res?.error || 'The feed could not be read.';
        else {
          const raw = def.feed.items ? HT.customTabs.dig(res.data, def.feed.items) : res.data;
          if (!Array.isArray(raw)) st.error = def.feed.items ? `“${def.feed.items}” in the answer is not a list.` : 'The answer is not a list; set where the items are.';
          else {
            st.items = raw.slice(0, 300).map((item) => ({
              title: HT.customTabs.fill(def.feed.title, v, item),
              subtitle: def.feed.subtitle ? HT.customTabs.fill(def.feed.subtitle, v, item) : '',
              link: def.feed.link ? HT.customTabs.link(def.feed.link, v, item) : null,
              date: def.feed.date ? HT.customTabs.dig(item, def.feed.date) : null,
            }));
          }
        }
      }
    } catch (err) {
      st.error = err.message;
      HT.debug?.note('custom tab', err);
    }
    st.loading = false;
    if (this.custom?.get(def.id) === st) this._refreshTab(def.id);
  }

  _askAccess(server) {
    const why = `To show TeamCity builds for ${this.ctx.owner}/${this.ctx.repo} in the CI/CD tab.`;
    HT.api.send({ type: 'access:request', origin: server, why }).catch((err) => this._toast(err.message));
  }

  _externalAction(url, title) {
    return h(
      'span',
      { class: 'ht-row-actions' },
      h(
        'a',
        { class: 'ht-act', href: HT.safeUrl(url), title, tabindex: '-1', onClick: (e) => e.stopPropagation() },
        HT.icon('external')
      )
    );
  }

  _appendJobs(list, state, run) {
    const jobs = state.jobs.get(run.id);
    if (!jobs || jobs.loading) {
      list.append(h('li', { class: 'ht-loading-row', style: '--depth:1' }, h('span', { class: 'ht-spinner' }), 'Loading jobs…'));
      return;
    }
    if (jobs.error) {
      list.append(h('li', { class: 'ht-loading-row', style: '--depth:1' }, jobs.error.message));
      return;
    }
    for (const job of jobs.list) {
      const time = this._jobTime(job);
      list.append(
        h(
          'li',
          { role: 'none' },
          h(
            'div',
            {
              class: 'ht-row',
              tabindex: '-1',
              role: 'button',
              title: job.external ? `${job.name}${job.description ? `: ${job.description}` : ''}` : `${job.name}: show steps and logs`,
              style: '--depth:1',
              dataset: { key: `job:${job.id}` },
              onClick: () => (job.external ? this._openExternal(state, job) : this._openJob(state, run.id, job.id)),
            },
            h('span', { class: 'ht-chevron' }),
            this._ciIcon(job.status, job.conclusion),
            h('span', { class: 'ht-name' }, job.name, job.external && job.description ? h('span', { class: 'ht-dir' }, job.description) : null),
            time ? h('span', { class: 'ht-meta ht-ci-time' }, time) : null,
            this._externalAction(job.html_url, `Open job on ${HT.provider.name}`)
          )
        )
      );
    }
  }

  // A job from another CI: a build on a server set up for this repository
  // (TeamCity, Jenkins) opens in the sidebar; anything else opens on its site.
  async _openExternal(state, job) {
    const sources = HT.ci.sources(await HT.store.repoCI(HT.url.repoKey(this.ctx)));
    const found = HT.ci.linkFor(job.html_url, sources);
    if (found?.adapter.build) {
      try {
        const build = await found.adapter.build(found.link.server, found.link);
        this._openJob(state, HT.ci.runId(build), build.id, build);
        return;
      } catch (err) {
        this._toast(err.message);
      }
    }
    const url = HT.safeUrl(job.html_url);
    if (url) window.open(url, '_blank', 'noopener');
  }

  _jobTime(item) {
    if (item.duration != null) return HT.duration(item.duration);
    if (!item.started_at) return '';
    const end = item.completed_at ? new Date(item.completed_at) : Date.now();
    return HT.duration(end - new Date(item.started_at));
  }

  async _toggleRunJobs(state, runId) {
    if (state.expanded.has(runId)) state.expanded.delete(runId);
    else {
      state.expanded.add(runId);
      if (!state.jobs.get(runId)?.list) {
        const pending = this._loadJobs(state, runId);
        this._rerenderCI(state);
        await pending;
      }
    }
    this._rerenderCI(state);
    this._scheduleCIPoll(state);
  }

  // Re-render the CI view and keep keyboard focus on the same row.
  _rerenderCI(state) {
    if (this.ci !== state) return;
    const key = this.shadow.activeElement?.dataset?.key;
    if (this.tab === 'ci' && !this.settingsOpen) {
      const scroll = this.body.scrollTop;
      this.renderBody({ split: false });
      this.body.scrollTop = scroll;
    }
    if (this.split === 'ci') this._renderSplit();
    if (key) this._ciBody().querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
    this._updateExpandBtn();
  }

  // The pane showing CI (the split pane when CI is below).
  _ciBody() {
    return this._paneOf('ci').body;
  }


  // CI is on screen in either pane.
  _ciShown() {
    return this.visible && (this.tab === 'ci' || this.split === 'ci');
  }

  // Expand/collapse all: run jobs in the list, steps in a job's detail view.
  _toggleCIExpandAll() {
    const state = this.ci;
    if (!state?.runs) return;
    if (state.detail) {
      const d = state.detail;
      const steps = d.steps || [];
      if (d.open.size) d.open.clear();
      else for (const s of steps) d.open.add(s.number);
      this._rerenderCI(state);
      return;
    }
    if (state.expanded.size) {
      state.expanded.clear();
      this._rerenderCI(state);
      return;
    }
    const q = this._ciSearch().value.trim();
    const runs = q ? state.runs.filter((r) => HT.fuzzy(q, r.name || '')) : state.runs;
    for (const r of runs) state.expanded.add(r.id);
    const missing = runs.filter((r) => !state.jobs.get(r.id)?.list);
    this._rerenderCI(state);
    Promise.all(missing.map((r) => this._loadJobs(state, r.id))).then(() => {
      this._rerenderCI(state);
      this._scheduleCIPoll(state);
    });
  }

  _ciHasExpanded() {
    const state = this.ci;
    if (!state) return false;
    return state.detail ? state.detail.open.size > 0 : state.expanded.size > 0;
  }

  // ---- job detail: steps and logs, inside the sidebar ----

  _detailJob(state) {
    const d = state.detail;
    return state.jobs.get(d.runId)?.list?.find((j) => j.id === d.jobId) || d.job;
  }

  // `extBuild`: a build from an external CI (TeamCity, Jenkins, …), which is
  // its own run; its adapter serves the job view.
  _openJob(state, runId, jobId, extBuild = null) {
    if (extBuild) state.jobs.set(runId, { list: [extBuild] });
    const job = state.jobs.get(runId)?.list?.find((j) => j.id === jobId);
    state.detail = { runId, jobId, job, open: new Set(), logs: null, source: extBuild ? HT.ci.types[extBuild.ci] : HT.provider };
    this._ciSearch().value = '';
    this._rerenderCI(state);
    this._ciBody().scrollTop = 0;
    this._ciBody().querySelector('.ht-ci-back')?.focus();
  }

  _closeJob(state) {
    const { jobId, runId } = state.detail || {};
    state.detail = null;
    this._ciSearch().value = '';
    this._rerenderCI(state);
    this._ciBody().querySelector(`[data-key="job:${CSS.escape(String(jobId))}"], [data-key="${CSS.escape(String(runId))}"]`)?.focus();
  }

  // Logs load once a job has finished, or (GitLab) while it runs too; a
  // refresh keeps showing the previous text until the new one arrives.
  async _loadLogs(state, detail, refresh = false) {
    if (detail.logsLoading) return;
    const job = this._detailJob(state);
    const final = job.status === 'completed';
    detail.logsLoading = true;
    if (!refresh) detail.logs = { loading: true };
    try {
      detail.logs = { text: await detail.source.log(this.ctx, job) };
      detail.logsFinal = final;
    } catch (err) {
      if (!refresh || !detail.logs?.text) detail.logs = { error: err };
      if (final) detail.logsFinal = true;
    }
    detail.logsLoading = false;
    if (state.detail === detail) this._rerenderCI(state);
  }

  // While a job runs, refresh just that job (and its log, where the API has
  // it) every 5s; 304s are free.
  _scheduleJobPoll(state, d) {
    if (this._jobTimer?.detail === d) return;
    clearTimeout(this._jobTimer?.id);
    const id = setTimeout(async () => {
      this._jobTimer = null;
      if (this.ci !== state || state.detail !== d || !this._ciShown()) return;
      try {
        const job = await d.source.job(this.ctx, d.jobId, d.runId);
        const jobs = state.jobs.get(d.runId);
        if (jobs?.list) jobs.list = jobs.list.map((j) => (j.id === job.id ? job : j));
        d.job = job;
        if (d.source.liveLogs && job.status !== 'completed') await this._loadLogs(state, d, true);
      } catch {
        // Try again on the next tick.
      }
      if (state.detail === d) this._rerenderCI(state);
    }, 5000);
    this._jobTimer = { id, detail: d };
  }

  _renderJobDetail(state) {
    const { pane } = this;
    const d = state.detail;
    const job = this._detailJob(state);
    // A build from an external CI is its own run.
    const run = job?.ci ? job : state.runs.find((r) => r.id === d.runId);
    if (!job) {
      state.detail = null;
      this._renderCI();
      return;
    }
    // A job that just finished: fetch its logs now. A running one: follow
    // its steps every few seconds.
    if (job.status === 'completed' ? !d.logsFinal : d.source.liveLogs && !d.logs) this._loadLogs(state, d, Boolean(d.logs?.text));
    if (job.status !== 'completed') this._scheduleJobPoll(state, d);

    // Steps (GitHub: from the API; GitLab: from the log's sections) and the
    // log lines of each.
    const text = d.logs?.text ?? null;
    if (d.parsedText !== text || d.parsedJob !== job) {
      Object.assign(d, d.source.steps(job, text), { parsedText: text, parsedJob: job });
    }
    const { steps, byStep } = d;
    // Open the failing step, like GitHub does.
    if (!d.autoOpened && steps.length) {
      d.autoOpened = true;
      const failed = steps.find((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion));
      if (failed) d.open.add(failed.number);
    }

    // Laid out like GitHub's job page: the run title on the page surface,
    // then the job in a bordered inset card (job name in link color, a
    // "succeeded … in …" line, then the steps).
    const back = h(
      'button',
      { class: 'ht-ci-back', type: 'button', title: 'Back to runs (Esc)', onClick: () => this._closeJob(state) },
      h('span', { class: 'ht-ci-back-icon' }, HT.icon('chevron')),
      h('span', null, HT.provider.terms.allRuns)
    );
    // A TeamCity build is both the run and the job: name it once, in the card.
    const merged = run === job;
    const title = merged
      ? null
      : h(
          'div',
          { class: 'ht-ci-title' },
          run ? this._ciIcon(run.status, run.conclusion) : null,
          h('h2', { title: run ? `${run.name} #${run.run_number}` : '' }, run?.name || 'Workflow run', run ? h('span', null, ` #${run.run_number}`) : null)
        );
    const head = h(
      'div',
      { class: 'ht-ci-card-head' },
      merged ? this._ciIcon(job.status, job.conclusion) : null,
      h(
        'div',
        { class: 'ht-ci-head-text' },
        h(
          'a',
          { class: 'ht-ci-job-name', href: HT.safeUrl(job.html_url), title: `Open job on ${d.source.name}` },
          job.name,
          merged && job.run_number != null ? h('span', { class: 'ht-ci-job-num' }, ` #${job.run_number}`) : null
        ),
        h(
          'span',
          null,
          job.status !== 'completed' ? h('span', { class: 'ht-live', title: 'Updates every 5 seconds' }, 'Live') : null,
          this._jobSentence(job)
        )
      ),
      // GitHub keeps log search and refresh in the card header; here they
      // are icon buttons, and search opens on demand.
      h(
        'div',
        { class: 'ht-ci-card-actions' },
        this._btn('search', 'Search logs', () => {
          d.searchOpen = !(d.searchOpen || pane.search.value);
          if (!d.searchOpen) {
            pane.search.value = '';
            this._rerenderCI(state);
          } else {
            this._rerenderCI(state);
            pane.search.focus();
          }
        }),
        this._btn(this._ciHasExpanded() ? 'collapseAll' : 'expandAll', this._ciHasExpanded() ? 'Collapse all steps' : 'Expand all steps', () => this._toggleCIExpandAll()),
        this._btn('refresh', `Reload from ${HT.provider.name}`, () => this.refresh()),
        h('a', { class: 'ht-btn', href: HT.safeUrl(job.html_url), title: `Open job on ${d.source.name}`, 'aria-label': `Open job on ${d.source.name}` }, HT.icon('external'))
      )
    );
    const searchOpen = d.searchOpen || Boolean(pane.search.value);
    if (searchOpen) head.querySelector('.ht-ci-card-actions .ht-btn').classList.add('active');

    const q = this._query().trim().toLowerCase();
    const list = h('ul', { class: 'ht-list ht-ci-list ht-ci-steps' });
    for (const step of steps) {
      const hits = q && byStep ? (byStep.get(step.number) || []).filter((l) => HT.stripAnsi(l).toLowerCase().includes(q)).length : 0;
      const open = d.open.has(step.number) || hits > 0;
      const t = this._jobTime(step);
      // Header and log share one item, so the header can stick while its
      // own log scrolls past and then hand over to the next step.
      const item = h('li', { class: 'ht-step', role: 'none' });
      list.append(item);
      item.append(
        h(
          'div',
          {
            class: 'ht-row',
            tabindex: '-1',
            role: 'button',
            style: '--depth:0',
            'aria-expanded': String(open),
            dataset: { key: `step:${step.number}` },
            title: step.name,
            onClick: () => {
              if (open) d.open.delete(step.number);
              else d.open.add(step.number);
              this._rerenderCI(state);
            },
          },
          h('span', { class: 'ht-chevron' }, HT.icon('chevron')),
          this._ciIcon(step.status, step.conclusion),
          h('span', { class: 'ht-name' }, step.name),
          hits ? h('span', { class: 'ht-ci-hits', title: `${hits} matching line${hits === 1 ? '' : 's'}` }, String(hits)) : null,
          t ? h('span', { class: 'ht-meta ht-ci-time' }, t) : null
        )
      );
      if (open) item.append(this._renderStepLog(job, step, d, byStep, q));
    }
    if (q && byStep && ![...byStep.values()].some((lines) => lines.some((l) => HT.stripAnsi(l).toLowerCase().includes(q)))) {
      list.prepend(h('li', { class: 'ht-empty' }, `No log lines match “${this._query().trim()}”`));
    }
    if (!steps.length) {
      const err = d.logs?.error;
      const waiting = d.source.liveLogs && !err;
      const text = err
        ? err.status === 404
          ? `${d.source.name} no longer has the log of this job.`
          : `Couldn't load the log: ${err.message}`
        : waiting && d.logs?.text == null
          ? 'Loading log…'
          : 'This job has no steps yet.';
      list.append(h('li', { class: 'ht-empty' }, text));
    }
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    // Moving the focused input would drop focus and the caret; restore both.
    const typing = this.shadow.activeElement === pane.search;
    const caret = [pane.search.selectionStart, pane.search.selectionEnd];
    const searchRow = searchOpen ? h('div', { class: 'ht-ci-search' }, h('span', { class: 'ht-search-icon' }, HT.icon('search')), pane.search) : null;
    const card = h('section', { class: 'ht-ci-card' }, h('div', { class: 'ht-ci-card-top' }, head, searchRow), list);
    this.body.append(h('div', { class: 'ht-ci-page' }, back, title), card);
    if (!searchOpen && pane.search.parentElement !== pane.bar) pane.bar.insertBefore(pane.search, pane.searchBtn);
    if (typing && searchOpen) {
      pane.search.focus({ preventScroll: true });
      pane.search.setSelectionRange(...caret);
    }
    // Open step headers stick below the card's header, like GitHub's.
    this.body.style.setProperty('--ht-detail-h', `${card.firstChild.offsetHeight}px`);
  }

  // GitHub's wording: "succeeded 4 minutes ago in 7s".
  _jobSentence(job) {
    const time = this._jobTime(job);
    if (job.status !== 'completed') {
      return job.started_at ? `started ${HT.timeAgo(job.started_at)}` : job.status.replace('_', ' ');
    }
    const verb = { success: 'succeeded', failure: 'failed', cancelled: 'was cancelled', skipped: 'was skipped', timed_out: 'timed out' }[job.conclusion] || job.conclusion;
    return [verb, job.completed_at ? HT.timeAgo(job.completed_at) : '', time ? `in ${time}` : ''].filter(Boolean).join(' ');
  }

  _renderStepLog(job, step, d, byStep, q = '') {
    const box = (...children) => h('div', { class: 'ht-log' }, ...children);
    const name = d.source.name;
    if (job.status !== 'completed' && !d.source.liveLogs) {
      return box(
        h('div', { class: 'ht-log-note' }, `${name}'s API only provides logs after a job finishes; they'll appear here then.`),
        h('a', { class: 'ht-link ht-log-live', href: HT.safeUrl(job.html_url) }, `Watch the live log on ${name} ↗`)
      );
    }
    if (!d.logs || d.logs.loading) return box(h('div', { class: 'ht-log-note' }, h('span', { class: 'ht-spinner' }), 'Loading logs…'));
    if (d.logs.error) {
      const err = d.logs.error;
      const signedOut = [401, 403].includes(err.status) && !err.hasToken;
      return box(
        h('div', { class: 'ht-log-note' }, signedOut ? `${name} only shows these logs to signed-in users.` : err.message),
        signedOut ? h('button', { class: 'ht-link', type: 'button', onClick: () => this._openOptions() }, 'Sign in') : null
      );
    }
    const lines = byStep.get(step.number) || [];
    if (!lines.length) return box(h('div', { class: 'ht-log-note' }, 'No output.'));
    if (!d.groups) d.groups = new Set();

    // Like GitHub: ##[group] … ##[endgroup] folds (closed by default),
    // endgroup lines aren't numbered, and annotations get a label.
    const root = h('div', { class: 'ht-log-lines' });
    let parent = root;
    let n = 0;
    for (const raw of lines) {
      const plain = HT.stripAnsi(raw);
      const cmd = plain.match(/^##\[(group|endgroup|error|warning|notice|debug)\](.*)$/);
      if (cmd?.[1] === 'endgroup') {
        parent = root;
        continue;
      }
      n++;
      const hit = q && plain.toLowerCase().includes(q);
      if (cmd?.[1] === 'group') {
        const key = `${step.number}:${n}`;
        const group = h('div', { class: 'ht-log-fold' });
        const body = h('div', { class: 'ht-log-fold-body' });
        const head = this._logLine(n, raw.replace(/^((?:\x1b\[[0-9;]*m)*)##\[group\]/, '$1'), 'ht-log-fold-head', q, true);
        head.addEventListener('click', () => {
          // Toggle in place: re-rendering would lose the reader's scroll.
          const open = group.classList.toggle('open');
          if (open) d.groups.add(key);
          else d.groups.delete(key);
        });
        if (d.groups.has(key)) group.classList.add('open');
        group.append(head, body);
        root.append(group);
        parent = body;
        if (hit) group.classList.add('open');
        continue;
      }
      let text = raw.replace(/^(\x1b\[[0-9;]*m)*##\[(error|warning|notice|debug)\]/, '$1');
      let cls = '';
      let label = null;
      if (cmd) {
        cls = `ht-log-${cmd[1]}`;
        if (cmd[1] !== 'debug') label = `${cmd[1][0].toUpperCase()}${cmd[1].slice(1)}: `;
      } else if (plain.startsWith('[command]')) {
        cls = 'ht-log-command';
        text = text.replace('[command]', '');
      }
      const line = this._logLine(n, text, cls, q, false, label);
      parent.append(line);
      // Reveal matches hidden inside a fold.
      if (hit && parent !== root) parent.parentElement.classList.add('open');
    }
    return box(root);
  }

  // One log line: number, optional annotation label, ANSI-colored text with
  // links and search highlights.
  _logLine(n, text, cls, q, fold = false, label = null) {
    const content = h('span', { class: 'ht-log-text' });
    if (fold) content.append(h('span', { class: 'ht-log-caret', 'aria-hidden': 'true' }));
    if (label) content.append(h('strong', { class: 'ht-log-label' }, label));
    for (const seg of HT.ansi(text)) {
      const span = h('span');
      const color = (v) => (typeof v === 'number' ? `var(--ansi-${v})` : v);
      if (seg.fg != null) span.style.color = color(seg.fg);
      if (seg.bg != null) span.style.background = color(seg.bg);
      if (seg.bold) span.style.fontWeight = '600';
      if (seg.dim) span.style.opacity = '0.7';
      if (seg.italic) span.style.fontStyle = 'italic';
      if (seg.underline) span.style.textDecoration = 'underline';
      this._linkify(span, seg.text, q);
      content.append(span.style.cssText ? span : span.childNodes.length === 1 ? span.firstChild : span);
    }
    return h('div', { class: `ht-log-line${cls ? ` ${cls}` : ''}` }, h('span', { class: 'ht-log-n' }, String(n)), content);
  }

  // Append text with http(s) links made clickable and search matches marked.
  _linkify(el, text, q) {
    const mark = (target, str) => {
      if (!q) return target.append(str);
      const lower = str.toLowerCase();
      let i = 0;
      for (let j; (j = lower.indexOf(q, i)) !== -1; i = j + q.length) {
        target.append(str.slice(i, j), h('mark', null, str.slice(j, j + q.length)));
      }
      target.append(str.slice(i));
    };
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      mark(el, text.slice(last, m.index));
      const a = h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' });
      mark(a, m[0]);
      el.append(a);
      last = m.index + m[0].length;
    }
    mark(el, text.slice(last));
  }

  _ciKey(e, list) {
    const rows = [...list.querySelectorAll('.ht-row')];
    const i = rows.indexOf(this.shadow.activeElement);
    if (i < 0) return;
    const row = rows[i];
    if (e.key === 'ArrowDown') rows[i + 1]?.focus();
    else if (e.key === 'ArrowUp') (i === 0 ? this._searchTarget(this._paneOfEl(list)) : rows[i - 1]).focus();
    else if (e.key === 'Enter' || e.key === ' ') row.click();
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && row.hasAttribute('aria-expanded')) {
      const open = row.getAttribute('aria-expanded') === 'true';
      if (open === (e.key === 'ArrowLeft')) row.click();
    } else if (e.key === 'Escape' && this.ci?.detail) {
      this._closeJob(this.ci);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // CI/CD for the repository being viewed: the site's own pipelines on or
  // off, and its external CI servers (TeamCity, Jenkins, any CI behind a
  // JSON endpoint), as many as it has. Each has its IDs, an optional token
  // and a connection test. A teamcity.toml or GitLab's TeamCity integration
  // can fill one in.
  _ciSettings(section) {
    const ctx = this.ctx;
    const repoKey = HT.url.repoKey(ctx);
    const box = section(`This repository · ${ctx.owner}/${ctx.repo}`);
    box.classList.add('ht-repo-section');
    (async () => {
      const conf = await HT.store.repoCI(repoKey);
      const sources = HT.ci.sources(conf);
      const integ = await this._teamcityHint(ctx).catch(() => null);
      const list = h('div', { class: 'ht-ci-sources' });
      const input = (attrs) => h('input', { class: 'ht-input', type: 'text', spellcheck: 'false', autocomplete: 'off', ...attrs });
      const persist = async (extra = {}) => {
        const clean = sources.map(HT.ci.cleanSource).filter(Boolean);
        await HT.store.setRepoCI(repoKey, { sources: clean.length ? clean : null, teamcity: null, ...extra });
      };
      const empty = h(
        'p',
        { class: 'ht-help' },
        'No external CI yet. Builds from TeamCity, Jenkins or any CI with a JSON endpoint show in the CI/CD tab next to the site\'s own.'
      );

      const card = (source) => {
        const el = h('div', { class: 'ht-ci-source' });
        const draw = () => {
          const rule = HT.ci.RULES[source.type];
          const adapter = HT.ci.types[source.type];
          const status = h('p', { class: 'ht-status-line', role: 'status' });
          const say = (text, kind = '') => {
            status.textContent = text;
            status.className = `ht-status-line ${kind}`;
          };
          const checks = h('ul', { class: 'ht-checks' });
          const kind = h(
            'select',
            {
              class: 'ht-input',
              onChange: (e) => {
                source.type = e.target.value;
                draw();
              },
            },
            Object.entries(HT.ci.types).map(([id, a]) => h('option', { value: id, selected: id === source.type }, a.name))
          );
          const server = input({ value: source.server || '', placeholder: rule.serverPlaceholder });
          const ids = input({ value: (source.type === 'custom' ? source.name : source.ids) || '', placeholder: rule.placeholder });
          const token = input({ type: 'password', placeholder: rule.tokenHint });
          const origin = () => HT.ci.originOf(server.value.trim().includes('://') ? server.value.trim() : `https://${server.value.trim()}`);

          const showAccess = async () => {
            const o = origin();
            if (!o || !source.saved) return;
            const { granted, hasToken } = await HT.api.send({ type: 'ci:access', server: o });
            token.placeholder = hasToken ? 'Saved (hidden). Paste a new one to replace it.' : rule.tokenHint;
            if (granted) say(hasToken ? 'Connected with an access token.' : 'Connected with your sign-in on that server (or anonymous access).', 'ok');
            else {
              say(`Hector isn't allowed to reach ${new URL(o).host} yet.`, 'err');
              status.append(' ', h('button', { class: 'ht-link', type: 'button', onClick: () => this._askAccess(o) }, 'Allow access'));
            }
          };
          const test = async () => {
            const clean = HT.ci.cleanSource(source);
            if (!clean) return;
            checks.replaceChildren(h('li', null, h('span', { class: 'ht-spinner' }), 'Checking…'));
            const target = this._ciTarget() || { ref: this.repo?.defaultBranch, label: this.repo?.defaultBranch };
            const results = await adapter.diagnose({ ...this._ciOpts(target, repoKey), source: clean }).catch((err) => [{ ok: false, text: err.message }]);
            checks.replaceChildren(...results.map((r) => h('li', { class: r.ok ? 'ok' : 'err' }, HT.icon(r.ok ? 'check' : 'close'), h('span', null, r.text))));
          };
          const save = async () => {
            const draft = { type: source.type, server: server.value.trim(), ...(source.type === 'custom' ? { name: ids.value.trim() } : { ids: ids.value.trim() }) };
            if (!draft.server) return say('Enter the server address.', 'err');
            const clean = HT.ci.cleanSource(draft);
            if (!clean) return say(draft.ids && !HT.ci.cleanIds(source.type, draft.ids) ? rule.idError : 'That address isn\'t a valid http(s) URL.', 'err');
            Object.assign(source, { ...clean, ids: clean.ids || '', name: clean.name || '', saved: true });
            await persist({ hintOff: null });
            const o = origin();
            if (token.value.trim()) {
              const res = await HT.api.send({ type: 'ci:token', server: o, token: token.value.trim() });
              if (!res?.ok) return say(res?.error || 'Could not save the token.', 'err');
              token.value = '';
            }
            const { granted } = await HT.api.send({ type: 'ci:access', server: o });
            if (!granted) this._askAccess(o);
            source.open = false;
            draw();
          };
          const remove = async () => {
            sources.splice(sources.indexOf(source), 1);
            // Removing a TeamCity server on purpose: don't suggest the repository's hint again.
            await persist({ hintOff: source.type === 'teamcity' && integ ? true : null });
            el.remove();
            empty.hidden = sources.length > 0;
          };
          el._test = test;
          // A saved server folds into one line: what it is, where, its
          // state, and Edit. Several servers then fit without scrolling.
          if (source.saved && !source.open) {
            let host = '';
            try {
              host = new URL(source.server).host;
            } catch {}
            const what = source.type === 'custom' ? '' : source.ids;
            el.classList.add('folded');
            el.replaceChildren(
              h(
                'div',
                { class: 'ht-ci-source-head' },
                h('span', { class: 'ht-ci-source-sum', title: `${source.server}${what ? `\n${what}` : ''}` }, h('strong', null, HT.ci.label(source)), h('span', null, [host, what].filter(Boolean).join(' · '))),
                h('button', { class: 'ht-link', type: 'button', onClick: () => ((source.open = true), draw()) }, 'Edit')
              ),
              status
            );
            showAccess();
            return;
          }
          el.classList.remove('folded');
          el.replaceChildren(
            h(
              'div',
              { class: 'ht-ci-source-head' },
              h('strong', null, source.saved ? HT.ci.label(source) : 'New CI server'),
              h(
                'span',
                { class: 'ht-inline' },
                h('button', { class: 'ht-link ht-danger', type: 'button', onClick: remove }, 'Remove'),
                source.saved ? h('button', { class: 'ht-link', type: 'button', onClick: () => ((source.open = false), draw()) }, 'Done') : null
              )
            ),
            h('label', { class: 'ht-field' }, h('span', null, 'Kind'), kind),
            h('label', { class: 'ht-field' }, h('span', null, source.type === 'custom' ? 'Address' : 'Server'), server),
            h('label', { class: 'ht-field' }, h('span', null, rule.label), ids),
            h('label', { class: 'ht-field' }, h('span', null, 'Access token'), token),
            h('p', { class: 'ht-help' }, rule.help),
            h(
              'div',
              { class: 'ht-inline' },
              h('button', { class: 'ht-primary', type: 'button', onClick: save }, 'Save'),
              source.saved ? h('button', { class: 'ht-secondary', type: 'button', onClick: test }, 'Test connection') : null,
              source.saved && adapter.tokenUrl && origin() ? h('a', { class: 'ht-link', href: adapter.tokenUrl(origin()), target: '_blank', rel: 'noopener' }, 'Create token ↗') : null
            ),
            status,
            checks
          );
          showAccess();
        };
        draw();
        return el;
      };

      for (const s of sources) {
        s.saved = true;
        list.append(card(s));
      }
      empty.hidden = sources.length > 0;
      const add = (preset) => {
        const s = { type: 'teamcity', server: '', ids: '', ...preset };
        sources.push(s);
        empty.hidden = true;
        const el = card(s);
        list.append(el);
        el.querySelector('input')?.focus();
      };
      HT.append(box, [
        h('h4', { class: 'ht-subhead' }, 'CI/CD'),
        h(
          'label',
          { class: 'ht-check' },
          h('input', { type: 'checkbox', checked: conf.native !== false, onChange: (e) => HT.store.setRepoCI(repoKey, { native: e.target.checked ? null : false }) }),
          h('span', null, `Show ${HT.provider.name} ${HT.provider.terms.noRuns}`)
        ),
        h('h4', { class: 'ht-subhead' }, 'External CI servers'),
        integ && !sources.some((s) => s.type === 'teamcity')
          ? h(
              'p',
              { class: 'ht-help' },
              `This repository points to TeamCity on ${integ.url}${integ.buildType ? ` (${integ.buildType})` : ''}. `,
              h('button', { class: 'ht-link', type: 'button', onClick: () => add({ type: 'teamcity', server: integ.url, ids: HT.teamcityIds(integ.buildType) }) }, 'Use these')
            )
          : null,
        empty,
        list,
        h('div', { class: 'ht-inline' }, h('button', { class: 'ht-secondary', type: 'button', onClick: () => add() }, 'Add CI server')),
      ]);
    })();
    return box;
  }

  // ---------- settings (rendered inside the sidebar) ----------

  // Version and updates. Firefox installs new versions by itself; this says
  // which one is running and lets the user check now.
  _aboutSection(section) {
    const firefox = chrome.runtime.getURL('').startsWith('moz-extension:');
    const status = h('p', { class: 'ht-status-line', role: 'status' });
    const show = (res) => {
      this._markUpdate(res);
      if (res?.available) {
        const label = HT.versionLabel(res.latest.version);
        status.className = 'ht-status-line ok';
        status.replaceChildren(
          `${label} is out. `,
          firefox
            ? 'Firefox installs it by itself within a day; to get it now: '
            : '',
          h('a', { class: 'ht-link', href: firefox && res.latest.link ? res.latest.link : res.releases, target: '_blank', rel: 'noopener' }, firefox && res.latest.link ? `Install ${label} ↗` : 'Download ↗')
        );
      } else if (res?.error) {
        status.className = 'ht-status-line err';
        status.textContent = `Couldn't check: ${res.error}`;
      } else if (res) {
        status.className = 'ht-status-line';
        status.textContent = `${HT.versionLabel()} is the latest.`;
      }
    };
    const check = async (force) => show(await HT.api.send({ type: 'update:check', force }).catch((err) => ({ error: err.message })));
    check(false);
    return section(
      'About & updates',
      h('p', { class: 'ht-help' }, `Hector ${HT.versionLabel()} · Every repository, one sidebar.`),
      h('div', { class: 'ht-inline' }, h('button', { class: 'ht-secondary', type: 'button', onClick: () => ((status.textContent = 'Checking…'), check(true)) }, 'Check for updates')),
      status
    );
  }

  // A dot on the gear while a newer version is out.
  _markUpdate(res) {
    this.settingsBtn?.classList.toggle('has-update', Boolean(res?.available));
    if (res?.available) this.settingsBtn.title = `Settings · ${HT.versionLabel(res.latest.version)} is out`;
  }

  // Custom tabs: the list, an editor, templates, and JSON import/export.
  _customTabsSection(section) {
    const CT = HT.customTabs;
    const box = h('div', { class: 'ht-custom-tabs' });
    const status = h('p', { class: 'ht-status-line', role: 'status' });
    const say = (text, kind = '') => {
      status.textContent = text;
      status.className = `ht-status-line ${kind}`;
    };
    const save = async (list) => {
      const clean = CT.cleanList(list);
      // One sync item holds them all (8 KB).
      if (JSON.stringify(clean).length > 7500) throw new Error('Too much for browser sync: shorten or remove some tabs.');
      await HT.store.set({ customTabs: clean });
      return clean;
    };
    // A feed on another server needs the browser's permission once.
    const askFeed = (def) => {
      const origin = def.type === 'feed' && def.feed.url.match(/^https?:\/\/[^/?#]+/)?.[0];
      if (origin) HT.api.send({ type: 'access:request', origin, why: `For the “${def.name}” tab.` }).catch(() => {});
    };

    const editor = (draft) => {
      const el = h('div', { class: 'ht-ci-source' });
      const input = (value, placeholder, onInput) => h('input', { class: 'ht-input', value: value || '', placeholder, spellcheck: 'false', onInput: (e) => onInput(e.target.value) });
      const draw = () => {
        const parts = [
          h('div', { class: 'ht-ci-source-head' }, h('strong', null, `${draft.id ? 'Edit' : 'New'} ${CT.TYPES[draft.type].toLowerCase()} tab`)),
          h('label', { class: 'ht-field' }, h('span', null, 'Name'), input(draft.name, 'Shown on the tab', (x) => (draft.name = x))),
          h(
            'label',
            { class: 'ht-field' },
            h('span', null, 'Icon'),
            h('select', { class: 'ht-input', onChange: (e) => (draft.icon = e.target.value) }, CT.ICONS.map((i) => h('option', { value: i, selected: draft.icon === i }, i)))
          ),
          h(
            'div',
            { class: 'ht-field' },
            h('span', null, 'Show on'),
            h(
              'div',
              { class: 'ht-inline' },
              Object.entries(CT.SITES).map(([id, label]) =>
                h(
                  'label',
                  { class: 'ht-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: !draft.sites || draft.sites.includes(id),
                    onChange: (e) => {
                      const all = draft.sites || Object.keys(CT.SITES);
                      draft.sites = e.target.checked ? [...new Set([...all, id])] : all.filter((s) => s !== id);
                      if (draft.sites.length === Object.keys(CT.SITES).length) delete draft.sites;
                    },
                  }),
                  h('span', null, label)
                )
              )
            )
          ),
        ];
        if (draft.type === 'links') {
          draft.links ||= [{ label: '', url: '' }];
          parts.push(
            h('div', { class: 'ht-field' }, h('span', null, 'Links'),
              draft.links.map((l, i) =>
                h('div', { class: 'ht-inline' },
                  input(l.label, 'Label', (x) => (l.label = x)),
                  input(l.url, 'https://…/{owner}/{repo}', (x) => (l.url = x)),
                  h('button', { class: 'ht-link', type: 'button', title: 'Remove', onClick: () => (draft.links.splice(i, 1), draw()) }, '✕')
                )
              ),
              h('div', null, h('button', { class: 'ht-secondary', type: 'button', onClick: () => (draft.links.push({ label: '', url: '' }), draw()) }, 'Add link'))
            )
          );
        } else if (draft.type === 'file') {
          parts.push(h('label', { class: 'ht-field' }, h('span', null, 'File in the repository'), input(draft.path, 'CHANGELOG.md, docs/notes.md', (x) => (draft.path = x))));
        } else {
          const f = (draft.feed ||= { url: '', items: '', title: '{item.title}', subtitle: '', link: '{item.html_url}', date: '' });
          parts.push(
            h('label', { class: 'ht-field' }, h('span', null, 'Address (JSON)'), input(f.url, 'https://api.example.com/{owner}/{repo}/items', (x) => (f.url = x))),
            h('label', { class: 'ht-field' }, h('span', null, 'Items are at (empty: the answer is the list)'), input(f.items, 'data.items', (x) => (f.items = x))),
            h('label', { class: 'ht-field' }, h('span', null, 'Title'), input(f.title, '{item.title}', (x) => (f.title = x))),
            h('label', { class: 'ht-field' }, h('span', null, 'Second line'), input(f.subtitle, '#{item.number} by {item.user.login}', (x) => (f.subtitle = x))),
            h('label', { class: 'ht-field' }, h('span', null, 'Link'), input(f.link, '{item.html_url}', (x) => (f.link = x))),
            h('label', { class: 'ht-field' }, h('span', null, 'Date field'), input(f.date, 'created_at', (x) => (f.date = x)))
          );
        }
        parts.push(
          h('p', { class: 'ht-help' }, 'Placeholders: {owner} {repo} {ref} {sha} {path} {pull} {host} {origin} {repoUrl}.'),
          h(
            'div',
            { class: 'ht-inline' },
            h(
              'button',
              {
                class: 'ht-primary',
                type: 'button',
                onClick: async () => {
                  const def = CT.clean(draft);
                  if (!def) return say(draft.type === 'feed' ? 'The address must start with https://host/ (no placeholders in the host).' : draft.type === 'file' ? 'Enter a file path in the repository.' : 'Add at least one link with a label and an http(s) address.', 'err');
                  try {
                    const list = CT.list();
                    const i = list.findIndex((t) => t.id === def.id);
                    if (i >= 0) list[i] = def;
                    else list.push(def);
                    if (list.length > CT.MAX_TABS) return say(`Up to ${CT.MAX_TABS} custom tabs.`, 'err');
                    await save(list);
                    askFeed(def);
                    this._ctDraft = null;
                    say(`Saved “${def.name}”. It's in the tab row.`, 'ok');
                    render();
                  } catch (err) {
                    say(err.message, 'err');
                  }
                },
              },
              'Save'
            ),
            h('button', { class: 'ht-secondary', type: 'button', onClick: () => ((this._ctDraft = null), render()) }, 'Cancel')
          )
        );
        el.replaceChildren(...parts);
      };
      draw();
      return el;
    };

    const importBox = () => {
      const area = h('textarea', { class: 'ht-input ht-import', rows: 5, placeholder: 'Paste a custom tab (or a list of them) as JSON', spellcheck: 'false' });
      return h(
        'div',
        { class: 'ht-ci-source' },
        area,
        h(
          'div',
          { class: 'ht-inline' },
          h(
            'button',
            {
              class: 'ht-primary',
              type: 'button',
              onClick: async () => {
                let parsed;
                try {
                  parsed = JSON.parse(area.value);
                } catch {
                  return say("That isn't JSON.", 'err');
                }
                // Imported tabs get new ids, so they never replace yours.
                const incoming = CT.cleanList([].concat(parsed).map((d) => ({ ...d, id: undefined })));
                if (!incoming.length) return say('Nothing in it is a valid custom tab.', 'err');
                try {
                  await save([...CT.list(), ...incoming]);
                  incoming.forEach(askFeed);
                  this._ctImport = false;
                  say(`Added ${incoming.map((d) => `“${d.name}”`).join(', ')}.`, 'ok');
                  render();
                } catch (err) {
                  say(err.message, 'err');
                }
              },
            },
            'Add'
          ),
          h('button', { class: 'ht-secondary', type: 'button', onClick: () => ((this._ctImport = false), render()) }, 'Cancel')
        )
      );
    };

    const render = () => {
      const tabs = CT.list();
      const items = tabs.map((t) =>
        h(
          'div',
          { class: 'ht-ct-row' },
          HT.icon(t.icon),
          h('span', { class: 'ht-ct-name' }, t.name, h('span', { class: 'ht-dir' }, `${CT.TYPES[t.type]}${t.sites ? ` · ${t.sites.map((s) => CT.SITES[s]).join(', ')}` : ''}`)),
          h('button', { class: 'ht-link', type: 'button', onClick: () => ((this._ctDraft = structuredClone(t)), render()) }, 'Edit'),
          h(
            'button',
            {
              class: 'ht-link',
              type: 'button',
              title: 'Copy as JSON, to share',
              onClick: async () => {
                const { id, ...share } = t;
                say((await HT.copyText(JSON.stringify(share, null, 2))) ? `Copied “${t.name}” as JSON.` : 'Copy failed.', 'ok');
              },
            },
            'Copy'
          ),
          h(
            'button',
            {
              class: 'ht-link ht-danger',
              type: 'button',
              onClick: async () => {
                if (!confirm(`Delete the “${t.name}” tab?`)) return;
                await save(tabs.filter((x) => x.id !== t.id));
                say(`Deleted “${t.name}”.`);
                render();
              },
            },
            'Delete'
          )
        )
      );
      const presets = CT.PRESETS.map((p, i) => [i, `${p.name}${p.sites ? ` (${p.sites.map((s) => CT.SITES[s]).join(', ')})` : ''}`]);
      const add = h(
        'select',
        {
          class: 'ht-input',
          onChange: (e) => {
            const v = e.target.value;
            e.target.value = '';
            if (v === 'import') this._ctImport = true;
            else if (v.startsWith('new:')) this._ctDraft = { type: v.slice(4), icon: 'bookmark', name: '' };
            else if (v.startsWith('preset:')) this._ctDraft = structuredClone(CT.PRESETS[Number(v.slice(7))]);
            render();
          },
        },
        h('option', { value: '' }, 'Add a tab…'),
        h('optgroup', { label: 'New' }, Object.entries(CT.TYPES).map(([id, label]) => h('option', { value: `new:${id}` }, label))),
        h('optgroup', { label: 'From a template' }, presets.map(([i, label]) => h('option', { value: `preset:${i}` }, label))),
        h('option', { value: 'import' }, 'Import from JSON…')
      );
      box.replaceChildren(
        ...(items.length ? items : [h('p', { class: 'ht-help' }, 'No custom tabs yet.')]),
        this._ctDraft ? editor(this._ctDraft) : this._ctImport ? importBox() : h('div', { class: 'ht-inline' }, add),
        status
      );
    };
    render();
    const el = section(
      'Custom tabs',
      h('p', { class: 'ht-help' }, 'Your own tabs: links made from the page you are on, a file from the repository, or a list from any JSON address. Show, hide and reorder them from + like the others.'),
      box
    );
    if (this._openCustomTabs) {
      this._openCustomTabs = false;
      setTimeout(() => el.scrollIntoView({ block: 'start' }), 0);
    }
    return el;
  }

  // "Report a problem": the debug report, previewed before it goes anywhere.
  _reportSection(section) {
    const status = h('p', { class: 'ht-status-line', role: 'status' });
    const hide = h('input', { type: 'checkbox', checked: true });
    const preview = h('pre', { class: 'ht-report' });
    const details = h('details', { class: 'ht-report-box' }, h('summary', null, 'Show what\'s in it'), preview);
    const make = () => HT.debug.build(this, { redact: hide.checked });
    const show = async () => {
      if (details.open) preview.textContent = await make();
    };
    details.addEventListener('toggle', show);
    hide.addEventListener('change', show);
    const done = (text) => {
      status.textContent = text;
      status.className = 'ht-status-line ok';
    };
    return section(
      'Report a problem',
      h(
        'p',
        { class: 'ht-help' },
        'A report of what Hector sees on this page: versions, how the site was recognized, the sidebar\'s state, recent requests and errors. It never holds tokens, cookies or file contents. Read it, then paste it into your report.'
      ),
      h('label', { class: 'ht-check' }, hide, h('span', null, 'Hide repository, branch, user and server names')),
      h(
        'div',
        { class: 'ht-inline' },
        h(
          'button',
          {
            class: 'ht-primary',
            type: 'button',
            onClick: async () => {
              const text = await make();
              try {
                await navigator.clipboard.writeText(text);
                done('Copied. Paste it where you report the problem.');
              } catch {
                details.open = true;
                preview.textContent = text;
                done('Copying was blocked: select the text below and copy it.');
              }
            },
          },
          'Copy report'
        ),
        h(
          'button',
          {
            class: 'ht-secondary',
            type: 'button',
            onClick: async () => {
              const a = h('a', { href: URL.createObjectURL(new Blob([await make()], { type: 'text/markdown' })), download: `hector-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.md` });
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              done('Saved.');
            },
          },
          'Save as file'
        )
      ),
      status,
      details
    );
  }

  _renderSettings() {
    const s = this.s;
    // A section that fails to draw is left out, not the whole panel.
    const part = (draw) => {
      try {
        return draw();
      } catch (err) {
        HT.debug?.note('settings', err);
        return null;
      }
    };
    const host = location.host;
    const save = (patch) => HT.store.set(patch);

    const select = (key, options) =>
      h(
        'select',
        { class: 'ht-input', onChange: (e) => save({ [key]: e.target.value }) },
        options.map(([value, label]) => h('option', { value, selected: s[key] === value }, label))
      );
    const toggle = (key, label) =>
      h(
        'label',
        { class: 'ht-check' },
        h('input', { type: 'checkbox', checked: Boolean(s[key]), onChange: (e) => save({ [key]: e.target.checked }) }),
        h('span', null, label)
      );
    const field = (label, control) => h('label', { class: 'ht-field' }, h('span', null, label), control);
    const section = (title, ...children) => h('section', { class: 'ht-section' }, h('h3', null, title), children);

    // Token
    const tokenInput = h('input', {
      class: 'ht-input',
      type: 'password',
      placeholder: 'github_pat_… or ghp_…',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const tokenStatus = h('p', { class: 'ht-status-line', role: 'status' });
    const setStatus = (text, kind = '') => {
      tokenStatus.textContent = text;
      tokenStatus.className = `ht-status-line ${kind}`;
    };
    const name = HT.provider.name;
    const gitlab = HT.provider.id === 'gitlab';
    const bitbucket = HT.provider.id === 'bitbucket';
    // The token is write-only here: the input never shows the saved one.
    const showTokenStatus = () =>
      HT.api.send({ type: 'token:status', host }).then(({ hasToken }) => {
        tokenInput.placeholder = hasToken ? 'Saved (hidden). Paste a new one to replace it.' : HT.provider.tokenHint;
        const none = gitlab || HT.provider.id === 'bitbucket-server'
          ? `No token. Uses your ${name} sign-in in this browser, if any.`
          : bitbucket
            ? 'No token. Public repositories only.'
            : 'No token. Public repositories only, 60 requests/hour.';
        setStatus(hasToken ? 'A token is saved for this site.' : none);
      });
    showTokenStatus();
    const storeToken = async (value) => {
      const res = await HT.api.send({ type: 'token:set', host, token: value });
      if (!res?.ok) throw new Error(res?.error || 'Could not save the token.');
      tokenInput.value = '';
      renderAccount();
      showTokenStatus();
      if (value) this._lookupAccount();
    };
    const testToken = async () => {
      setStatus('Testing…');
      try {
        const user = await HT.provider.user();
        setStatus(`Works: signed in as ${user.login}.`, 'ok');
      } catch (err) {
        setStatus(err.status === 401 ? `${name} rejected this token.` : err.message, 'err');
      }
    };
    const showBtn = h('button', { class: 'ht-secondary', type: 'button' }, 'Show');
    showBtn.addEventListener('click', () => {
      tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
      showBtn.textContent = tokenInput.type === 'password' ? 'Show' : 'Hide';
    });

    // GitHub sign-in (device flow, driven from here so the worker stays awake)
    const accountBox = h('div', { class: 'ht-account' });
    const tokenDetails = h('details', { class: 'ht-details' });
    const send = (msg) => HT.api.send(msg);
    let signInRun = 0;

    const renderAccount = async () => {
      signInRun++;
      const { accounts = {} } = await chrome.storage.local.get('accounts');
      // If the background can't be reached, still offer sign-in; starting it
      // reports the problem.
      const config = await send({ type: 'auth:config' }).catch(() => null);
      const session = this.account?.method === 'session' ? this.account : null;
      const account = accounts[host] || session;
      const canSignIn = host === 'github.com' && config?.enabled !== false;
      tokenDetails.open = !canSignIn && !account;
      if (session && account === session) {
        accountBox.replaceChildren(
          h(
            'div',
            { class: 'ht-signed-in' },
            account.avatar ? h('img', { class: 'ht-avatar', src: HT.avatarUrl(account.avatar, 64), alt: '' }) : null,
            h('span', null, 'Signed in as ', h('strong', null, `@${account.login}`))
          ),
          h('p', { class: 'ht-help' }, `Using your ${name} sign-in in this browser. Add a token below to keep access while signed out.`)
        );
      } else if (account) {
        accountBox.replaceChildren(
          h(
            'div',
            { class: 'ht-signed-in' },
            account.avatar ? h('img', { class: 'ht-avatar', src: HT.avatarUrl(account.avatar, 64), alt: '' }) : null,
            h('span', null, 'Signed in as ', h('strong', null, `@${account.login}`)),
            h(
              'button',
              {
                class: 'ht-secondary',
                type: 'button',
                onClick: async () => {
                  await send({ type: 'auth:signout', host });
                  tokenInput.value = '';
                  renderAccount();
                },
              },
              'Sign out'
            )
          ),
          h('p', { class: 'ht-help' }, account.method === 'oauth' ? 'Authentication: GitHub sign-in' : 'Authentication: personal access token'),
          account.method === 'oauth'
            ? h(
                'p',
                { class: 'ht-help' },
                'To fully revoke access, remove Hector under ',
                h('a', { class: 'ht-link', href: 'https://github.com/settings/applications', target: '_blank', rel: 'noopener' }, 'Authorized OAuth Apps ↗'),
                '.'
              )
            : null
        );
      } else if (canSignIn) {
        accountBox.replaceChildren(
          h('p', { class: 'ht-help' }, 'Sign in once to browse private repositories and get 5,000 requests/hour.'),
          h('button', { class: 'ht-primary ht-github-btn', type: 'button', onClick: startSignIn }, HT.icon('logo'), 'Sign in with GitHub')
        );
      } else {
        accountBox.replaceChildren(
          h(
            'p',
            { class: 'ht-help' },
            gitlab
              ? 'Sign in to GitLab in this browser, or use a personal access token with the read_api scope.'
              : bitbucket
                ? 'Use an Atlassian API token as email:token, or an app password as user:password, with repository read access.'
                : host === 'github.com'
                ? 'Sign-in is not set up in this build. Use a personal access token below.'
                : 'Use a personal access token for this GitHub Enterprise server.'
          )
        );
      }
    };

    const startSignIn = async () => {
      const run = ++signInRun;
      const status = h('p', { class: 'ht-status-line', role: 'status' }, 'Contacting GitHub…');
      accountBox.replaceChildren(status);
      const start = await send({ type: 'auth:start' }).catch((err) => ({ error: err.message }));
      if (run !== signInRun) return;
      if (start?.error) {
        accountBox.replaceChildren(
          h('p', { class: 'ht-status-line err' }, `Sign-in failed: ${start.error}`),
          h(
            'div',
            { class: 'ht-inline' },
            // One click: the browser's own prompt for Hector's sites.
            start.needsAccess
              ? h(
                  'button',
                  {
                    class: 'ht-primary',
                    type: 'button',
                    onClick: () => {
                      // Once allowed, sign-in carries on by itself.
                      const resume = (changes, area) => {
                        if (area !== 'local' || !changes.grantedAt) return;
                        chrome.storage.onChanged.removeListener(resume);
                        if (run === signInRun && accountBox.isConnected) startSignIn();
                      };
                      chrome.storage.onChanged.addListener(resume);
                      HT.api.send({ type: 'access:sites' }).catch(() => {});
                    },
                  },
                  'Allow access'
                )
              : null,
            h('button', { class: 'ht-secondary', type: 'button', onClick: renderAccount }, 'Back')
          )
        );
        return;
      }
      const openGitHub = async () => {
        await HT.copyText(start.user_code);
        window.open('https://github.com/login/device', '_blank', 'noopener');
        status.textContent = 'Code copied. Paste it on GitHub and approve. Waiting…';
      };
      status.textContent = 'Enter this code on GitHub:';
      accountBox.replaceChildren(
        status,
        h('div', { class: 'ht-code', title: 'Click to copy', onClick: () => HT.copyText(start.user_code).then(() => this._toast('Code copied')) }, start.user_code),
        h(
          'div',
          { class: 'ht-inline' },
          h('button', { class: 'ht-primary', type: 'button', onClick: openGitHub }, 'Copy code & open GitHub'),
          h('button', { class: 'ht-link', type: 'button', onClick: renderAccount }, 'Cancel')
        )
      );

      let interval = (start.interval || 5) * 1000;
      const deadline = Date.now() + (start.expires_in || 900) * 1000;
      while (run === signInRun && accountBox.isConnected && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        if (run !== signInRun || !accountBox.isConnected) return;
        const res = await send({ type: 'auth:poll', deviceCode: start.device_code }).catch((err) => ({ status: 'error', error: err.message }));
        if (run !== signInRun) return;
        if (res.status === 'pending') continue;
        if (res.status === 'slow_down') {
          interval = (res.interval || interval / 1000 + 5) * 1000;
          continue;
        }
        if (res.status === 'ok') {
          this._toast(`Signed in as @${res.login}`);
          renderAccount();
          return;
        }
        accountBox.replaceChildren(
          h('p', { class: 'ht-status-line err' }, `Sign-in failed: ${res.error}`),
          h('button', { class: 'ht-secondary', type: 'button', onClick: renderAccount }, 'Try again')
        );
        return;
      }
      if (run === signInRun && accountBox.isConnected) {
        accountBox.replaceChildren(
          h('p', { class: 'ht-status-line err' }, 'The code expired.'),
          h('button', { class: 'ht-secondary', type: 'button', onClick: renderAccount }, 'Try again')
        );
      }
    };
    renderAccount();

    // Bookmarks
    const bmStatus = h('p', { class: 'ht-status-line', role: 'status' });
    const importInput = h('input', { type: 'file', accept: 'application/json', hidden: true });
    importInput.addEventListener('change', async () => {
      const file = importInput.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const incoming = Array.isArray(parsed) ? parsed : parsed.bookmarks;
        if (!Array.isArray(incoming)) throw new Error('no bookmarks in file');
        const list = await HT.store.bookmarks();
        const known = new Set(list.map((b) => b.url));
        const added = HT.cleanBookmarks(incoming).filter((b) => !known.has(b.url));
        await HT.store.saveBookmarks([...list, ...added]);
        bmStatus.textContent = `Imported ${added.length} bookmark${added.length === 1 ? '' : 's'}.`;
      } catch (err) {
        bmStatus.textContent = `Import failed: ${err.message}`;
      }
      importInput.value = '';
    });
    const exportBookmarks = () => {
      const blob = new Blob([JSON.stringify({ app: 'hector', version: 1, bookmarks: this.bookmarks }, null, 2)], {
        type: 'application/json',
      });
      const a = h('a', { href: URL.createObjectURL(blob), download: `hector-bookmarks-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    const panel = h(
      'div',
      { class: 'ht-settings' },
      h(
        'div',
        { class: 'ht-settings-head' },
        h('strong', null, 'Settings'),
        h('button', { class: 'ht-link', type: 'button', onClick: () => this.toggleSettings(false) }, 'Done')
      ),
      this.ctx ? part(() => this._ciSettings(section)) : null,
      part(() => this._customTabsSection(section)),
      section(
        `${name} account${['github.com', 'gitlab.com', 'bitbucket.org'].includes(host) ? '' : ` · ${host}`}`,
        accountBox,
        HT.append(tokenDetails, [
          h('summary', null, 'Use a personal access token instead'),
          h('p', { class: 'ht-help' }, `Stored only in this browser and sent only to the ${name} API.`),
          h('div', { class: 'ht-inline' }, tokenInput, showBtn),
          h(
            'div',
            { class: 'ht-inline' },
            h(
              'button',
              {
                class: 'ht-primary',
                type: 'button',
                onClick: async () => {
                  const value = tokenInput.value.trim();
                  if (!value) return setStatus('Paste a token first.', 'err');
                  await storeToken(value).then(testToken, (err) => setStatus(err.message, 'err'));
                },
              },
              'Save'
            ),
            h('button', { class: 'ht-secondary', type: 'button', onClick: testToken }, 'Test'),
            h(
              'button',
              {
                class: 'ht-secondary ht-danger',
                type: 'button',
                onClick: async () => {
                  await storeToken('').then(() => setStatus('Token removed.'), (err) => setStatus(err.message, 'err'));
                },
              },
              'Remove'
            ),
            h('a', { class: 'ht-link', href: HT.provider.tokenUrl(location.origin), target: '_blank', rel: 'noopener' }, 'Create ↗')
          ),
          tokenStatus,
        ])
      ),
      section(
        'Behavior',
        field('Pull requests open on', select('prDefaultTab', [['changes', 'Changed files'], ['files', 'Full file tree']])),
        toggle('docked', 'Dock sidebar (push the page over)'),
        toggle('compactFolders', 'Compact single-child folders'),
        toggle('previewFiles', 'Open clicked files, diffs, merge requests and work items in the sidebar (⌘/Ctrl-click opens the page)'),
        h(
          'label',
          { class: 'ht-check' },
          h('input', { type: 'checkbox', checked: !s.hideNotices, onChange: (e) => save({ hideNotices: !e.target.checked }) }),
          h('span', null, 'Show large-repository notices')
        ),
        h('p', { class: 'ht-help' }, 'Shortcut: Alt+Shift+T toggles the sidebar.')
      ),
      section(
        `Bookmarks · ${this.bookmarks.length}`,
        h(
          'div',
          { class: 'ht-inline' },
          h('button', { class: 'ht-secondary', type: 'button', onClick: exportBookmarks }, 'Export'),
          h('button', { class: 'ht-secondary', type: 'button', onClick: () => importInput.click() }, 'Import'),
          h(
            'button',
            {
              class: 'ht-secondary ht-danger',
              type: 'button',
              onClick: async () => {
                if (!confirm('Delete all Hector bookmarks?')) return;
                await HT.store.saveBookmarks([]);
                bmStatus.textContent = 'All bookmarks deleted.';
              },
            },
            'Delete all'
          ),
          importInput
        ),
        bmStatus
      ),
      section(
        'Backup & reset',
        h('p', { class: 'ht-help' }, 'Save Hector\'s whole setup to a file and load it after reinstalling, or reset everything.'),
        h(
          'button',
          {
            class: 'ht-secondary',
            type: 'button',
            onClick: () => chrome.runtime.sendMessage({ type: 'openOptions', section: 'backup' }).catch(() => this._toast('Refresh the page and try again.')),
          },
          'Backup, restore & reset ↗'
        )
      ),
      part(() => this._reportSection(section)),
      section(
        'Self-hosted servers',
        h('p', { class: 'ht-help' }, 'GitHub Enterprise, GitLab (CE/EE) or Bitbucket Server on your own domain. Open a repository there and click Hector\'s toolbar button to add it, or manage the list on the options page.'),
        h(
          'button',
          {
            class: 'ht-secondary',
            type: 'button',
            onClick: () => chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => this._toast('Refresh the page and try again.')),
          },
          'Manage domains ↗'
        )
      ),
      part(() => this._aboutSection(section))
    );
    this.body.append(panel);
  }
};

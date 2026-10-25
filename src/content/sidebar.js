// The sidebar: UI shell, data loading for code/PR trees, and bookmarks.
const { h } = HT;

const THEME_TOKENS = [
  '--bg', '--bg-2', '--bg-hover', '--bg-sel', '--bg-input', '--fg', '--fg-2', '--fg-3', '--border',
  '--accent', '--accent-2', '--primary', '--primary-fg', '--add', '--del', '--mod', '--ren', '--mark',
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
      compact: () => this.s.compactFolders,
      colored: () => this.s.fileIcons,
      iconPack: () => this.s.iconPack,
      onError: (err) => this._toast(err.message),
      onTop: () => this._searchNear(this.filesTree.el).focus(),
      onEscape: () => this._escape(),
      onExpandChange: () => this._updateExpandBtn(),
    });

    this.changesTree = new HT.Tree({
      linkFor: (n) => (n.type === 'tree' ? null : this._diffLink(n)),
      actionsFor: (n) => (n.type === 'tree' ? [] : [{ act: 'copy', icon: 'copy', title: 'Copy path' }]),
      onAction: (act, n, el) => this._onRowAction(act, n, el),
      renderMeta: (n) => this._diffMeta(n),
      onOpen: (n) => this._openDiff(n),
      compact: () => this.s.compactFolders,
      colored: () => this.s.fileIcons,
      iconPack: () => this.s.iconPack,
      onTop: () => this._searchNear(this.changesTree.el).focus(),
      onEscape: () => this._escape(),
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
    this.shadow.append(h('style', null, HT.CSS));

    this.toggleBtn = h(
      'button',
      {
        class: 'ht-toggle',
        type: 'button',
        title: 'Open Hector (Alt+Shift+T)',
        'aria-label': 'Open Hector',
        onClick: () => this.setDocked(true),
      },
      HT.icon('logo')
    );

    // Ref, file count and API budget live in a footer status bar, so the tab
    // row can take the full height of GitHub's repository nav and line up
    // with its icons.
    this.statsEl = h('div', { class: 'ht-stats' });
    this.starBtn = this._btn('bookmark', 'Bookmark this page', () => this._bookmarkCurrent());
    this.pinBtn = this._btn('pin', 'Dock sidebar', () => this.setDocked(!this.s.docked));
    const footer = h(
      'footer',
      { class: 'ht-footer' },
      this.statsEl,
      h(
        'div',
        { class: 'ht-footer-actions' },
        this.starBtn,
        this.pinBtn,
        (this.settingsBtn = this._btn('settings', 'Settings', () => this.toggleSettings())),
        this._btn('close', 'Hide sidebar', () => this._close())
      )
    );

    this.tabsEl = h('nav', { class: 'ht-tabs', role: 'tablist' });
    const applyFilter = HT.debounce(() => this._applyFilter(), 80);
    this.search = h('input', {
      class: 'ht-search-input',
      type: 'text',
      placeholder: 'Go to file…',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Filter files',
      onInput: applyFilter,
      onKeydown: (e) => this._onSearchKey(e),
    });
    this.searchBar = h(
      'div',
      { class: 'ht-search' },
      h('span', { class: 'ht-search-icon', dataset: { icon: 'search' } }, HT.icon('search')),
      this.search,
      (this.expandBtn = this._btn('expandAll', 'Expand all folders', () => this._toggleExpandAll())),
      this._btn('refresh', `Reload from ${HT.provider.name}`, () => this.refresh())
    );

    this.body = h('div', { class: 'ht-body' });
    // Each pane has its own search, above its own content.
    this.mainPane = h('div', { class: 'ht-main' }, this.searchBar, this.body);
    this.splitSearch = h('input', {
      class: 'ht-search-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Filter',
      onInput: HT.debounce(() => this._applySplitFilter(), 80),
      onKeydown: (e) => this._onSplitSearchKey(e),
    });
    this.splitSearchBar = h(
      'div',
      { class: 'ht-search ht-split-search' },
      h('span', { class: 'ht-search-icon', dataset: { icon: 'search' } }, HT.icon('search')),
      this.splitSearch
    );
    // Split view: a second tab beside the first (hold a tab to open it).
    this.splitBody = h('div', { class: 'ht-body ht-split-body' });
    this.splitTitle = h('span', { class: 'ht-split-title' });
    this.splitPane = h(
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
      this.splitSearchBar,
      this.splitBody
    );
    for (const body of [this.body, this.splitBody]) {
      body.addEventListener(
        'scroll',
        () => {
          body.classList.add('scrolling');
          clearTimeout(body._scrollbarTimer);
          body._scrollbarTimer = setTimeout(() => body.classList.remove('scrolling'), 900);
        },
        { passive: true }
      );
    }
    this.toastEl = h('div', { class: 'ht-toast', role: 'status' });

    this.topBar = h('div', { class: 'ht-top' }, this.tabsEl);
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
        this.mainPane,
        (this.splitGap = h('div', { class: 'ht-split-gap', hidden: true, title: 'Drag to resize', onMousedown: (e) => this._startSplitResize(e) })),
        this.splitPane
      )),
      footer,
      this.toastEl,
      h('div', { class: 'ht-resizer', onMousedown: (e) => this._startResize(e) })
    );

    this.root = h('div', { class: 'ht-root', hidden: true, dataset: { site: HT.provider.id } }, this.toggleBtn, this.panel);
    this.shadow.append(this.root);
    document.documentElement.append(this.host);
  }

  ensureAttached() {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  // ---------- layout / theme ----------

  _applyLayout() {
    const { dock, width, docked, fontSize } = this.s;
    const on = this.visible;
    this.root.hidden = !on;
    this.root.dataset.dock = dock;
    this.root.classList.toggle('tab-labels', this.s.showTabLabels);
    this.root.classList.toggle('docked', on && docked);
    this.root.classList.toggle('peek', on && !docked && this.peeking);
    this.root.style.setProperty('--ht-width', `${width}px`);
    this.root.style.setProperty('--ht-font', `${fontSize}px`);
    this.root.style.setProperty('--ht-split', `${this.s.splitSize}%`);
    this.stack.dataset.split = this.s.splitPos;

    const html = document.documentElement;
    html.style.setProperty('--hector-width', `${width}px`);
    html.classList.toggle('hector-docked-left', on && docked && dock === 'left');
    html.classList.toggle('hector-docked-right', on && docked && dock === 'right');

    this.pinBtn.replaceChildren(HT.icon(docked ? 'unpin' : 'pin'));
    this.pinBtn.title = docked ? 'Undock (show on hover)' : 'Dock sidebar';
    this._syncSharedHeaders();
    this._syncTop();
    this._shiftFixedBars();
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
    const edge = Math.max(0, boundary);
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

  _watchHeaderLayout() {
    let queued = false;
    const run = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this._syncSharedHeaders();
        this._syncTop();
        this._shiftFixedBars();
      });
    };
    window.addEventListener('scroll', run, { passive: true });
    window.addEventListener('resize', run);
    // Sticky bars often appear a moment after scrolling stops.
    window.addEventListener('scrollend', run, { passive: true });
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
    const bg = this._rgb(bodyBg)?.[3] > 0 ? bodyBg : read('--bgColor-default', '--color-canvas-default', '--gl-background-color-default');
    const fg = getComputedStyle(document.body).color || read('--fgColor-default', '--color-fg-default', '--gl-text-color-default');
    const rgb = this._rgb(bg);
    if (!rgb) {
      this.root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      return;
    }
    const dark = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128;
    this.root.dataset.theme = dark ? 'dark' : 'light';

    const tokens = {
      '--bg': bg,
      '--fg': fg,
      '--bg-2': read('--bgColor-muted', '--color-canvas-subtle', '--gl-background-color-subtle'),
      '--bg-overlay': read('--overlay-bgColor', '--color-canvas-overlay', '--gl-background-color-overlap'),
      '--shadow-overlay': read('--shadow-floating-small', '--color-overlay-shadow'),
      '--border-muted': read('--borderColor-muted', '--color-border-muted', '--gl-border-color-subtle'),
      '--shadow-card': read('--shadow-resting-small'),
      '--bg-input': read('--bgColor-inset', '--color-canvas-inset', '--gl-background-color-subtle') || bg,
      '--bg-hover': read('--control-transparent-bgColor-hover', '--color-action-list-item-default-hover-bg', '--gl-action-neutral-background-color-hover'),
      '--bg-sel': read('--control-transparent-bgColor-selected', '--color-action-list-item-default-selected-bg', '--gl-action-neutral-background-color-active'),
      '--fg-2': read('--fgColor-muted', '--color-fg-muted', '--gl-text-color-subtle'),
      '--border': read('--borderColor-default', '--color-border-default', '--gl-border-color-default'),
      '--accent': read('--fgColor-accent', '--color-accent-fg', '--gl-text-color-link'),
      '--accent-2': read('--fgColor-accent', '--color-accent-fg', '--gl-text-color-link'),
      '--primary': read('--button-primary-bgColor-rest', '--bgColor-success-emphasis', '--color-btn-primary-bg', '--gl-button-confirm-primary-background-color-default'),
      '--primary-fg': read('--button-primary-fgColor-rest', '--fgColor-onEmphasis', '--color-btn-primary-text', '--gl-button-confirm-primary-foreground-color-default'),
      '--add': read('--fgColor-success', '--color-success-fg', '--gl-text-color-success'),
      '--del': read('--fgColor-danger', '--color-danger-fg', '--gl-text-color-danger'),
      '--mod': read('--fgColor-attention', '--color-attention-fg', '--gl-text-color-warning'),
      '--ren': read('--fgColor-accent', '--color-accent-fg', '--gl-text-color-link'),
      '--mark': read('--bgColor-attention-muted', '--color-attention-subtle', '--gl-highlight-target-background-color'),
      '--tab-active': read('--underlineNav-borderColor-active', '--color-primer-border-active', '--gl-tab-selected-indicator-color-default'),
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
      if (this.settingsOpen || this.tabMenu?.isConnected || ([this.search, this.splitSearch].includes(this.shadow.activeElement) && this.shadow.activeElement.value)) return;
      this.peeking = false;
      this._applyLayout();
    }, 350);
  }

  _searchNear(el) {
    return this.splitBody.contains(el) ? this.splitSearch : this.search;
  }

  _openSearch() {
    this.search.focus();
  }

  _escape() {
    const detail = this.tab === 'ci' && this.ci?.detail;
    if (detail && !this.search.value && detail.searchOpen) {
      detail.searchOpen = false;
      this._rerenderCI(this.ci);
      this.body.querySelector('.ht-ci-card-actions .ht-btn')?.focus();
    } else if (detail && !this.search.value) {
      this._closeJob(this.ci);
    } else if (this.search.value) {
      this.search.value = '';
      this._applyFilter();
      this.search.focus();
    } else if (!this.s.docked) {
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

  // One button: collapses when anything is open, otherwise expands everything.
  _toggleExpandAll() {
    if (this.tab === 'ci') {
      this._toggleCIExpandAll();
      return;
    }
    const tree = this._activeTree();
    if (!tree) return;
    if (tree.hasExpanded) tree.collapseAll();
    else tree.expandAll();
  }

  _updateExpandBtn() {
    const tree = this._activeTree();
    const ci = this.tab === 'ci';
    const collapse = ci ? this._ciHasExpanded() : Boolean(tree?.hasExpanded);
    const what = ci ? (this.ci?.detail ? 'steps' : 'runs') : 'folders';
    const label = `${collapse ? 'Collapse' : 'Expand'} all ${what}`;
    this.expandBtn.replaceChildren(HT.icon(collapse ? 'collapseAll' : 'expandAll'));
    this.expandBtn.title = label;
    this.expandBtn.setAttribute('aria-label', label);
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
    if (area === 'sync' && (changes.teamcityServers || changes.teamcityRepos)) {
      HT.teamcity.forget();
      this.ci = null;
      if (this.tab === 'ci' && !this.settingsOpen) this.renderBody();
    }
    if (area === 'local' && changes.bookmarks) this._loadBookmarks();
    if (area === 'local' && (changes.accounts || changes.tokens)) this._loadAccount();
    if (area === 'local' && changes.tokens) this.refresh();
  }

  // ---------- navigation & data ----------

  async navigate(ctx) {
    const seq = ++this.navSeq;
    this.ctx = ctx;
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
      this.search.value = '';
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
        this.repo = await HT.provider.repo(ctx);
        if (seq !== this.navSeq) return;
      }

      let ref;
      let path = '';
      if (ctx.kind === 'pull') {
        if (!this.pr || this.pr.number !== ctx.pullNumber) {
          this._loadPull(ctx);
          if (this.tab !== 'bookmarks') this.tab = this.s.prDefaultTab;
        }
        const info = await this.pr.infoPromise;
        if (seq !== this.navSeq) return;
        ref = info.headSha;
        this.refLabel = info.headRef;
      } else {
        this.pr = null;
        if (this.tab === 'changes') this.tab = this.s.hiddenTabs?.includes('files') ? this.tab : 'files';
        if (ctx.segments.length) {
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
    this._renderHeader();
    this._renderTabs();
    this.renderBody();
  }

  refresh() {
    HT.api.clearMemo();
    HT.teamcity.forget();
    this.repo = null;
    this.code = null;
    this.pr = null;
    this.ci = null;
    if (this.ctx && this.visible) this.navigate(this.ctx);
  }

  _ensureCode(ref) {
    if (this.code?.ref === ref) return this.code.promise;
    const ctx = this.ctx;
    const state = (this.code = { ref, loading: true });
    state.promise = (async () => {
      try {
        const { entries, complete } = await HT.provider.tree(ctx, ref);
        state.root = HT.buildTree(entries, { complete });
        if (!complete) {
          state.lazy = true;
          state.notice = 'Large repository: folders load when opened, and search only covers folders you have opened.';
        }
        state.count = complete ? entries.filter((e) => e.type === 'blob').length : null;
      } catch (err) {
        state.error = err;
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

  _loadPull(ctx) {
    const { pullNumber } = ctx;
    const state = (this.pr = { number: pullNumber, loading: true });
    state.infoPromise = HT.provider.pull(ctx, pullNumber);
    state.promise = (async () => {
      try {
        state.info = await state.infoPromise;
        const files = await HT.provider.pullFiles(ctx, pullNumber, state.info.changedFiles ?? Infinity);
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
    return HT.provider.diffUrl(this.ctx, this.pr.number, node.anchor);
  }

  // On the PR's diff page, scroll in place instead of reloading.
  _openDiff(node) {
    if (!HT.provider.onDiffPage(this.pr.number)) return false;
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
    if (this.tab === 'files') return this.filesTree;
    if (this.tab === 'changes') return this.changesTree;
    return null;
  }

  _renderHeader() {
    if (!this.ctx) return;
    this._renderStats();
    this._updateStar();
  }

  // Built-in tabs: [id, icon, label]. 'changes' only exists on pull requests;
  // 'settings' shows the settings panel over the current tab.
  _tabDefs() {
    const n = this.pr?.info?.changed_files;
    return [
      ['changes', 'diff', n != null ? `Changes ${HT.formatCount(n)}` : 'Changes'],
      ['files', 'files', 'Files'],
      ['ci', 'actions', 'CI/CD'],
      ['bookmarks', 'bookmark', this.bookmarks.length ? `Bookmarks ${this.bookmarks.length}` : 'Bookmarks'],
      ['settings', 'settings', 'Settings'],
    ];
  }

  _sortTabs(defs) {
    const order = this.s.tabOrder || HT.DEFAULTS.tabOrder;
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
    return defs.sort((a, b) => rank(a[0]) - rank(b[0]));
  }

  // Tabs turned on in the + menu that can show on this page.
  _shownTabs() {
    const hidden = this.s.hiddenTabs || [];
    return this._tabDefs().filter(([id]) => !hidden.includes(id) && (id !== 'changes' || this.ctx?.kind === 'pull'));
  }

  _renderTabs() {
    let tabs = this._shownTabs();
    if (!tabs.some(([id]) => id !== 'settings')) tabs = [...this._tabDefs().filter(([id]) => id === 'files'), ...tabs];
    if (!tabs.some(([id]) => id === this.tab && id !== 'settings')) this.tab = tabs.find(([id]) => id !== 'settings')[0];
    const active = this.settingsOpen && tabs.some(([id]) => id === 'settings') ? 'settings' : this.tab;
    // A split tab that can't show here any more (hidden, or Changes off a
    // pull request) closes the split.
    if (this.split && (this.split === this.tab || !tabs.some(([id]) => id === this.split))) {
      this.split = null;
      this.splitBody.replaceChildren();
      this._renderSplit();
    }
    const menuOpen = Boolean(this.tabMenu?.isConnected);
    this.tabsEl.replaceChildren(
      ...this._sortTabs(tabs).map(([id, icon, label]) =>
        h(
          'button',
          {
            class: `ht-tab${active === id ? ' active' : ''}${this.split === id ? ' split' : ''}`,
            type: 'button',
            role: 'tab',
            title: id === 'settings' ? label : this.split === id ? `${label} (shown below; hold to close)` : `${label} (hold to show below)`,
            'aria-label': label,
            'aria-selected': String(active === id),
            dataset: { tab: id },
            onPointerdown: (e) => this._holdTab(e, id),
            onContextmenu: (e) => e.preventDefault(),
            onClick: () => {
              if (this._held) this._held = false;
              else this.setTab(id);
            },
          },
          h('span', { class: 'ht-tab-inner' }, HT.icon(icon), h('span', { class: 'ht-tab-label' }, label))
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
    const labels = { changes: 'Changes', files: 'Files', ci: 'CI/CD', bookmarks: 'Bookmarks', settings: 'Settings' };
    // Rows are divs: Firefox never starts a drag on a <button>.
    const items = this._sortTabs(this._tabDefs()).map(([id, icon]) =>
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
        h('span', { class: 'ht-menu-label' }, labels[id]),
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
    // Clicking the tab shown below swaps the two panes.
    if (tab === this.split) {
      this.split = this.tab;
      [this.search.value, this.splitSearch.value] = [this.splitSearch.value, this.search.value];
    }
    this.tab = tab;
    if (this.settingsOpen) {
      this.toggleSettings(false);
      this._renderSplit();
      this._renderStats();
      return;
    }
    this._renderTabs();
    this.renderBody();
    this._renderStats();
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
    this.splitSearch.value = '';
    this.splitBody.scrollTop = 0;
    this._renderTabs();
    this._renderSplit();
    this._updateExpandBtn();
  }

  closeSplit() {
    this.split = null;
    this.splitSearch.value = '';
    this.splitBody.replaceChildren();
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
        this._renderSettings();
      }
      return;
    }
    this.body.replaceChildren();
    // The job view moves the search input into its card; put it back.
    const jobView = this.tab === 'ci' && Boolean(this.ci?.detail);
    this.root.classList.toggle('ci-job', jobView);
    if (!jobView && this.search.parentElement !== this.searchBar) this.searchBar.insertBefore(this.search, this.expandBtn);
    this.search.placeholder = this._placeholder();
    this._renderContent();
    this._updateExpandBtn();
  }

  // The bottom pane: the held tab, rendered with the same code as the top
  // one (this.body/this.tab point at it meanwhile). The search box and
  // the expand button belong to the top pane.
  _renderSplit() {
    this.splitPane.hidden = !this.split;
    this.splitGap.hidden = !this.split;
    this.root.classList.toggle('split', Boolean(this.split));
    if (!this.split) return;
    const def = this._tabDefs().find(([id]) => id === this.split);
    this.splitTitle.replaceChildren(HT.icon(def[1]), h('span', null, def[2]));
    const top = { body: this.body, tab: this.tab };
    const scroll = this.splitBody.scrollTop;
    Object.assign(this, { body: this.splitBody, tab: this.split, _inSplit: true });
    try {
      this.splitSearch.placeholder = this._placeholder();
      this.body.replaceChildren();
      this._renderContent();
    } finally {
      Object.assign(this, { ...top, _inSplit: false });
    }
    this.splitBody.scrollTop = scroll;
  }

  _placeholder() {
    return { bookmarks: 'Filter bookmarks…', ci: this.ci?.detail ? 'Search logs…' : `Filter ${HT.provider.terms.noRuns}…` }[this.tab] || 'Go to file…';
  }

  // The search box of the pane that's rendering.
  _searchInput() {
    return this._inSplit ? this.splitSearch : this.search;
  }

  // The search box of the pane showing CI.
  _ciSearch() {
    return this.split === 'ci' ? this.splitSearch : this.search;
  }

  _applySplitFilter() {
    const tree = { files: this.filesTree, changes: this.changesTree }[this.split];
    if (tree) tree.setFilter(this.splitSearch.value);
    else this._renderSplit();
  }

  _onSplitSearchKey(e) {
    const tree = { files: this.filesTree, changes: this.changesTree }[this.split];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (tree) tree.focusFirst();
      else this.splitBody.querySelector('.ht-row')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.splitBody.querySelector('.ht-row')?.click();
    } else if (e.key === 'Escape' && this.splitSearch.value) {
      e.preventDefault();
      this.splitSearch.value = '';
      this._applySplitFilter();
    }
  }

  // The search text, for whichever pane is rendering.
  _query() {
    return this._inSplit ? this.splitSearch.value : this.search.value;
  }

  // Redraw the pane(s) showing a tab.
  _refreshTab(tab) {
    if (tab === this.tab) this.renderBody({ split: false });
    if (tab === this.split) this._renderSplit();
  }

  _renderContent() {
    if (this.tab === 'bookmarks') {
      this._renderBookmarks();
      return;
    }
    if (this.tab === 'ci') {
      this._renderCI();
      return;
    }
    if (this.error) {
      this._renderError(this.error);
      return;
    }
    const state = this.tab === 'changes' ? this.pr : this.code;
    const tree = this._activeTree();
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
      tree.setRoot(state.root);
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

  _applyFilter() {
    if (this.tab === 'bookmarks' || this.tab === 'ci') this.renderBody({ split: false });
    else this._activeTree()?.setFilter(this.search.value);
  }

  _onSearchKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.tab === 'bookmarks' || this.tab === 'ci') this.body.querySelector('.ht-row')?.focus();
      else this._activeTree()?.focusFirst();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.body.querySelector('.ht-row')?.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._escape();
    }
  }

  _diffMeta(node) {
    if (node.type === 'tree') return null;
    return h(
      'span',
      { class: 'ht-meta' },
      node.additions ? h('span', { class: 'ht-add' }, `+${node.additions}`) : null,
      node.deletions ? h('span', { class: 'ht-del' }, `−${node.deletions}`) : null,
      h(
        'span',
        { class: `ht-status ht-status-${node.status}`, title: node.previous ? `${node.status} from ${node.previous}` : node.status },
        STATUS_LABEL[node.status] || '?'
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
      const authed = HT.provider.id === 'gitlab' || (rate && rate.limit > 60);
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
    return 'Add an access token in settings to browse private repositories.';
  }

  _renderError(err) {
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
    if (this.tab !== 'bookmarks') this._activeTree()?.render();
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
    const search = this._searchInput();
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
          else if (e.key === 'ArrowUp') (i === 0 ? search : rows[i - 1]).focus();
          else if (e.key === 'Delete' || e.key === 'Backspace') this._toggleBookmark(b);
          else return;
          e.preventDefault();
        });
        list.append(h('li', { role: 'none' }, row));
      }
    }
    this.body.append(list);
  }

  // ---------- CI/CD (GitHub Actions runs / GitLab pipelines, deployments) ----------

  // Runs for the PR's head commit, or for the branch being browsed.
  _ciTarget() {
    if (!this.repo) return null;
    if (this.ctx.kind === 'pull') {
      const sha = this.pr?.info?.headSha;
      return sha ? { key: `sha:${sha}`, sha, label: HT.provider.terms.pullRef(this.ctx.pullNumber) } : null;
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
      this.ci = { key: target.key, target, loading: true, limit: 25, expanded: new Set(), jobs: new Map() };
      this._loadCI(this.ci);
    }
    return this.ci;
  }

  // Not memoized: statuses change. The background's ETag cache keeps
  // unchanged polls cheap (304s don't count against the rate limit).
  async _loadCI(state) {
    const ctx = this.ctx;
    try {
      // "Load more" raises the limit.
      const [{ runs, total, more }, deployments] = await Promise.all([
        HT.provider.runs(ctx, state.target, state.limit),
        HT.provider.deployments(ctx, state.target).catch(() => []),
        this._loadTeamCity(state),
        this._loadOtherCI(state),
      ]);
      const seen = new Set();
      state.runs = runs.filter((r) => !seen.has(r.id) && seen.add(r.id));
      state.count = total;
      state.more = more;
      state.deployments = deployments;
      state.error = null;
      const runIds = new Set(state.expanded);
      if (state.detail) runIds.add(state.detail.runId);
      // TeamCity builds are their own job; they refresh with the section.
      await Promise.all([...runIds].filter((id) => !String(id).startsWith('tc:')).map((id) => this._loadJobs(state, id)));
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
    this._scheduleCIPoll(state);
  }

  // Keep polling while anything is still running.
  // TeamCity builds for this repository, if a TeamCity server is set up:
  // state.tc is null (none), { builds, url } or { error }.
  async _loadTeamCity(state) {
    const ctx = this.ctx;
    const { target } = state;
    const recentShas = () => (target.sha ? Promise.resolve([target.sha]) : HT.provider.recentShas(ctx, target.ref));
    try {
      const tc = await HT.teamcity.load({
        repoKey: HT.url.repoKey(ctx),
        target: { ...target, isDefault: target.ref === this.repo?.defaultBranch },
        limit: 10,
        recentShas,
        integration: () => HT.provider.teamcityIntegration?.(ctx) ?? Promise.resolve(null),
        statuses: (sha) => HT.provider.externalStatuses(ctx, sha),
      });
      for (const b of tc?.builds || []) if (state.jobs.has(`tc:${b.id}`)) state.jobs.set(`tc:${b.id}`, { list: [b] });
      state.tc = tc;
    } catch (err) {
      state.tc = { error: err };
    }
  }

  // GitHub: checks and statuses from other CIs on the head commit (GitLab
  // lists those as external pipelines already).
  async _loadOtherCI(state) {
    if (HT.provider.id !== 'github') return;
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
      state.tc?.builds?.some((b) => b.status !== 'completed') ||
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
    const matched = q ? state.runs.filter((r) => HT.fuzzy(q, r.name || '')) : state.runs;
    // Skipped runs (workflows whose conditions didn't match) are mostly
    // noise from bots; hide them unless asked.
    const skipped = matched.filter((r) => r.conclusion === 'skipped').length;
    const runs = this._ciShowSkipped ? matched : matched.filter((r) => r.conclusion !== 'skipped');
    const list = h('ul', { class: 'ht-list ht-ci-list' });
    
    if (state.deployments?.length && !q) {
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

    list.append(
      h(
        'li',
        { class: 'ht-group ht-group-link' },
        h('span', null, `${HT.provider.terms.runs} · ${state.target.label}`),
        skipped
          ? h(
              'button',
              {
                class: 'ht-link',
                type: 'button',
                title: this._ciShowSkipped ? 'Hide skipped runs' : 'Show skipped runs',
                onClick: () => {
                  this._ciShowSkipped = !this._ciShowSkipped;
                  this._rerenderCI(state);
                },
              },
              this._ciShowSkipped ? `Hide ${skipped} skipped` : `${skipped} skipped`
            )
          : null,
        h('a', { href: HT.provider.ciUrl(this.ctx), class: 'ht-link' }, 'All')
      )
    );
    if (!state.runs.length) {
      list.append(h('li', { class: 'ht-empty' }, `No ${HT.provider.terms.noRuns} for ${state.target.label}.`));
    } else if (q && !matched.length) {
      list.append(h('li', { class: 'ht-empty' }, `No ${HT.provider.terms.noRuns} match “${q}”`));
    } else if (!runs.length) {
      list.append(h('li', { class: 'ht-empty' }, 'Only skipped runs here.'));
    }
    for (const run of runs) {
      const open = state.expanded.has(run.id);
      // The row toggles its jobs; GitHub's page is one click away on the icon.
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
        h('span', { class: 'ht-name' }, run.name, h('span', { class: 'ht-dir' }, `#${run.run_number} · ${run.event.replace(/_/g, ' ')} · ${HT.timeAgo(run.run_started_at || run.created_at)}`)),
        this._externalAction(run.html_url, `Open ${HT.provider.terms.run} on ${HT.provider.name}`)
      );
      list.append(h('li', { role: 'none' }, row));
      if (open) this._appendJobs(list, state, run);
    }
    if (state.runs.length && state.more) {
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
                    state.loadingMore = true;
                    this._rerenderCI(state);
                    this._loadCI(state);
                  },
                },
                state.count != null ? `Load more (${HT.formatCount(state.runs.length)} of ${HT.formatCount(state.count)})` : 'Load more'
              )
        )
      );
    }
    this._appendOtherCI(list, state, q);
    this._appendTeamCity(list, state, q);
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    this.body.append(list);
  }

  // TeamCity's own section under the site's runs. A build opens straight
  // into its steps and log.
  _appendTeamCity(list, state, q) {
    const tc = state.tc;
    if (!tc) return;
    list.append(
      h(
        'li',
        { class: 'ht-group ht-group-link' },
        h('span', null, `TeamCity · ${state.target.label}`),
        tc.url ? h('a', { href: HT.safeUrl(tc.url), class: 'ht-link', target: '_blank', rel: 'noopener' }, 'All') : null
      )
    );
    if (tc.needsServer) {
      list.append(
        h(
          'li',
          { class: 'ht-empty ht-ci-note' },
          h('span', null, `This project builds on TeamCity at ${tc.needsServer} (from GitLab's TeamCity integration). Add the server to Hector to see its builds here.`),
          h(
            'button',
            { class: 'ht-link', type: 'button', onClick: () => chrome.runtime.sendMessage({ type: 'openOptions', teamcity: tc.needsServer }).catch(() => {}) },
            'Add TeamCity server ↗'
          )
        )
      );
      return;
    }
    if (tc.error || tc.note) {
      list.append(
        h(
          'li',
          { class: 'ht-empty ht-ci-note' },
          h('span', null, tc.error ? `Couldn't load TeamCity builds. ${tc.error.message}` : tc.note),
          h('button', { class: 'ht-link', type: 'button', onClick: () => this.toggleSettings(true) }, 'Settings')
        )
      );
      return;
    }
    const builds = q ? tc.builds.filter((b) => HT.fuzzy(q, b.name)) : tc.builds;
    if (!builds.length) {
      list.append(h('li', { class: 'ht-empty' }, q ? `No TeamCity builds match “${q}”` : `No TeamCity builds for ${state.target.label}.`));
      return;
    }
    for (const b of builds) {
      const time = this._jobTime(b);
      const when = HT.timeAgo(b.started_at || b.created_at);
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
              title: `${b.name} #${b.run_number}${b.statusText ? `: ${b.statusText}` : ''}`,
              style: '--depth:0',
              dataset: { key: `tc:${b.id}` },
              onClick: () => this._openJob(state, `tc:${b.id}`, b.id, b),
            },
            h('span', { class: 'ht-chevron' }),
            this._ciIcon(b.status, b.conclusion),
            h('span', { class: 'ht-name' }, b.name, h('span', { class: 'ht-dir' }, `#${b.run_number} · ${b.branch || state.target.label} · ${when}`)),
            time ? h('span', { class: 'ht-meta ht-ci-time' }, time) : null,
            this._externalAction(b.html_url, 'Open build on TeamCity')
          )
        )
      );
    }
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

  // A job from another CI: TeamCity builds on a server added to Hector open
  // in the sidebar; anything else opens on its own site.
  async _openExternal(state, job) {
    const link = HT.teamcityLink(job.html_url);
    const { teamcityServers = [] } = link ? await chrome.storage.sync.get('teamcityServers') : {};
    if (link?.buildId && teamcityServers.includes(link.server)) {
      try {
        const build = await HT.teamcity.build(link.server, link.buildId);
        this._openJob(state, `tc:${build.id}`, build.id, build);
        return;
      } catch (err) {
        this._toast(err.message);
      }
    }
    const url = HT.safeUrl(job.html_url);
    if (url) window.open(url, '_blank', 'noopener');
  }

  // GitHub: other CIs' checks on the head commit.
  _appendOtherCI(list, state, q) {
    const items = (state.other || []).filter((j) => !q || HT.fuzzy(q, `${j.ci} ${j.name}`));
    if (!items.length) return;
    list.append(h('li', { class: 'ht-group' }, `Other CI · ${state.target.label}`));
    for (const job of items) {
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
    if (key) this._ciBody().querySelector(`[data-key="${key}"]`)?.focus();
    this._updateExpandBtn();
  }

  // The pane showing CI (the split pane when CI is below).
  _ciBody() {
    return this.split === 'ci' ? this.splitBody : this.body;
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
    const q = this.search.value.trim();
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

  _openJob(state, runId, jobId, tcBuild = null) {
    if (tcBuild) state.jobs.set(runId, { list: [tcBuild] });
    const job = state.jobs.get(runId)?.list?.find((j) => j.id === jobId);
    state.detail = { runId, jobId, job, open: new Set(), logs: null, source: tcBuild ? HT.teamcity : HT.provider };
    this._ciSearch().value = '';
    this._rerenderCI(state);
    this._ciBody().scrollTop = 0;
    this._ciBody().querySelector('.ht-ci-back')?.focus();
  }

  _closeJob(state) {
    const jobId = state.detail?.jobId;
    state.detail = null;
    this._ciSearch().value = '';
    this._rerenderCI(state);
    this._ciBody().querySelector(`[data-key="job:${jobId}"], [data-key="tc:${jobId}"]`)?.focus();
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
    const d = state.detail;
    const job = this._detailJob(state);
    // A TeamCity build is its own run.
    const run = d.source === HT.teamcity ? job : state.runs.find((r) => r.id === d.runId);
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
    const title = h(
      'div',
      { class: 'ht-ci-title' },
      run ? this._ciIcon(run.status, run.conclusion) : null,
      h('h2', { title: run ? `${run.name} #${run.run_number}` : '' }, run?.name || 'Workflow run', run ? h('span', null, ` #${run.run_number}`) : null)
    );
    const head = h(
      'div',
      { class: 'ht-ci-card-head' },
      h(
        'div',
        { class: 'ht-ci-head-text' },
        h('a', { class: 'ht-ci-job-name', href: HT.safeUrl(job.html_url), title: `Open job on ${d.source.name}` }, job.name),
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
        this._inSplit ? null : this._btn('search', 'Search logs', () => {
          d.searchOpen = !(d.searchOpen || this.search.value);
          if (!d.searchOpen) {
            this.search.value = '';
            this._rerenderCI(state);
          } else {
            this._rerenderCI(state);
            this.search.focus();
          }
        }),
        this._btn(this._ciHasExpanded() ? 'collapseAll' : 'expandAll', this._ciHasExpanded() ? 'Collapse all steps' : 'Expand all steps', () => this._toggleCIExpandAll()),
        this._btn('refresh', `Reload from ${HT.provider.name}`, () => this.refresh()),
        h('a', { class: 'ht-btn', href: HT.safeUrl(job.html_url), title: `Open job on ${d.source.name}`, 'aria-label': `Open job on ${d.source.name}` }, HT.icon('external'))
      )
    );
    const searchOpen = !this._inSplit && (d.searchOpen || Boolean(this.search.value));
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
      const waiting = d.source.liveLogs && !d.logs?.error;
      list.append(h('li', { class: 'ht-empty' }, waiting && d.logs?.text == null ? 'Loading log…' : 'This job has no steps yet.'));
    }
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    // Moving the focused input would drop focus and the caret; restore both.
    const typing = this.shadow.activeElement === this.search;
    const caret = [this.search.selectionStart, this.search.selectionEnd];
    const searchRow = searchOpen ? h('div', { class: 'ht-ci-search' }, h('span', { class: 'ht-search-icon' }, HT.icon('search')), this.search) : null;
    const card = h('section', { class: 'ht-ci-card' }, h('div', { class: 'ht-ci-card-top' }, head, searchRow), list);
    this.body.append(h('div', { class: 'ht-ci-page' }, back, title), card);
    if (!searchOpen && !this._inSplit && this.search.parentElement !== this.searchBar) this.searchBar.insertBefore(this.search, this.expandBtn);
    if (typing && searchOpen) {
      this.search.focus({ preventScroll: true });
      this.search.setSelectionRange(...caret);
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
    else if (e.key === 'ArrowUp') (i === 0 ? (list.closest('.ht-split-body') ? this.splitSearch : this.search) : rows[i - 1]).focus();
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

  // TeamCity for the repository being viewed: on/off, which server, and an
  // optional project ID (otherwise detected from the builds of its commits).
  _teamcitySettings(section) {
    const repoKey = HT.url.repoKey(this.ctx);
    const box = section('TeamCity · this repository');
    const openOptions = () => chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => this._toast('Refresh the page and try again.'));
    chrome.storage.sync.get(['teamcityServers', 'teamcityRepos']).then(({ teamcityServers = [], teamcityRepos = {} }) => {
      const conf = teamcityRepos[repoKey] || {};
      const save = async (patch) => {
        const { teamcityRepos: repos = {} } = await chrome.storage.sync.get('teamcityRepos');
        const next = { ...repos[repoKey], ...patch };
        for (const k of Object.keys(next)) if (!next[k]) delete next[k];
        if (Object.keys(next).length) repos[repoKey] = next;
        else delete repos[repoKey];
        await chrome.storage.sync.set({ teamcityRepos: repos });
      };
      if (!teamcityServers.length) {
        box.append(
          h('p', { class: 'ht-help' }, 'Show TeamCity builds next to your CI runs. Add your TeamCity server first.'),
          h('button', { class: 'ht-secondary', type: 'button', onClick: openOptions }, 'Add a TeamCity server ↗')
        );
        return;
      }
      const project = h('input', {
        class: 'ht-input',
        type: 'text',
        value: conf.project || '',
        placeholder: 'Detected from your commits',
        spellcheck: 'false',
        onChange: (e) => save({ project: e.target.value.trim() }),
      });
      box.append(
        h(
          'label',
          { class: 'ht-check' },
          h('input', { type: 'checkbox', checked: !conf.off, onChange: (e) => save({ off: !e.target.checked }) }),
          h('span', null, 'Show TeamCity builds in CI/CD')
        ),
        teamcityServers.length > 1
          ? h(
              'label',
              { class: 'ht-field' },
              h('span', null, 'Server'),
              h(
                'select',
                { class: 'ht-input', onChange: (e) => save({ server: e.target.value }) },
                h('option', { value: '' }, 'Any of my servers'),
                teamcityServers.map((srv) => h('option', { value: srv, selected: conf.server === srv }, new URL(srv).host))
              )
            )
          : null,
        h('label', { class: 'ht-field' }, h('span', null, 'Build configuration or project ID'), project),
        h(
          'p',
          { class: 'ht-help' },
          "Leave it empty to use GitLab's TeamCity integration, or the TeamCity builds linked from (or built for) this branch's latest commits."
        ),
        h('button', { class: 'ht-link', type: 'button', onClick: openOptions }, 'Manage TeamCity servers ↗')
      );
    });
    return box;
  }

  // ---------- settings (rendered inside the sidebar) ----------

  _renderSettings() {
    const s = this.s;
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
    // The token is write-only here: the input never shows the saved one.
    const showTokenStatus = () =>
      HT.api.send({ type: 'token:status', host }).then(({ hasToken }) => {
        tokenInput.placeholder = hasToken ? 'Saved (hidden). Paste a new one to replace it.' : HT.provider.tokenHint;
        const none = gitlab ? 'No token. Uses your GitLab sign-in in this browser, if any.' : 'No token. Public repositories only, 60 requests/hour.';
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
          h('button', { class: 'ht-secondary', type: 'button', onClick: renderAccount }, 'Back')
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
      section(
        `${name} account${host === 'github.com' || host === 'gitlab.com' ? '' : ` · ${host}`}`,
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
      this.ctx ? this._teamcitySettings(section) : null,
      section(
        'Self-hosted servers',
        h('p', { class: 'ht-help' }, 'GitHub Enterprise or GitLab (CE/EE) on your own domain. Adding one needs a browser permission prompt, which only opens on the extension page.'),
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
      h('p', { class: 'ht-help ht-center' }, `Hector ${chrome.runtime.getManifest().version}`)
    );
    this.body.append(panel);
  }
};

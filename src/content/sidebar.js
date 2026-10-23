// The sidebar: UI shell, data loading for code/PR trees, and bookmarks.
const { h } = HT;

const THEME_TOKENS = [
  '--bg', '--bg-2', '--bg-hover', '--bg-sel', '--bg-input', '--fg', '--fg-2', '--fg-3', '--border',
  '--accent', '--accent-2', '--primary', '--primary-fg', '--add', '--del', '--mod', '--ren', '--mark',
  '--bg-header', '--tab-active', '--bg-overlay', '--shadow-overlay', '--border-muted',
  ...Array.from({ length: 16 }, (_, i) => `--ansi-${i}`),
];

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
      onTop: () => this._openSearch(),
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
      onTop: () => this._openSearch(),
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
    return h('button', { class: 'ht-btn', type: 'button', title, 'aria-label': title, onClick, ...extra }, HT.icon(icon));
  }

  _build() {
    this.host = h('hecta-tree');
    this.host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:31;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.append(h('style', null, HT.CSS));

    this.toggleBtn = h(
      'button',
      {
        class: 'ht-toggle',
        type: 'button',
        title: 'Open HectaTree (Alt+Shift+T)',
        'aria-label': 'Open HectaTree',
        onClick: () => this.setDocked(true),
        onMouseenter: () => this._peekEnter(),
        onMouseleave: () => this._peekLeave(),
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
      h('span', { class: 'ht-search-icon' }, HT.icon('search')),
      this.search,
      (this.expandBtn = this._btn('expandAll', 'Expand all folders', () => this._toggleExpandAll())),
      this._btn('refresh', 'Reload from GitHub', () => this.refresh())
    );

    this.body = h('div', { class: 'ht-body' });
    this.body.addEventListener(
      'scroll',
      () => {
        this.body.classList.add('scrolling');
        clearTimeout(this._scrollbarTimer);
        this._scrollbarTimer = setTimeout(() => this.body.classList.remove('scrolling'), 900);
      },
      { passive: true }
    );
    this.toastEl = h('div', { class: 'ht-toast', role: 'status' });

    this.topBar = h('div', { class: 'ht-top' }, this.tabsEl);
    this.panel = h(
      'aside',
      {
        class: 'ht-panel',
        'aria-label': 'HectaTree',
        onMouseenter: () => this._peekEnter(true),
        onMouseleave: () => this._peekLeave(),
      },
      this.topBar,
      this.searchBar,
      this.body,
      footer,
      this.toastEl,
      h('div', { class: 'ht-resizer', onMousedown: (e) => this._startResize(e) })
    );

    this.root = h('div', { class: 'ht-root', hidden: true }, this.toggleBtn, this.panel);
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

    const html = document.documentElement;
    html.style.setProperty('--hectatree-width', `${width}px`);
    html.classList.toggle('hectatree-docked-left', on && docked && dock === 'left');
    html.classList.toggle('hectatree-docked-right', on && docked && dock === 'right');

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
    const repositoryHeader = this._findHeader();
    const repoNav = document.querySelector('nav[aria-label="Repository"]');
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
    for (const el of document.querySelectorAll('header[data-marketing-header], header.HeaderMktg, header.header-logged-out')) next.add(el);
    for (const el of next) {
      if ([...next].some(parent => parent !== el && parent.contains(el))) next.delete(el);
    }
    for (const el of this._sharedHeaders || []) {
      if (!next.has(el) || !this.visible) el.removeAttribute('data-hectatree-shared-header');
    }
    for (const el of next) {
      if (this.visible) {
        el.setAttribute('data-hectatree-shared-header', getComputedStyle(el).position === 'fixed' ? 'fixed' : 'flow');
        // A widened row must paint the same background across its entire width,
        // including the area outside its original parent header's content box.
        for (let source = el; source; source = source.parentElement) {
          const color = getComputedStyle(source).backgroundColor;
          if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') {
            el.style.setProperty('--hectatree-native-header-bg', color);
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
        if (el.closest('[data-hectatree-shared-header], [data-hectatree-pull-title], dialog, [role="dialog"], [aria-modal="true"]')) continue;
        const r = el.getBoundingClientRect();
        if (!this._shifted.has(el) && (r.height > 160 || r.height < 16)) continue;
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
      if (!bars.has(el)) el.removeAttribute('data-hectatree-pull-title');
    }
    for (const el of bars) el.setAttribute('data-hectatree-pull-title', '');
    this._pullTitleBars = bars;
  }

  // A fixed/sticky bar pinned to the top of the page (shown once GitHub's
  // header has scrolled away).
  _findStickyBar() {
    let best = null;
    let bestHeight = 0;
    const candidates = new Set(document.elementsFromPoint(this._pageX(), 3));
    // README/Contributing/License navigation is inside the content column,
    // which may be far from the sidebar. Its sticky wrapper is an ancestor.
    for (const nav of document.querySelectorAll('nav[aria-label="Repository files"]')) {
      for (let el = nav; el && el !== document.body; el = el.parentElement) candidates.add(el);
    }
    for (const el of candidates) {
      if (el === this.host || el === document.body || el === document.documentElement) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 2 && r.bottom > 2 && r.height >= 24 && r.height <= 160 && r.width > innerWidth / 3 && r.height > bestHeight) {
        best = el;
        bestHeight = r.height;
      }
    }
    return best;
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
    // Match GitHub: copy the page's live colors (any GitHub theme, Dark
    // Reader, userstyles...) onto our tokens.
    const page = getComputedStyle(document.documentElement);
    const read = (...names) => {
      for (const n of names) {
        const v = page.getPropertyValue(n).trim();
        if (v) return v;
      }
      return '';
    };
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const bg = this._rgb(bodyBg)?.[3] > 0 ? bodyBg : read('--bgColor-default', '--color-canvas-default');
    const fg = getComputedStyle(document.body).color || read('--fgColor-default', '--color-fg-default');
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
      '--bg-2': read('--bgColor-muted', '--color-canvas-subtle'),
      '--bg-overlay': read('--overlay-bgColor', '--color-canvas-overlay'),
      '--shadow-overlay': read('--shadow-floating-small', '--color-overlay-shadow'),
      '--border-muted': read('--borderColor-muted', '--color-border-muted'),
      '--bg-input': read('--bgColor-inset', '--color-canvas-inset') || bg,
      '--bg-hover': read('--control-transparent-bgColor-hover', '--color-action-list-item-default-hover-bg'),
      '--bg-sel': read('--bgColor-accent-muted', '--color-accent-subtle'),
      '--fg-2': read('--fgColor-muted', '--color-fg-muted'),
      '--border': read('--borderColor-default', '--color-border-default'),
      '--accent': read('--fgColor-accent', '--color-accent-fg'),
      '--accent-2': read('--fgColor-accent', '--color-accent-fg'),
      '--primary': read('--button-primary-bgColor-rest', '--bgColor-success-emphasis', '--color-btn-primary-bg'),
      '--primary-fg': read('--button-primary-fgColor-rest', '--fgColor-onEmphasis', '--color-btn-primary-text'),
      '--add': read('--fgColor-success', '--color-success-fg'),
      '--del': read('--fgColor-danger', '--color-danger-fg'),
      '--mod': read('--fgColor-attention', '--color-attention-fg'),
      '--ren': read('--fgColor-accent', '--color-accent-fg'),
      '--mark': read('--bgColor-attention-muted', '--color-attention-subtle'),
      '--tab-active': read('--underlineNav-borderColor-active', '--color-primer-border-active'),
    };
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

  _peekEnter(fromPanel = false) {
    clearTimeout(this._peekTimer);
    if (this.s.docked || (!fromPanel && !this.s.hoverPeek)) return;
    if (fromPanel && !this.peeking) return;
    this._peekTimer = setTimeout(() => {
      this.peeking = true;
      this._applyLayout();
    }, fromPanel ? 0 : 120);
  }

  _peekLeave() {
    clearTimeout(this._peekTimer);
    if (this.s.docked) return;
    this._peekTimer = setTimeout(() => {
      // Stay open while the user is busy in the panel.
      if (this.settingsOpen || this.tabMenu?.isConnected || (this.shadow.activeElement === this.search && this.search.value)) return;
      this.peeking = false;
      this._applyLayout();
    }, 350);
  }

  _openSearch() {
    this.search.focus();
  }

  _escape() {
    if (this.tab === 'ci' && this.ci?.detail && !this.search.value) {
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
    html.classList.add('hectatree-resizing');
    this.root.classList.add('resizing');
    const move = (ev) => {
      this.s.width = Math.round(Math.max(200, Math.min(800, startWidth + (ev.clientX - startX) * dir)));
      this._applyLayout();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      html.classList.remove('hectatree-resizing');
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
    this.renderBody();
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
        this.repo = await HT.api.repo(ctx.owner, ctx.repo);
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
        ref = info.head.sha;
        this.refLabel = info.head.ref;
      } else {
        this.pr = null;
        if (this.tab === 'changes') this.tab = this.s.hiddenTabs?.includes('files') ? this.tab : 'files';
        if (ctx.segments.length) {
          const known = [this.code?.ref, this.repo.default_branch];
          ({ ref, path } = await HT.api.resolveRef(ctx.owner, ctx.repo, ctx.segments, known));
          if (seq !== this.navSeq) return;
        } else {
          ref = this.repo.default_branch;
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
    this.repo = null;
    this.code = null;
    this.pr = null;
    this.ci = null;
    if (this.ctx && this.visible) this.navigate(this.ctx);
  }

  _ensureCode(ref) {
    if (this.code?.ref === ref) return this.code.promise;
    const { owner, repo } = this.ctx;
    const state = (this.code = { ref, loading: true });
    state.promise = (async () => {
      try {
        const data = await HT.api.tree(owner, repo, ref);
        if (data.truncated) {
          const top = await HT.api.subtree(owner, repo, data.sha);
          state.root = HT.buildTree(top, { complete: false });
          state.lazy = true;
          state.notice = 'Large repository: folders load when opened, and search only covers folders you have opened.';
        } else {
          state.root = HT.buildTree(data.tree);
        }
        state.count = data.truncated ? null : data.tree.filter((e) => e.type === 'blob').length;
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
    const { owner, repo } = this.ctx;
    const entries = await HT.api.subtree(owner, repo, node.sha);
    node.children = entries.map((e) => HT.makeNode(e.path, `${node.path}/${e.path}`, e.type, { sha: e.sha, size: e.size }));
    HT.sortTree(node);
    node.loaded = true;
  }

  _loadPull(ctx) {
    const { owner, repo, pullNumber } = ctx;
    const state = (this.pr = { number: pullNumber, loading: true });
    state.infoPromise = HT.api.pull(owner, repo, pullNumber);
    state.promise = (async () => {
      try {
        state.info = await state.infoPromise;
        const files = await HT.api.pullFiles(owner, repo, pullNumber, state.info.changed_files);
        const entries = await Promise.all(
          files.map(async (f) => ({
            path: f.filename,
            type: 'blob',
            sha: f.sha,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            previous: f.previous_filename,
            anchor: `diff-${await HT.sha256Hex(f.filename)}`,
          }))
        );
        state.root = HT.buildTree(entries);
        state.count = files.length;
        if (state.info.changed_files > files.length) {
          state.notice = `GitHub's API returns only the first ${files.length} of ${state.info.changed_files} changed files.`;
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
    const { host, owner, repo } = this.ctx;
    return `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  _codeLink(node) {
    if (!this.code) return null;
    if (node.type === 'commit') return null;
    const kind = node.type === 'tree' ? 'tree' : 'blob';
    return `${this._base()}/${kind}/${HT.encodePath(this.code.ref)}/${HT.encodePath(node.path)}`;
  }

  _diffLink(node) {
    return `${this._base()}/pull/${this.pr.number}/files#${node.anchor}`;
  }

  // On the PR's diff page, scroll in place instead of reloading.
  _openDiff(node) {
    const onFilesPage = new RegExp(`/pull/${this.pr.number}/(files|changes)`).test(location.pathname);
    if (!onFilesPage) return false;
    const target = document.getElementById(node.anchor) || document.querySelector(`[data-tagsearch-path="${CSS.escape(node.path)}"]`);
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

  // Built-in tabs: [id, icon, label]. 'changes' only exists on pull requests.
  _tabDefs() {
    const n = this.pr?.info?.changed_files;
    return [
      ['changes', 'diff', n != null ? `Changes ${HT.formatCount(n)}` : 'Changes'],
      ['files', 'files', 'Files'],
      ['ci', 'actions', 'CI/CD'],
      ['bookmarks', 'bookmark', this.bookmarks.length ? `Bookmarks ${this.bookmarks.length}` : 'Bookmarks'],
    ];
  }

  _renderTabs() {
    const hidden = this.s.hiddenTabs || [];
    let tabs = this._tabDefs().filter(([id]) => !hidden.includes(id) && (id !== 'changes' || this.ctx?.kind === 'pull'));
    if (!tabs.length) tabs = this._tabDefs().filter(([id]) => id === 'files');
    if (!tabs.some(([id]) => id === this.tab)) this.tab = tabs[0][0];
    const order = this.s.tabOrder || HT.DEFAULTS.tabOrder;
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
    tabs.sort((a, b) => rank(a[0]) - rank(b[0]));
    const menuOpen = Boolean(this.tabMenu?.isConnected);
    this.tabsEl.replaceChildren(
      ...tabs.map(([id, icon, label]) => {
        const tab = h(
          'button',
          {
            class: `ht-tab${this.tab === id ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            title: `${label} (drag to reorder)`,
            'aria-label': label,
            'aria-selected': String(this.tab === id),
            draggable: 'true',
            dataset: { tab: id },
            onClick: () => this.setTab(id),
          },
          h('span', { class: 'ht-tab-inner' }, HT.icon(icon), h('span', { class: 'ht-tab-label' }, label))
        );
        this._makeTabDraggable(tab);
        return tab;
      }),
      h(
        'button',
        {
          class: 'ht-tab ht-tab-add',
          type: 'button',
          title: 'Show or hide tabs',
          'aria-label': 'Show or hide tabs',
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

  // Drag a tab onto another to reorder; the order is saved in settings.
  _makeTabDraggable(tab) {
    const clear = () => this.tabsEl.querySelectorAll('.drop-before, .drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
    tab.addEventListener('dragstart', (e) => {
      this._dragTab = tab.dataset.tab;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this._dragTab);
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      clear();
      this._dragTab = null;
    });
    tab.addEventListener('dragover', (e) => {
      if (!this._dragTab || this._dragTab === tab.dataset.tab) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = tab.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      clear();
      tab.classList.add(after ? 'drop-after' : 'drop-before');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this._dragTab;
      const to = tab.dataset.tab;
      const after = tab.classList.contains('drop-after');
      clear();
      if (!from || from === to) return;
      const order = [...(this.s.tabOrder || HT.DEFAULTS.tabOrder)];
      for (const id of HT.DEFAULTS.tabOrder) if (!order.includes(id)) order.push(id);
      order.splice(order.indexOf(from), 1);
      order.splice(order.indexOf(to) + (after ? 1 : 0), 0, from);
      HT.store.set({ tabOrder: order });
      this._renderTabs();
    });
  }

  // A GitHub-style action menu: one checkable row per tab. Rows update in
  // place, so the menu doesn't flash while toggling.
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
    const order = this.s.tabOrder || HT.DEFAULTS.tabOrder;
    const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
    const defs = this._tabDefs().sort((a, b) => rank(a[0]) - rank(b[0]));
    const items = defs.map(([id, icon]) => {
      const label = { changes: 'Changes', files: 'Files', ci: 'CI/CD', bookmarks: 'Bookmarks' }[id];
      const item = h(
        'button',
        {
          class: 'ht-menu-item',
          type: 'button',
          role: 'menuitemcheckbox',
          dataset: { tab: id },
          onClick: () => {
            const hidden = this.s.hiddenTabs || [];
            const on = !hidden.includes(id);
            // Keep at least one tab that can show on this page.
            const usable = this._tabDefs().filter(([t]) => t !== id && !hidden.includes(t) && (t !== 'changes' || this.ctx?.kind === 'pull'));
            if (on && !usable.length) return;
            HT.store.set({ hiddenTabs: on ? [...hidden, id] : hidden.filter((t) => t !== id) });
            this._renderTabs();
            this.renderBody();
            sync();
          },
        },
        h('span', { class: 'ht-menu-check' }, HT.icon('check')),
        HT.icon(icon),
        h('span', { class: 'ht-menu-label' }, label),
        id === 'changes' ? h('span', { class: 'ht-menu-desc' }, 'Pull requests') : null
      );
      return item;
    });
    const sync = () => {
      const hidden = this.s.hiddenTabs || [];
      for (const item of items) item.setAttribute('aria-checked', String(!hidden.includes(item.dataset.tab)));
    };
    sync();
    this.tabMenu = h(
      'div',
      { class: 'ht-menu', role: 'menu', 'aria-label': 'Tabs', onClick: (e) => e.stopPropagation(), onKeydown: (e) => this._menuKey(e, items) },
      h('div', { class: 'ht-menu-title' }, 'Tabs'),
      items,
      h('div', { class: 'ht-menu-divider', role: 'separator' }),
      h('div', { class: 'ht-menu-note' }, 'Drag tabs to reorder them.')
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
    } else if (e.key === 'Tab') {
      this._toggleTabMenu(false);
    }
  }

  setTab(tab) {
    this.tab = tab;
    this._renderTabs();
    this.renderBody();
    this._renderStats();
  }

  renderBody() {
    if (this.settingsOpen) {
      // Keep an open settings panel (and its inputs/status) across data refreshes.
      if (!this.body.querySelector('.ht-settings')) {
        this.body.replaceChildren();
        this._renderSettings();
      }
      return;
    }
    this.body.replaceChildren();
    this.body.classList.remove('inset');
    this.search.placeholder =
      { bookmarks: 'Filter bookmarks…', ci: this.ci?.detail ? 'Search logs…' : 'Filter workflows…' }[this.tab] || 'Go to file…';
    if (this.tab === 'bookmarks') {
      this._renderBookmarks();
      return;
    }
    if (this.tab === 'ci') {
      this._renderCI();
      this._updateExpandBtn();
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
    if (tree.filterText !== this.search.value.trim()) tree.setFilter(this.search.value);
    if (this.tab === 'files') {
      tree.reveal(this.currentPath).catch((err) => this._toast(err.message));
    } else {
      tree.render();
    }
    this._updateExpandBtn();
  }

  _applyFilter() {
    if (this.tab === 'bookmarks' || this.tab === 'ci') this.renderBody();
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
      parts.push(h('span', { class: 'ht-stat-ref', title: title ? `#${ctx.pullNumber} ${title}` : '' }, HT.icon('pull'), `#${ctx.pullNumber}`));
    } else if (ctx) {
      const ref = this.refLabel || this.repo?.default_branch;
      if (ref) parts.push(h('span', { class: 'ht-stat-ref', title: ref }, HT.icon('branch'), h('span', { class: 'ht-stat-ref-text' }, ref)));
    }
    const state = { changes: this.pr, ci: this.ci }[this.tab] || this.code;
    if (state?.count != null) {
      const label = { changes: 'changed', ci: state.count === 1 ? 'run' : 'runs' }[this.tab] || 'files';
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
    const budget = rate ? `${rate.remaining.toLocaleString()} of ${rate.limit.toLocaleString()} API requests left this hour` : '';
    if (!account) {
      // A token without a known login (saved by an older build): look it up once.
      if (rate && rate.limit > 60 && !this._accountLookup) this._lookupAccount();
      this.accountEl.className = `ht-account-chip ht-link${low ? ' low' : ''}`;
      this.accountEl.replaceChildren(rate && rate.limit > 60 ? 'Signed in' : 'Sign in');
      this.accountEl.title = rate && rate.limit > 60 ? budget : `Not signed in: public repos only. ${budget}`.trim();
      return;
    }
    this.accountEl.className = `ht-account-chip${low ? ' low' : ''}`;
    this.accountEl.replaceChildren(
      account.avatar ? h('img', { class: 'ht-account-avatar', src: `${account.avatar}${account.avatar.includes('?') ? '&' : '?'}s=32`, alt: '' }) : null,
      h('span', { class: 'ht-account-login' }, account.login)
    );
    this.accountEl.title = `Signed in as ${account.login}${budget ? `\n${budget}` : ''}`;
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
      const { data } = await HT.api.request('/user');
      const { accounts = {} } = await chrome.storage.local.get('accounts');
      accounts[location.host] = { login: data.login, avatar: data.avatar_url, method: 'token' };
      await chrome.storage.local.set({ accounts });
    } catch {
      // Leave the generic label.
    }
  }

  _renderError(err) {
    let title = 'Something went wrong';
    let text = err.message;
    let settings = false;
    if (err.status === -1) {
      title = 'Reload needed';
    } else if (err.status === -2) {
      title = 'Extension not responding';
      text = `${err.message}. Try Retry; if it keeps failing, reload HectaTree from the browser's add-ons page.`;
    } else if (err.rateLimited) {
      title = 'API rate limit reached';
      const reset = err.rateReset ? ` It resets at ${new Date(err.rateReset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
      text = err.hasToken
        ? `You've used all 5,000 requests for this hour.${reset}`
        : `Without a token GitHub allows only 60 requests per hour.${reset} Sign in with GitHub to raise it to 5,000.`;
      settings = !err.hasToken;
    } else if (err.status === 401) {
      title = 'Token rejected';
      text = 'Your GitHub sign-in or access token is no longer valid. Sign in again in settings.';
      settings = true;
    } else if (err.status === 404) {
      title = 'Repository not accessible';
      text = err.hasToken
        ? 'Not found, or your token cannot read this repository. Check the token\'s repository access.'
        : 'This repository is private or does not exist. Sign in with GitHub to browse private repositories.';
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
    if (this.tab === 'bookmarks') this.renderBody();
    else this._activeTree()?.render();
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
        url: `${this._base()}/pull/${pullNumber}`,
        title: `#${pullNumber} ${this.pr?.info?.title || ''}`.trim(),
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
    const q = this.search.value.trim();
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
          else if (e.key === 'ArrowUp') (i === 0 ? this.search : rows[i - 1]).focus();
          else if (e.key === 'Delete' || e.key === 'Backspace') this._toggleBookmark(b);
          else return;
          e.preventDefault();
        });
        list.append(h('li', { role: 'none' }, row));
      }
    }
    this.body.append(list);
  }

  // ---------- CI/CD (GitHub Actions runs and deployments) ----------

  // Runs for the PR's head commit, or for the branch being browsed.
  _ciTarget() {
    if (!this.repo) return null;
    if (this.ctx.kind === 'pull') {
      const sha = this.pr?.info?.head?.sha;
      return sha ? { key: `sha:${sha}`, query: `head_sha=${sha}`, deploy: `sha=${sha}`, label: `#${this.ctx.pullNumber}` } : null;
    }
    const ref = this.code?.ref || this.repo.default_branch;
    if (/^[0-9a-f]{40}$/i.test(ref)) return { key: `sha:${ref}`, query: `head_sha=${ref}`, deploy: `sha=${ref}`, label: ref.slice(0, 7) };
    return { key: `ref:${ref}`, query: `branch=${encodeURIComponent(ref)}`, deploy: '', label: ref };
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
    const { owner, repo } = this.ctx;
    const base = HT.api.repoPath(owner, repo);
    try {
      // GitHub pages runs 100 at a time; "Load more" raises the limit.
      const perPage = Math.min(state.limit, 100);
      const pages = Math.ceil(state.limit / perPage);
      const [runPages, deployments] = await Promise.all([
        Promise.all(
          Array.from({ length: pages }, (_, i) => HT.api.request(`${base}/actions/runs?per_page=${perPage}&page=${i + 1}&${state.target.query}`))
        ),
        this._loadDeployments(base, state.target.deploy).catch(() => []),
      ]);
      const seen = new Set();
      state.runs = runPages.flatMap((r) => r.data.workflow_runs || []).filter((r) => !seen.has(r.id) && seen.add(r.id));
      state.count = runPages[0].data.total_count;
      state.deployments = deployments;
      state.error = null;
      const runIds = new Set(state.expanded);
      if (state.detail) runIds.add(state.detail.runId);
      await Promise.all([...runIds].map((id) => this._loadJobs(state, id)));
    } catch (err) {
      if (!state.runs) state.error = err;
      else this._toast(err.message);
    }
    state.loading = false;
    state.loadingMore = false;
    if (this.ci !== state) return;
    if (this.tab === 'ci') {
      this._rerenderCI(state);
      this._renderStats();
    }
    this._scheduleCIPoll(state);
  }

  // Keep polling while anything is still running.
  _scheduleCIPoll(state) {
    const busy = state.runs?.some((r) => r.status !== 'completed') || state.deployments?.some((d) => d.busy);
    clearTimeout(this._ciTimer);
    if (!busy || this.ci !== state) return;
    this._ciTimer = setTimeout(() => {
      if (this.ci === state && this.visible && this.tab === 'ci') this._loadCI(state);
      else if (this.ci === state) state.stale = true;
    }, 15000);
  }

  // Latest deployment per environment, with its latest status.
  async _loadDeployments(base, filter) {
    const { data } = await HT.api.request(`${base}/deployments?per_page=30${filter ? `&${filter}` : ''}`);
    const latest = new Map();
    for (const d of data || []) if (!latest.has(d.environment)) latest.set(d.environment, d);
    const list = [...latest.values()].slice(0, 8);
    return Promise.all(
      list.map(async (d) => {
        const { data: statuses } = await HT.api.request(`${base}/deployments/${d.id}/statuses?per_page=1`).catch(() => ({ data: [] }));
        const st = statuses?.[0];
        const state = st?.state || 'pending';
        return {
          id: d.id,
          environment: d.environment,
          ref: d.ref,
          sha: d.sha,
          state,
          busy: Boolean(st) && ['pending', 'queued', 'in_progress'].includes(state),
          when: st?.created_at || d.created_at,
          url: st?.environment_url || st?.log_url || st?.target_url || `https://${this.ctx.host}/${this.ctx.owner}/${this.ctx.repo}/deployments`,
        };
      })
    );
  }

  async _loadJobs(state, runId) {
    const { owner, repo } = this.ctx;
    const entry = state.jobs.get(runId) || {};
    state.jobs.set(runId, { ...entry, loading: !entry.list });
    try {
      const { data } = await HT.api.request(`${HT.api.repoPath(owner, repo)}/actions/runs/${runId}/jobs?per_page=50`);
      state.jobs.set(runId, { list: data.jobs || [] });
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
      this.body.append(h('div', { class: 'ht-loading' }, h('span', { class: 'ht-spinner' }), 'Loading workflow runs…'));
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
    const q = this.search.value.trim();
    const matched = q ? state.runs.filter((r) => HT.fuzzy(q, r.name || '')) : state.runs;
    // Skipped runs (workflows whose conditions didn't match) are mostly
    // noise from bots; hide them unless asked.
    const skipped = matched.filter((r) => r.conclusion === 'skipped').length;
    const runs = this._ciShowSkipped ? matched : matched.filter((r) => r.conclusion !== 'skipped');
    const list = h('ul', { class: 'ht-list ht-ci-list' });
    const repoUrl = `https://${this.ctx.host}/${this.ctx.owner}/${this.ctx.repo}`;

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
        h('span', null, `Workflow runs · ${state.target.label}`),
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
        h('a', { href: `${repoUrl}/actions`, class: 'ht-link' }, 'All')
      )
    );
    if (!state.runs.length) {
      list.append(h('li', { class: 'ht-empty' }, `No workflow runs for ${state.target.label}.`));
    } else if (q && !matched.length) {
      list.append(h('li', { class: 'ht-empty' }, `No workflows match “${q}”`));
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
        this._externalAction(run.html_url, 'Open run on GitHub')
      );
      list.append(h('li', { role: 'none' }, row));
      if (open) this._appendJobs(list, state, run);
    }
    if (state.runs.length && state.runs.length < state.count) {
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
                `Load more (${HT.formatCount(state.runs.length)} of ${HT.formatCount(state.count)})`
              )
        )
      );
    }
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    this.body.append(list);
  }

  _externalAction(url, title) {
    return h(
      'span',
      { class: 'ht-row-actions' },
      h(
        'a',
        { class: 'ht-act', href: url, title, tabindex: '-1', onClick: (e) => e.stopPropagation() },
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
              title: `${job.name}: show steps and logs`,
              style: '--depth:1',
              dataset: { key: `job:${job.id}` },
              onClick: () => this._openJob(state, run.id, job.id),
            },
            h('span', { class: 'ht-chevron' }),
            this._ciIcon(job.status, job.conclusion),
            h('span', { class: 'ht-name' }, job.name),
            time ? h('span', { class: 'ht-meta ht-ci-time' }, time) : null,
            this._externalAction(job.html_url, 'Open job on GitHub')
          )
        )
      );
    }
  }

  _jobTime(item) {
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
    if (this.ci !== state || this.tab !== 'ci' || this.settingsOpen) return;
    const key = this.shadow.activeElement?.dataset?.key;
    const scroll = this.body.scrollTop;
    this.renderBody();
    this.body.scrollTop = scroll;
    if (key) this.body.querySelector(`[data-key="${key}"]`)?.focus();
    this._updateExpandBtn();
  }

  // Expand/collapse all: run jobs in the list, steps in a job's detail view.
  _toggleCIExpandAll() {
    const state = this.ci;
    if (!state?.runs) return;
    if (state.detail) {
      const steps = this._detailJob(state)?.steps || [];
      const d = state.detail;
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

  _openJob(state, runId, jobId) {
    const job = state.jobs.get(runId)?.list?.find((j) => j.id === jobId);
    state.detail = { runId, jobId, job, open: new Set(), logs: null };
    this.search.value = '';
    // Open the failing step, like GitHub does.
    const failed = job?.steps?.find((s) => ['failure', 'timed_out', 'cancelled'].includes(s.conclusion));
    if (failed) state.detail.open.add(failed.number);
    if (job?.status === 'completed') this._loadLogs(state, state.detail);
    this._rerenderCI(state);
    this.body.scrollTop = 0;
    this.body.querySelector('.ht-ci-back')?.focus();
  }

  _closeJob(state) {
    const jobId = state.detail?.jobId;
    state.detail = null;
    this.search.value = '';
    this._rerenderCI(state);
    this.body.querySelector(`[data-key="job:${jobId}"]`)?.focus();
  }

  async _loadLogs(state, detail) {
    if (detail.logs?.loading || detail.logs?.text != null) return;
    detail.logs = { loading: true };
    const { owner, repo } = this.ctx;
    try {
      const text = await HT.api.text(`${HT.api.repoPath(owner, repo)}/actions/jobs/${detail.jobId}/logs`);
      detail.logs = { text };
    } catch (err) {
      detail.logs = { error: err };
    }
    if (state.detail === detail) this._rerenderCI(state);
  }

  // Split a job log into steps. Step times only have whole seconds, so move
  // to the next step once the current one has ended, or when a step's first
  // line ("##[group]Run …", "Post job cleanup.", …) shows up after the next
  // step has started. Skipped steps print nothing.
  _logsByStep(text, steps) {
    const sec = (iso) => Math.floor(new Date(iso) / 1000);
    const order = steps
      .filter((s) => s.started_at)
      .map((s) => ({ number: s.number, skipped: s.conclusion === 'skipped', start: sec(s.started_at), end: s.completed_at ? sec(s.completed_at) : Infinity }))
      .sort((a, b) => a.start - b.start || a.number - b.number);
    const out = new Map(steps.map((s) => [s.number, []]));
    let i = 0;
    for (const raw of text.replace(/^\uFEFF/, '').replace(/\r?\n$/, '').split(/\r?\n/)) {
      const m = raw.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/);
      // Colors stay in the line; the viewer renders them.
      const line = m ? m[2] : raw;
      if (m) {
        const at = sec(m[1]);
        const header = /^(##\[group\]Run |Post job cleanup\.|Cleaning up orphan processes)/.test(HT.stripAnsi(line));
        let next = i + 1;
        if (header) while (next < order.length && order[next].skipped) next++;
        if (header && next < order.length && order[next].start <= at) i = next;
        else while (i + 1 < order.length && at > order[i].end) i++;
      }
      if (order[i]) out.get(order[i].number).push(line);
    }
    return out;
  }

  // While a job runs, refresh just that job every 5s (304s are free).
  _scheduleJobPoll(state, d) {
    if (this._jobTimer?.detail === d) return;
    clearTimeout(this._jobTimer?.id);
    const id = setTimeout(async () => {
      this._jobTimer = null;
      if (this.ci !== state || state.detail !== d || !this.visible || this.tab !== 'ci') return;
      const { owner, repo } = this.ctx;
      try {
        const { data } = await HT.api.request(`${HT.api.repoPath(owner, repo)}/actions/jobs/${d.jobId}`);
        const jobs = state.jobs.get(d.runId);
        if (jobs?.list) jobs.list = jobs.list.map((j) => (j.id === data.id ? data : j));
        d.job = data;
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
    const run = state.runs.find((r) => r.id === d.runId);
    if (!job) {
      state.detail = null;
      this._renderCI();
      return;
    }
    // A job that just finished: fetch its logs now. A running one: follow
    // its steps every few seconds.
    if (job.status === 'completed' && !d.logs) this._loadLogs(state, d);
    if (job.status !== 'completed') this._scheduleJobPoll(state, d);

    const back = h(
      'button',
      { class: 'ht-ci-back', type: 'button', title: 'Back to runs (Esc)', onClick: () => this._closeJob(state) },
      h('span', { class: 'ht-ci-back-icon' }, HT.icon('chevron')),
      h('span', null, run ? `${run.name} #${run.run_number}` : 'Runs')
    );
    const time = this._jobTime(job);
    const head = h(
      'div',
      { class: 'ht-ci-head' },
      this._ciIcon(job.status, job.conclusion),
      h(
        'div',
        { class: 'ht-ci-head-text' },
        h('strong', null, job.name),
        h(
          'span',
          null,
          job.status !== 'completed' ? h('span', { class: 'ht-live', title: 'Updates every 5 seconds' }, 'Live') : null,
          [this._ciStatus(job.status, job.conclusion)[2], time].filter(Boolean).join(' · ')
        )
      ),
      h('a', { class: 'ht-btn', href: job.html_url, title: 'Open job on GitHub', 'aria-label': 'Open job on GitHub' }, HT.icon('external'))
    );

    if (d.logs?.text != null && d.byStepFor !== d.logs.text) {
      d.byStep = this._logsByStep(d.logs.text, job.steps || []);
      d.byStepFor = d.logs.text;
    }
    const byStep = d.logs?.text != null ? d.byStep : null;
    const q = this.search.value.trim().toLowerCase();
    const list = h('ul', { class: 'ht-list ht-ci-list ht-ci-steps' });
    for (const step of job.steps || []) {
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
      list.prepend(h('li', { class: 'ht-empty' }, `No log lines match “${this.search.value.trim()}”`));
    }
    if (!job.steps?.length) list.append(h('li', { class: 'ht-empty' }, 'This job has no steps yet.'));
    list.addEventListener('keydown', (e) => this._ciKey(e, list));
    const detail = h('div', { class: 'ht-ci-detail' }, back, head);
    this.body.append(detail, list);
    this.body.classList.add('inset');
    // Open step headers stick below the job header, like GitHub's.
    this.body.style.setProperty('--ht-detail-h', `${detail.offsetHeight}px`);
  }

  _renderStepLog(job, step, d, byStep, q = '') {
    const box = (...children) => h('div', { class: 'ht-log' }, ...children);
    if (job.status !== 'completed') {
      return box(
        h('div', { class: 'ht-log-note' }, "GitHub's API only provides logs after a job finishes; they'll appear here then."),
        h('a', { class: 'ht-link ht-log-live', href: job.html_url }, 'Watch the live log on GitHub ↗')
      );
    }
    if (!d.logs || d.logs.loading) return box(h('div', { class: 'ht-log-note' }, h('span', { class: 'ht-spinner' }), 'Loading logs…'));
    if (d.logs.error) {
      const err = d.logs.error;
      const signedOut = err.status === 403 && !err.hasToken;
      return box(
        h('div', { class: 'ht-log-note' }, signedOut ? 'GitHub only shows logs to signed-in users.' : err.message),
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
    else if (e.key === 'ArrowUp') (i === 0 ? this.search : rows[i - 1]).focus();
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
    chrome.storage.local.get('tokens').then(({ tokens = {} }) => {
      tokenInput.value = tokens[host] || '';
      setStatus(tokens[host] ? 'A token is saved for this site.' : 'No token. Public repositories only, 60 requests/hour.');
    });
    const storeToken = async (value) => {
      const { tokens = {}, accounts = {} } = await chrome.storage.local.get(['tokens', 'accounts']);
      if (value) tokens[host] = value;
      else delete tokens[host];
      delete accounts[host]; // a manual token replaces any GitHub sign-in
      await chrome.storage.local.set({ tokens, accounts });
      renderAccount();
      if (value) this._lookupAccount();
    };
    const testToken = async () => {
      setStatus('Testing…');
      try {
        const res = await HT.api.request('/user');
        setStatus(`Works: signed in as ${res.data.login}. ${res.rateRemaining}/${res.rateLimit} requests left.`, 'ok');
      } catch (err) {
        setStatus(err.status === 401 ? 'GitHub rejected this token.' : err.message, 'err');
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
      const [{ accounts = {} }, config] = await Promise.all([chrome.storage.local.get('accounts'), send({ type: 'auth:config' })]);
      const account = accounts[host];
      const canSignIn = host === 'github.com' && config?.enabled;
      tokenDetails.open = !canSignIn && !account;
      if (account) {
        accountBox.replaceChildren(
          h(
            'div',
            { class: 'ht-signed-in' },
            account.avatar ? h('img', { class: 'ht-avatar', src: `${account.avatar}&s=64`, alt: '' }) : null,
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
          h(
            'p',
            { class: 'ht-help' },
            'To fully revoke access, remove HectaTree under ',
            h('a', { class: 'ht-link', href: 'https://github.com/settings/applications', target: '_blank', rel: 'noopener' }, 'Authorized OAuth Apps ↗'),
            '.'
          )
        );
      } else if (canSignIn) {
        accountBox.replaceChildren(
          h('p', { class: 'ht-help' }, 'Sign in once to browse private repositories and get 5,000 requests/hour.'),
          h('button', { class: 'ht-primary ht-github-btn', type: 'button', onClick: startSignIn }, HT.icon('logo'), 'Sign in with GitHub')
        );
      } else {
        accountBox.replaceChildren(
          h('p', { class: 'ht-help' }, host === 'github.com' ? 'Sign-in is not set up in this build. Use a personal access token below.' : 'Use a personal access token for this GitHub Enterprise server.')
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
        window.open(start.verification_uri, '_blank', 'noopener');
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
        const added = incoming.filter(
          (b) => b && typeof b.url === 'string' && /^https:\/\//.test(b.url) && typeof b.title === 'string' && !known.has(b.url)
        );
        await HT.store.saveBookmarks([...list, ...added]);
        bmStatus.textContent = `Imported ${added.length} bookmark${added.length === 1 ? '' : 's'}.`;
      } catch (err) {
        bmStatus.textContent = `Import failed: ${err.message}`;
      }
      importInput.value = '';
    });
    const exportBookmarks = () => {
      const blob = new Blob([JSON.stringify({ app: 'hectatree', version: 1, bookmarks: this.bookmarks }, null, 2)], {
        type: 'application/json',
      });
      const a = h('a', { href: URL.createObjectURL(blob), download: `hectatree-bookmarks-${new Date().toISOString().slice(0, 10)}.json` });
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
        host === 'github.com' ? 'GitHub account' : `Access token · ${host}`,
        accountBox,
        HT.append(tokenDetails, [
          h('summary', null, 'Use a personal access token instead'),
          h('p', { class: 'ht-help' }, 'Stored only in this browser and sent only to the GitHub API.'),
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
                  await storeToken(tokenInput.value.trim());
                  if (tokenInput.value.trim()) testToken();
                  else setStatus('Token removed.');
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
                  tokenInput.value = '';
                  await storeToken('');
                  setStatus('Token removed.');
                },
              },
              'Remove'
            ),
            h('a', { class: 'ht-link', href: `https://${host}/settings/tokens/new?scopes=repo&description=HectaTree`, target: '_blank', rel: 'noopener' }, 'Create ↗')
          ),
          tokenStatus,
        ])
      ),
      section(
        'Behavior',
        field('Pull requests open on', select('prDefaultTab', [['changes', 'Changed files'], ['files', 'Full file tree']])),
        toggle('docked', 'Dock sidebar (push the page over)'),
        toggle('hoverPeek', 'When undocked, open by hovering the edge'),
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
                if (!confirm('Delete all HectaTree bookmarks?')) return;
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
        'GitHub Enterprise',
        h('p', { class: 'ht-help' }, 'Adding a self-hosted domain needs a browser permission prompt, which only opens on the extension page.'),
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
      h('p', { class: 'ht-help ht-center' }, `HectaTree ${chrome.runtime.getManifest().version}`)
    );
    this.body.append(panel);
  }
};

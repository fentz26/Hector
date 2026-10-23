// The sidebar: UI shell, data loading for code/PR trees, and bookmarks.
const { h } = HT;

const THEME_TOKENS = [
  '--bg', '--bg-2', '--bg-hover', '--bg-sel', '--bg-input', '--fg', '--fg-2', '--fg-3', '--border',
  '--accent', '--accent-2', '--primary', '--primary-fg', '--add', '--del', '--mod', '--ren', '--mark',
  '--bg-header', '--tab-active',
];

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
      onError: (err) => this._toast(err.message),
      onTop: () => this.search.focus(),
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
      onTop: () => this.search.focus(),
      onEscape: () => this._escape(),
      onExpandChange: () => this._updateExpandBtn(),
    });

    this._build();
    this._applyTheme();
    this._applyLayout();
    this._loadBookmarks();
    this._watchTheme();
    this._watchFixedBars();

    HT.api.onRate = (remaining, limit) => {
      this.rate = { remaining, limit };
      this._renderFooter();
    };

    HT.store.onChange((changes, area) => this._onStorageChange(changes, area));
  }

  // ---------- DOM shell ----------

  _btn(icon, title, onClick, extra = {}) {
    return h('button', { class: 'ht-btn', type: 'button', title, 'aria-label': title, onClick, ...extra }, HT.icon(icon));
  }

  _build() {
    this.host = h('hecta-tree');
    this.host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:99;';
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

    this.titleEl = h('a', { class: 'ht-title' });
    this.refEl = h('div', { class: 'ht-ref' });
    this.starBtn = this._btn('bookmark', 'Bookmark this page', () => this._bookmarkCurrent());
    this.pinBtn = this._btn('pin', 'Dock sidebar', () => this.setDocked(!this.s.docked));
    const header = h(
      'header',
      { class: 'ht-header' },
      h(
        'div',
        { class: 'ht-header-top' },
        this.titleEl,
        h(
          'div',
          { class: 'ht-header-actions' },
          this.starBtn,
          this.pinBtn,
          (this.settingsBtn = this._btn('settings', 'Settings', () => this.toggleSettings())),
          this._btn('close', 'Hide sidebar', () => this._close())
        )
      ),
      this.refEl
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
    this.footer = h('footer', { class: 'ht-footer' });
    this.toastEl = h('div', { class: 'ht-toast', role: 'status' });

    this.panel = h(
      'aside',
      {
        class: 'ht-panel',
        'aria-label': 'HectaTree',
        onMouseenter: () => this._peekEnter(true),
        onMouseleave: () => this._peekLeave(),
      },
      h('div', { class: 'ht-top' }, header, this.tabsEl),
      this.searchBar,
      this.body,
      this.footer,
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
    this._shiftFixedBars();
    this._syncTop();
  }

  // Keep our top block (header + tabs) in step with the page's top bar so
  // the dividers sit on the same pixel row and the colors match:
  // - GitHub's header on screen: same height and color, repo header shown.
  // - Scrolled past it: repo header hides, and the tabs take the height and
  //   color of GitHub's sticky bar (e.g. the PR title bar), or plain page
  //   color when there is none.
  _syncTop() {
    if (!this.visible) return;
    const auto = this.s.theme === 'auto';
    const header = this._findHeader();
    const rect = header?.getBoundingClientRect();
    const headerOnScreen = rect ? rect.bottom > 1 : scrollY < 2;
    let height = null;
    let bg = null;

    if (headerOnScreen) {
      if (rect && rect.height >= 30 && rect.height <= 200) height = rect.height;
      if (auto && rect && rect.top > -2 && rect.top < 4) {
        const color = this._paintedColorAt(this._pageX(), rect.top + 3);
        if (color) this._headerBg = color;
      }
      bg = auto ? this._headerBg : null;
    } else {
      const bar = this._findStickyBar();
      if (bar) {
        const r = bar.getBoundingClientRect();
        height = r.bottom;
        bg = auto ? this._paintedColorAt(this._pageX(), r.top + Math.min(4, r.height / 2)) : null;
      } else {
        bg = 'var(--bg)';
      }
    }

    this.root.classList.toggle('scrolled', !headerOnScreen);
    if (height) this.root.style.setProperty('--ht-top-h', `${Math.round(height)}px`);
    else this.root.style.removeProperty('--ht-top-h');
    if (bg) this.root.style.setProperty('--bg-header', bg);
    else this.root.style.removeProperty('--bg-header');
  }

  // A fixed/sticky bar pinned to the top of the page (shown once GitHub's
  // header has scrolled away).
  _findStickyBar() {
    let best = null;
    let bestHeight = 0;
    for (const el of document.elementsFromPoint(this._pageX(), 3)) {
      if (el === this.host || el === document.body || el === document.documentElement) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 2 && r.height >= 24 && r.height <= 160 && r.width > innerWidth / 3 && r.height > bestHeight) {
        best = el;
        bestHeight = r.height;
      }
    }
    return best;
  }

  // Docking pushes the page with a margin, but position:fixed bars (e.g. the
  // sticky PR title) are laid out against the viewport and slide under the
  // sidebar. Find fixed elements crossing the sidebar edge and move them.
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
        const r = el.getBoundingClientRect();
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

  _watchFixedBars() {
    let queued = false;
    const run = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this._shiftFixedBars();
        this._syncTop();
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
      if (this.settingsOpen || (this.shadow.activeElement === this.search && this.search.value)) return;
      this.peeking = false;
      this._applyLayout();
    }, 350);
  }

  _escape() {
    if (this.search.value) {
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
    const tree = this._activeTree();
    if (!tree) return;
    if (tree.hasExpanded) tree.collapseAll();
    else tree.expandAll();
  }

  _updateExpandBtn() {
    const tree = this._activeTree();
    const collapse = Boolean(tree?.hasExpanded);
    const label = collapse ? 'Collapse all folders' : 'Expand all folders';
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
        if (key === 'compactFolders' || key === 'fileIcons') rerender = true;
      }
      this._applyTheme();
      this._applyLayout();
      if (rerender) {
        this.filesTree.render();
        this.changesTree.render();
      }
    }
    if (area === 'local' && changes.bookmarks) this._loadBookmarks();
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
        if (this.tab === 'changes') this.tab = 'files';
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
        this._renderFooter();
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
        this._renderFooter();
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
    const ctx = this.ctx;
    if (!ctx) return;
    const isPrivate = this.repo?.private;
    this.titleEl.replaceChildren(
      HT.icon(isPrivate ? 'lock' : 'repo'),
      h('span', { class: 'ht-owner' }, ctx.owner),
      h('span', { class: 'ht-slash' }, '/'),
      h('strong', null, ctx.repo)
    );
    this.titleEl.href = this._base();
    this.titleEl.title = `${ctx.owner}/${ctx.repo}`;

    if (ctx.kind === 'pull') {
      const info = this.pr?.info;
      this.refEl.replaceChildren(
        HT.icon('pull'),
        h('span', { class: 'ht-ref-text', title: info?.title || '' }, `#${ctx.pullNumber} ${info?.title || ''}`)
      );
    } else {
      this.refEl.replaceChildren(HT.icon('branch'), h('span', { class: 'ht-ref-text' }, this.refLabel || this.repo?.default_branch || '…'));
    }
    this._updateStar();
  }

  _renderTabs() {
    const tabs = [['files', 'files', 'Files']];
    if (this.ctx?.kind === 'pull') {
      const n = this.pr?.info?.changed_files;
      tabs.unshift(['changes', 'diff', n != null ? `Changes ${HT.formatCount(n)}` : 'Changes']);
    }
    tabs.push(['bookmarks', 'bookmark', this.bookmarks.length ? `Bookmarks ${this.bookmarks.length}` : 'Bookmarks']);
    this.tabsEl.replaceChildren(
      ...tabs.map(([id, icon, label]) =>
        h(
          'button',
          {
            class: `ht-tab${this.tab === id ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            title: label,
            'aria-label': label,
            'aria-selected': String(this.tab === id),
            onClick: () => this.setTab(id),
          },
          HT.icon(icon)
        )
      ),
      h(
        'button',
        {
          class: 'ht-tab ht-tab-add',
          type: 'button',
          title: 'Add tab',
          'aria-label': 'Add tab',
          'aria-haspopup': 'menu',
          onClick: (e) => {
            e.stopPropagation();
            this._toggleTabMenu();
          },
        },
        HT.icon('plus')
      )
    );
  }

  // The + menu lists extra tabs from HT.EXTRA_TABS ({ id, icon, label }).
  // None exist yet; future features register there.
  _toggleTabMenu(open = !this.tabMenu?.isConnected) {
    this.tabMenu?.remove();
    if (!open) return;
    const extra = HT.EXTRA_TABS || [];
    this.tabMenu = h(
      'div',
      { class: 'ht-menu', role: 'menu', onClick: (e) => e.stopPropagation() },
      h('div', { class: 'ht-menu-title' }, 'Add tab'),
      extra.length
        ? extra.map((t) => h('button', { class: 'ht-menu-item', type: 'button', role: 'menuitem' }, HT.icon(t.icon), t.label))
        : h('div', { class: 'ht-menu-empty' }, 'More tabs are coming soon.')
    );
    const btn = this.tabsEl.querySelector('.ht-tab-add');
    const panelRect = this.panel.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    this.tabMenu.style.top = `${r.bottom - panelRect.top + 4}px`;
    this.tabMenu.style.left = `${Math.max(8, Math.min(r.left - panelRect.left, panelRect.width - 208))}px`;
    this.panel.append(this.tabMenu);
    if (!this._menuCloser) {
      this._menuCloser = () => this._toggleTabMenu(false);
      this.shadow.addEventListener('click', this._menuCloser);
      document.addEventListener('click', this._menuCloser);
      document.addEventListener('keydown', (e) => e.key === 'Escape' && this._toggleTabMenu(false));
    }
  }

  setTab(tab) {
    this.tab = tab;
    this._renderTabs();
    this.renderBody();
    this._renderFooter();
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
    this.search.placeholder = this.tab === 'bookmarks' ? 'Filter bookmarks…' : 'Go to file…';
    if (this.tab === 'bookmarks') {
      this._renderBookmarks();
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
    if (this.tab === 'bookmarks') this.renderBody();
    else this._activeTree()?.setFilter(this.search.value);
  }

  _onSearchKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.tab === 'bookmarks') this.body.querySelector('.ht-row')?.focus();
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

  _renderFooter() {
    const parts = [];
    const state = this.tab === 'changes' ? this.pr : this.code;
    if (state?.count != null) parts.push(h('span', null, `${state.count.toLocaleString()} ${this.tab === 'changes' ? 'changed' : 'files'}`));
    const spacer = h('span', { class: 'ht-spacer' });
    parts.push(spacer);
    if (this.rate) {
      const { remaining, limit } = this.rate;
      const low = remaining < Math.max(10, limit * 0.1);
      parts.push(h('span', { class: `ht-rate${low ? ' low' : ''}`, title: 'GitHub API requests left this hour' }, `API ${remaining.toLocaleString()}/${limit.toLocaleString()}`));
      if (limit <= 60) {
        parts.push(h('button', { class: 'ht-link', type: 'button', onClick: () => this._openOptions() }, 'Sign in'));
      }
    }
    this.footer.replaceChildren(...parts);
  }

  _renderError(err) {
    let title = 'Something went wrong';
    let text = err.message;
    let settings = false;
    if (err.status === -1) {
      title = 'Reload needed';
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
    const send = (msg) => chrome.runtime.sendMessage(msg);
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
        toggle('fileIcons', 'Color file icons by type'),
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

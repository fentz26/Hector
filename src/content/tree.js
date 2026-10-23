// Tree model + renderer. Only expanded folders are rendered, so huge repos
// stay fast. Filtering switches to a flat, fuzzy-ranked list of files.

HT.makeNode = function makeNode(name, path, type, extra) {
  const node = { name, path, type, loaded: type !== 'tree', children: type === 'tree' ? [] : null, ...extra };
  return node;
};

// GitHub's order: folders first, then by code point (so "Makefile" comes
// before "head.S").
const naturalCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

HT.sortTree = function sortTree(node) {
  if (!node.children) return;
  node.children.sort((a, b) => {
    const da = a.type === 'blob' ? 1 : 0;
    const db = b.type === 'blob' ? 1 : 0;
    return da - db || naturalCompare(a.name, b.name);
  });
  for (const child of node.children) sortTree(child);
};

// entries: [{ path, type: 'blob'|'tree'|'commit', sha, ...extra }]
// `complete` marks folders as fully loaded (recursive listing / PR files).
HT.buildTree = function buildTree(entries, { complete = true } = {}) {
  const root = HT.makeNode('', '', 'tree');
  root.loaded = true;
  const dirs = new Map([['', root]]);

  const ensureDir = (path) => {
    if (dirs.has(path)) return dirs.get(path);
    const slash = path.lastIndexOf('/');
    const parent = ensureDir(slash === -1 ? '' : path.slice(0, slash));
    const dir = HT.makeNode(path.slice(slash + 1), path, 'tree');
    dir.loaded = complete;
    parent.children.push(dir);
    dirs.set(path, dir);
    return dir;
  };

  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const parent = ensureDir(slash === -1 ? '' : entry.path.slice(0, slash));
    if (entry.type === 'tree') {
      const dir = ensureDir(entry.path);
      dir.sha = entry.sha;
      continue;
    }
    parent.children.push(HT.makeNode(entry.path.slice(slash + 1), entry.path, entry.type, entry));
  }
  HT.sortTree(root);
  return root;
};

HT.findNode = function findNode(root, path) {
  if (!path) return root;
  let node = root;
  let acc = '';
  for (const part of path.split('/')) {
    acc = acc ? `${acc}/${part}` : part;
    node = node.children?.find((c) => c.path === acc);
    if (!node) return null;
  }
  return node;
};

// Fuzzy subsequence match. Rewards matches at word starts, consecutive runs,
// and matches inside the file name rather than its directories.
HT.fuzzy = function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const nameStart = t.lastIndexOf('/') + 1;
  // Fast path: contiguous substring, preferring the file name.
  const sub = t.indexOf(q, nameStart) > -1 ? t.indexOf(q, nameStart) : t.indexOf(q);
  if (sub > -1) {
    const indices = Array.from({ length: q.length }, (_, i) => sub + i);
    const inName = sub >= nameStart;
    const nameLen = t.length - nameStart;
    return { score: 1000 + (inName ? 500 : 0) + (sub === nameStart ? 200 : 0) - nameLen - nameStart * 0.05, indices };
  }
  let ti = 0;
  let score = 0;
  let prev = -2;
  const indices = [];
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    const boundary = found === 0 || '/-_. '.includes(t[found - 1]);
    score += 10 + (found === prev + 1 ? 15 : 0) + (boundary ? 12 : 0) + (found >= nameStart ? 8 : 0);
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.1, indices };
};

HT.Tree = class Tree {
  // opts: { linkFor(node), onOpen(node, event) -> handled, onAction(action, node, el),
  //         loadChildren(node) -> Promise, renderMeta(node), actionsFor(node) -> [{act, icon, title, on}],
  //         compact() -> bool, colored() -> bool, onEscape() }
  constructor(opts) {
    this.opts = opts;
    this.root = null;
    this.expanded = new Set();
    this.selectedPath = null;
    this.filterText = '';
    this.el = HT.h('div', { class: 'ht-tree', role: 'tree' });
    // Like GitHub, no tooltip unless the name is cut off.
    this.el.addEventListener('mouseover', (e) => {
      const name = e.target.closest?.('.ht-name');
      if (!name) return;
      const row = name.closest('.ht-row');
      if (name.scrollWidth > name.clientWidth) row.title = row._node?.path || name.textContent;
      else row.removeAttribute('title');
    });
    this.el.addEventListener('click', (e) => this._onClick(e));
    this.el.addEventListener('keydown', (e) => this._onKey(e));
  }

  setRoot(root) {
    if (root === this.root) return;
    this.root = root;
    this.expanded.clear();
    this._files = null;
    this.render();
  }

  setFilter(text) {
    this.filterText = text.trim();
    this.render();
  }

  // Every loaded file, for filtering.
  files() {
    if (!this._files) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) c.type === 'tree' ? walk(c) : out.push(c);
      };
      if (this.root) walk(this.root);
      this._files = out;
    }
    return this._files;
  }

  invalidateFiles() {
    this._files = null;
  }

  render() {
    const scrollTop = this.el.parentElement?.scrollTop;
    this.el.replaceChildren();
    if (!this.root) return;
    if (this.filterText) {
      this._renderFilter();
      return;
    }
    if (!this.root.children.length) {
      this.el.append(HT.h('div', { class: 'ht-empty' }, 'No files'));
      return;
    }
    const ul = HT.h('ul', { class: 'ht-list', role: 'group' });
    for (const child of this.root.children) ul.append(this._renderNode(child, 0));
    this.el.append(ul);
    this._markSelected(false);
    if (scrollTop != null) this.el.parentElement.scrollTop = scrollTop;
  }

  // Collapse chains of single-child folders into one row ("src/main/java").
  _compact(node) {
    let label = node.name;
    let n = node;
    if (this.opts.compact?.()) {
      while (n.type === 'tree' && n.loaded && n.children.length === 1 && n.children[0].type === 'tree') {
        n = n.children[0];
        label += `/${n.name}`;
      }
    }
    return { label, node: n };
  }

  _row(node, label, depth, { dir = '', indices = null } = {}) {
    const isDir = node.type === 'tree';
    const open = isDir && this.expanded.has(node.path);
    const actions = this.opts.actionsFor?.(node) || [];
    const row = HT.h(
      'a',
      {
        class: 'ht-row',
        href: this.opts.linkFor(node) || null,
        role: 'treeitem',
        tabindex: '-1',
        style: `--depth:${depth}`,
        'aria-expanded': isDir ? String(open) : null,
      },
      HT.h('span', { class: 'ht-chevron' }, isDir ? HT.icon('chevron') : null),
      HT.h('span', { class: 'ht-icon' }, this._icon(node, open)),
      HT.h('span', { class: 'ht-name' }, indices ? highlight(label, indices) : label, dir ? HT.h('span', { class: 'ht-dir' }, dir) : null),
      this.opts.renderMeta?.(node) || null,
      actions.length
        ? HT.h(
            'span',
            { class: 'ht-row-actions' },
            actions.map((a) =>
              HT.h('span', { class: `ht-act${a.on ? ' on' : ''}`, role: 'button', title: a.title, dataset: { act: a.act } }, HT.icon(a.icon))
            )
          )
        : null
    );
    row._node = node;
    row._depth = depth;
    return row;
  }

  _renderNode(orig, depth) {
    const { label, node } = this._compact(orig);
    const row = this._row(node, label, depth);
    const li = HT.h('li', { role: 'none' }, row);
    if (node.type === 'tree' && this.expanded.has(node.path)) li.append(this._renderChildren(node, depth + 1));
    return li;
  }

  _renderChildren(node, depth) {
    const ul = HT.h('ul', { class: 'ht-list', role: 'group' });
    if (!node.loaded) {
      ul.append(HT.h('li', { class: 'ht-loading-row', style: `--depth:${depth}` }, HT.h('span', { class: 'ht-spinner' }), 'Loading…'));
      return ul;
    }
    for (const child of node.children) ul.append(this._renderNode(child, depth));
    if (!node.children.length) ul.append(HT.h('li', { class: 'ht-loading-row', style: `--depth:${depth}` }, 'Empty folder'));
    return ul;
  }

  _renderFilter() {
    const results = [];
    for (const file of this.files()) {
      const m = HT.fuzzy(this.filterText, file.path);
      if (m) results.push({ file, ...m });
    }
    results.sort((a, b) => b.score - a.score);
    if (!results.length) {
      this.el.append(HT.h('div', { class: 'ht-empty' }, `No files match “${this.filterText}”`));
      return;
    }
    const ul = HT.h('ul', { class: 'ht-list ht-results', role: 'group' });
    for (const { file, indices } of results.slice(0, 300)) {
      const nameStart = file.path.lastIndexOf('/') + 1;
      const nameIdx = indices.filter((i) => i >= nameStart).map((i) => i - nameStart);
      const dir = nameStart ? file.path.slice(0, nameStart - 1) : '';
      ul.append(HT.h('li', { role: 'none' }, this._row(file, file.name, 0, { dir, indices: nameIdx })));
    }
    this.el.append(ul);
    if (results.length > 300) this.el.append(HT.h('div', { class: 'ht-empty' }, `Showing 300 of ${results.length} matches`));
    this._markSelected(false);
  }

  async _ensureLoaded(node) {
    if (node.loaded) return;
    if (!node._loading) node._loading = this.opts.loadChildren(node).finally(() => (node._loading = null));
    await node._loading;
    this._files = null;
  }

  async toggle(row) {
    const node = row._node;
    if (node.type !== 'tree') return;
    const li = row.parentElement;
    if (this.expanded.has(node.path)) {
      this.expanded.delete(node.path);
      li.querySelector(':scope > ul')?.remove();
    } else {
      this.expanded.add(node.path);
      li.append(this._renderChildren(node, row._depth + 1));
      if (!node.loaded) {
        try {
          await this._ensureLoaded(node);
        } catch (err) {
          this.expanded.delete(node.path);
          this.opts.onError?.(err);
        }
        if (!row.isConnected) return;
        li.querySelector(':scope > ul')?.remove();
        if (this.expanded.has(node.path)) li.append(this._renderChildren(node, row._depth + 1));
      }
    }
    const open = this.expanded.has(node.path);
    row.setAttribute('aria-expanded', String(open));
    row.querySelector('.ht-icon').replaceChildren(this._icon(node, open));
    this.opts.onExpandChange?.();
  }

  _icon(node, open) {
    return HT.nodeIcon(node, open, this.opts.iconPack?.(), this.opts.colored?.() ?? true);
  }

  collapseAll() {
    this.expanded.clear();
    this.render();
    this.opts.onExpandChange?.();
  }

  // Expands every folder that is already loaded (lazy folders stay closed so
  // a huge repo doesn't fire hundreds of API requests).
  expandAll() {
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.type === 'tree' && c.loaded) {
          this.expanded.add(c.path);
          walk(c);
        }
      }
    };
    if (this.root) walk(this.root);
    this.render();
    this.opts.onExpandChange?.();
  }

  get hasExpanded() {
    return this.expanded.size > 0;
  }

  // Expand every folder leading to `path` (loading lazily if needed) and select it.
  async reveal(path) {
    this.selectedPath = path || null;
    if (!this.root) return;
    if (path) {
      const parts = path.split('/');
      let node = this.root;
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        await this._ensureLoaded(node);
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        const next = node.children.find((c) => c.path === acc);
        if (!next) break;
        if (next.type === 'tree' && i < parts.length - 1) this.expanded.add(next.path);
        node = next;
      }
    }
    if (this.filterText) this._markSelected(true);
    else this.render();
    this._markSelected(true);
    this.opts.onExpandChange?.();
  }

  _markSelected(scroll) {
    this.el.querySelectorAll('.ht-row.selected').forEach((r) => r.classList.remove('selected'));
    if (!this.selectedPath) return;
    const row = [...this.el.querySelectorAll('.ht-row')].find((r) => r._node.path === this.selectedPath);
    if (!row) return;
    row.classList.add('selected');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  focusFirst() {
    this.el.querySelector('.ht-row.selected, .ht-row')?.focus();
  }

  _onClick(e) {
    const row = e.target.closest('.ht-row');
    if (!row) return;
    const node = row._node;
    const act = e.target.closest('[data-act]');
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      this.opts.onAction?.(act.dataset.act, node, act);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (node.type === 'tree') {
      e.preventDefault();
      this.toggle(row);
      return;
    }
    if (!row.getAttribute('href')) e.preventDefault();
    if (this.opts.onOpen?.(node, e)) e.preventDefault();
    this.selectedPath = node.path;
    this._markSelected(false);
  }

  _onKey(e) {
    const row = e.target.closest?.('.ht-row');
    if (!row) return;
    const rows = [...this.el.querySelectorAll('.ht-row')];
    const i = rows.indexOf(row);
    const node = row._node;
    const open = this.expanded.has(node.path);
    switch (e.key) {
      case 'ArrowDown':
        rows[i + 1]?.focus();
        break;
      case 'ArrowUp':
        if (i === 0) this.opts.onTop?.();
        else rows[i - 1]?.focus();
        break;
      case 'ArrowRight':
        if (node.type === 'tree' && !open) this.toggle(row);
        else rows[i + 1]?.focus();
        break;
      case 'ArrowLeft':
        if (node.type === 'tree' && open) this.toggle(row);
        else row.parentElement.parentElement.closest('li')?.querySelector(':scope > .ht-row')?.focus();
        break;
      case 'Home':
        rows[0]?.focus();
        break;
      case 'End':
        rows[rows.length - 1]?.focus();
        break;
      case 'Enter':
      case ' ':
        if (e.key === ' ' && node.type !== 'tree') return;
        // Synthetic clicks on anchors navigate, so files open like a real click.
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: e.metaKey, ctrlKey: e.ctrlKey }));
        break;
      case 'Escape':
        this.opts.onEscape?.();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
};

function highlight(text, indices) {
  if (!indices?.length) return text;
  const set = new Set(indices);
  const out = [];
  let buf = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const marked = set.has(i);
    if (marked !== inMark) {
      if (buf) out.push(inMark ? HT.h('mark', null, buf) : buf);
      buf = '';
      inMark = marked;
    }
    buf += text[i];
  }
  if (buf) out.push(inMark ? HT.h('mark', null, buf) : buf);
  return out;
}

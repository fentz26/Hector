// Shared namespace and tiny DOM helpers. Content scripts share one isolated
// world, so every file hangs off globalThis.HT.
var HT = globalThis.HT || (globalThis.HT = {});

// h('div', { class: 'x', onClick: fn }, child, 'text', [more])
HT.h = function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  HT.append(el, children);
  return el;
};

HT.append = function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
};

HT.encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

HT.decodeSegment = (part) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

// Only http(s) links from API data become hrefs.
HT.safeUrl = function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
};

HT.avatarUrl = function avatarUrl(url, size) {
  const safe = HT.safeUrl(url);
  if (!safe) return null;
  const u = new URL(safe);
  u.searchParams.set('s', String(size));
  return u.href;
};

// Imported bookmarks: keep known fields with the right types, https links only.
HT.cleanBookmarks = function cleanBookmarks(list) {
  const str = (v) => (typeof v === 'string' ? v : undefined);
  return list
    .filter((b) => b && typeof b.title === 'string' && HT.safeUrl(b.url)?.startsWith('https:'))
    .map((b) => ({
      url: b.url,
      title: b.title,
      kind: ['repo', 'pull', 'dir', 'file'].includes(b.kind) ? b.kind : 'file',
      repo: str(b.repo) || '',
      ref: str(b.ref),
      host: str(b.host) || new URL(b.url).host,
      added: Number(b.added) || Date.now(),
    }));
};

HT.debounce = function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

HT.copyText = async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
};

const digestHex = async (algo, text) => {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
HT.sha256Hex = (text) => digestHex('SHA-256', text);
HT.sha1Hex = (text) => digestHex('SHA-1', text);

// Split a line with ANSI SGR escapes into styled segments:
// [{ text, fg, bg, bold, dim, italic, underline }]. fg/bg are a palette
// index (0-15) or an 'rgb(...)' string. State resets each line, like
// GitHub's log viewer.
HT.ansi = function ansi(line) {
  const out = [];
  let st = {};
  let last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  const push = (text) => text && out.push({ text, ...st });
  const cube = (n) => {
    if (n < 16) return n;
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v}, ${v}, ${v})`;
    }
    const i = n - 16;
    const c = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(i / 36))}, ${c(Math.floor(i / 6) % 6)}, ${c(i % 6)})`;
  };
  for (let m; (m = re.exec(line)); ) {
    push(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    st = { ...st };
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {};
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c === 39) delete st.fg;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if (c === 49) delete st.bg;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        st[c === 38 ? 'fg' : 'bg'] = cube(codes[i + 2] ?? 0);
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        st[c === 38 ? 'fg' : 'bg'] = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
  push(line.slice(last));
  // Drop any other escape sequences (cursor moves etc.).
  for (const seg of out) seg.text = seg.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return out;
};

HT.stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// "3m ago", "2h ago", "5d ago"; falls back to a date after a month.
HT.timeAgo = function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
};

// "45s", "3m 12s", "1h 4m"
HT.duration = function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

HT.formatCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

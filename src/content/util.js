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

HT.sha256Hex = async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

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

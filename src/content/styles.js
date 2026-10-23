// Sidebar styles, injected into the sidebar's shadow root so GitHub's CSS
// and ours never collide.
HT.CSS = String.raw`
:host { all: initial; }
.ht-root[hidden] { display: none; }
.ht-root {
  --ht-width: 300px;
  --ht-font: 13px;
  font: var(--ht-font)/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
.ht-root[data-theme="light"] {
  --bg: #ffffff; --bg-2: #f6f8fa; --bg-hover: #eff2f5; --bg-sel: #dcf3ea; --bg-input: #ffffff;
  --fg: #1f2328; --fg-2: #5b636d; --fg-3: #8a929b; --border: #d6dde4;
  --accent: #0f8a62; --accent-2: #0b6e4e; --primary: #0f8a62; --primary-fg: #ffffff; --star: #d29a00;
  --add: #1a7f37; --del: #cf222e; --mod: #9a6700; --ren: #0969da;
  --mark: #fff1b8; --shadow: 0 10px 30px rgba(31, 35, 40, 0.18);
}
.ht-root[data-theme="dark"] {
  --bg: #0f141a; --bg-2: #161c24; --bg-hover: #1d2530; --bg-sel: #123a2e; --bg-input: #0b1015;
  --fg: #e3e9ef; --fg-2: #9aa4ae; --fg-3: #6b747e; --border: #2a323c;
  --accent: #34c48f; --accent-2: #56d6a5; --primary: #238a63; --primary-fg: #ffffff; --star: #e3b341;
  --add: #3fb950; --del: #f85149; --mod: #d29922; --ren: #58a6ff;
  --mark: #5a4a12; --shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; }
.ht-svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round; flex: none; }

/* ---- edge toggle ---- */
.ht-toggle {
  position: fixed; top: calc(var(--ht-page-top, 0px) + 8px); z-index: 2;
  width: 26px; height: 40px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); background: var(--bg); color: var(--accent);
  box-shadow: var(--shadow); cursor: pointer;
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.ht-root[data-dock="left"] .ht-toggle { left: 0; border-left: 0; border-radius: 0 8px 8px 0; }
.ht-root[data-dock="right"] .ht-toggle { right: 0; border-right: 0; border-radius: 8px 0 0 8px; }
.ht-toggle:hover { color: var(--accent-2); }
.ht-toggle .ht-svg { width: 18px; height: 18px; }
.ht-root.docked .ht-toggle { opacity: 0; pointer-events: none; }
.ht-root.peek .ht-toggle { opacity: 0; }

/* ---- panel ---- */
.ht-panel {
  position: fixed; top: var(--ht-page-top, 0px); bottom: 0; z-index: 1;
  width: var(--ht-width);
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.ht-root[data-dock="left"] .ht-panel { left: 0; border-right: 1px solid var(--border); transform: translateX(calc(-100% - 2px)); }
.ht-root[data-dock="right"] .ht-panel { right: 0; border-left: 1px solid var(--border); transform: translateX(calc(100% + 2px)); }
.ht-root.docked .ht-panel, .ht-root.peek .ht-panel { transform: none; }
.ht-root.peek:not(.docked) .ht-panel { box-shadow: var(--shadow); }
.ht-root.resizing .ht-panel { transition: none; user-select: none; }

.ht-resizer { position: absolute; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 3; }
.ht-root[data-dock="left"] .ht-resizer { right: -3px; }
.ht-root[data-dock="right"] .ht-resizer { left: -3px; }
.ht-resizer:hover, .ht-root.resizing .ht-resizer { background: linear-gradient(90deg, transparent 2px, var(--accent) 2px, var(--accent) 4px, transparent 4px); }

/* ---- top: tab row, lined up with GitHub's repository nav ---- */
.ht-panel { container-type: inline-size; }
.ht-top {
  position: relative; flex: none; height: var(--ht-top-height, 48px); min-height: 36px;
  display: flex; align-items: stretch;
  background: var(--bg-header, var(--bg)); border-bottom: 1px solid var(--border);
}
/* Cover the panel's side border so the row runs into GitHub's seamlessly. */
.ht-root.joined-header[data-dock="left"] .ht-top { margin-right: -1px; }
.ht-root.joined-header[data-dock="right"] .ht-top { margin-left: -1px; }

/* Same geometry as GitHub's UnderlineNav: 16px icons centered in the row,
   a 32px hover pill, and a 2px rounded underline over the bottom border. */
.ht-tabs { display: flex; align-items: stretch; gap: 8px; padding: 0 8px 0 16px; min-width: 0; margin-bottom: -1px; }
.ht-tab {
  position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
  padding: 0; border: 0; background: transparent; color: var(--fg-2); cursor: pointer;
}
.ht-tab-inner {
  display: inline-flex; align-items: center; gap: 8px;
  height: min(32px, calc(100% - 8px)); padding: 0 8px; border-radius: 6px;
}
.ht-tab .ht-svg { width: 16px; height: 16px; }
.ht-tab:hover .ht-tab-inner { background: var(--bg-hover); }
.ht-tab.active { color: var(--fg); }
.ht-tab.active::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: 6px;
  background: var(--tab-active, #fd8c73);
}
.ht-tab:focus-visible { outline: none; }
.ht-tab:focus-visible .ht-tab-inner { box-shadow: inset 0 0 0 2px var(--accent); }
/* + appears only while the tab row is hovered, focused, or its menu is open. */
.ht-tab-add { color: var(--fg-2); opacity: 0; transition: opacity 0.12s ease; }
.ht-tabs:hover .ht-tab-add, .ht-tabs:focus-within .ht-tab-add, .ht-tab-add[aria-expanded="true"] { opacity: 1; }
@media (hover: none) { .ht-tab-add { opacity: 1; } }
.ht-tab-add[aria-expanded="true"] .ht-tab-inner { background: var(--bg-hover); color: var(--fg); }
.ht-tab-label { display: none; font-size: 14px; }
.ht-root.tab-labels .ht-tab-label { display: inline; white-space: nowrap; }
.ht-root.tab-labels .ht-tabs { overflow-x: auto; scrollbar-width: none; }
.ht-tab.dragging { opacity: 0.4; }
.ht-tab.dragging::after { display: none; }
.ht-tab.drop-before { box-shadow: inset 2px 0 0 var(--accent); }
.ht-tab.drop-after { box-shadow: inset -2px 0 0 var(--accent); }

/* ---- menu (Primer ActionMenu) ---- */
.ht-menu {
  position: absolute; z-index: 5; width: 220px; padding: 8px 0;
  border-radius: 12px; background: var(--bg-overlay, var(--bg)); color: var(--fg);
  box-shadow: var(--shadow-overlay, 0 0 0 1px var(--border), 0 6px 12px -3px rgba(0, 0, 0, 0.25), 0 6px 18px 0 rgba(0, 0, 0, 0.18));
  font-size: 14px; line-height: 20px;
  animation: ht-overlay-appear 200ms cubic-bezier(0.33, 1, 0.68, 1);
}
@keyframes ht-overlay-appear { from { opacity: 0; } to { opacity: 1; } }
.ht-menu-title { padding: 6px 16px; color: var(--fg-2); font-size: 12px; font-weight: 600; line-height: 18px; }
.ht-menu-item {
  display: flex; align-items: center; gap: 8px; width: calc(100% - 16px); min-height: 32px; margin: 0 8px; padding: 6px 8px;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; text-align: left; font: inherit;
}
.ht-menu-item:hover { background: var(--bg-hover); }
.ht-menu-item:focus { outline: none; }
.ht-menu-item:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.ht-menu-item > .ht-svg { color: var(--fg-2); }
.ht-menu-check { display: inline-flex; width: 16px; flex: none; visibility: hidden; }
.ht-menu-item[aria-checked="true"] .ht-menu-check { visibility: visible; }
.ht-menu-label { flex: none; }
.ht-menu-desc { flex: 1; min-width: 0; text-align: right; color: var(--fg-2); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ht-menu-divider { height: 1px; margin: 8px 0; background: var(--border-muted, var(--border)); }
.ht-menu-note { padding: 0 16px; color: var(--fg-2); font-size: 12px; line-height: 18px; }

/* ---- footer status bar ---- */
.ht-footer {
  flex: none; display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 4px 0 12px;
  border-top: 1px solid var(--border); background: var(--bg);
}
.ht-footer-actions { display: flex; gap: 2px; flex: none; margin-left: auto; }
.ht-btn {
  width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--fg-2); cursor: pointer;
}
.ht-btn:hover { background: var(--bg-hover); color: var(--fg); }
.ht-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ht-btn.on { color: var(--accent); }
.ht-btn.on .ht-svg path { fill: currentColor; }
.ht-stats { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; color: var(--fg-2); font-size: 12px; white-space: nowrap; overflow: hidden; }
.ht-stats .ht-link { font-size: inherit; }
.ht-stat-ref { display: inline-flex; align-items: center; gap: 4px; min-width: 0; flex-shrink: 1; overflow: hidden; }
.ht-stat-ref .ht-svg { width: 14px; height: 14px; }
.ht-stat-ref-text { overflow: hidden; text-overflow: ellipsis; }
.ht-dot { opacity: 0.7; }
.ht-account-chip {
  display: inline-flex; align-items: center; gap: 5px; flex: 0 1 auto; min-width: 0; max-width: 45%; height: 24px; padding: 0 6px;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg-2); cursor: pointer; font-size: 12px; white-space: nowrap;
}
.ht-account-chip:hover { background: var(--bg-hover); color: var(--fg); }
.ht-account-chip.ht-link { color: var(--accent); }
.ht-account-chip.low, .ht-account-chip.low .ht-account-login { color: var(--del); }
.ht-account-avatar { width: 16px; height: 16px; border-radius: 50%; flex: none; }
.ht-account-login { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--fg); font-weight: 600; }
.ht-account-method { flex: none; padding: 0 5px; border: 1px solid var(--border); border-radius: 999px; font-size: 10px; line-height: 14px; color: var(--fg-2); }

/* ---- search ---- */
.ht-search { display: flex; align-items: center; gap: 2px; padding: 8px 8px 6px; position: relative; flex: none; }
.ht-search-icon { position: absolute; left: 17px; display: inline-flex; color: var(--fg-3); pointer-events: none; }
.ht-search-icon .ht-svg { width: 14px; height: 14px; }
.ht-search-input {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px 0 28px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input); color: var(--fg);
  font: inherit; outline: none;
}
.ht-search-input::placeholder { color: var(--fg-3); }
.ht-search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }

/* ---- body / rows ---- */
.ht-body {
  flex: 1; overflow: auto; padding: 2px 0 10px; overscroll-behavior: contain;
  /* Overlay-style scrollbar: no track line, thumb only while scrolling. */
  scrollbar-width: thin; scrollbar-color: transparent transparent;
}
.ht-body.scrolling { scrollbar-color: color-mix(in srgb, var(--fg-2) 45%, transparent) transparent; }
.ht-list { list-style: none; margin: 0; padding: 0; }
.ht-row {
  display: flex; align-items: center; gap: 5px;
  height: 26px; margin: 0 6px; padding: 0 6px 0 calc(4px + var(--depth, 0) * 14px);
  border-radius: 6px; color: var(--fg); text-decoration: none; white-space: nowrap; cursor: pointer; outline: none;
}
.ht-row:hover { background: var(--bg-hover); }
.ht-row:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.ht-row.selected { background: var(--bg-sel); font-weight: 600; }
.ht-chevron { width: 14px; display: inline-flex; flex: none; color: var(--fg-3); transition: transform 0.12s ease; }
.ht-chevron .ht-svg { width: 12px; height: 12px; margin: 0 auto; }
.ht-row[aria-expanded="true"] .ht-chevron { transform: rotate(90deg); }
.ht-icon { display: inline-flex; flex: none; color: var(--fg-2); }
.ht-ic-folder { color: var(--accent); }
.ht-ic-folder path { fill: color-mix(in srgb, currentColor 18%, transparent); }
.ht-ic-file path:first-child { fill: color-mix(in srgb, currentColor 12%, transparent); }
.ht-ic-mono { color: var(--fg-2); }
.ht-ic-mono path, .ht-ic-mono path:first-child { fill: none; }
.ht-ic-filled path, .ht-ic-mono.ht-ic-filled path { fill: currentColor; stroke: none; }
.ht-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ht-dir { margin-left: 6px; color: var(--fg-3); font-weight: 400; font-size: 0.9em; }
.ht-name mark { background: var(--mark); color: inherit; border-radius: 2px; }
.ht-results .ht-chevron { display: none; }

.ht-row-actions { display: inline-flex; gap: 1px; flex: none; }
.ht-act {
  width: 22px; height: 22px; display: none; align-items: center; justify-content: center;
  border-radius: 5px; color: var(--fg-3);
}
.ht-act .ht-svg { width: 14px; height: 14px; }
.ht-row:hover .ht-act, .ht-row:focus-visible .ht-act, .ht-act.on { display: inline-flex; }
.ht-act:hover { background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--fg); }
.ht-act.on[data-act="star"] { color: var(--accent); }
.ht-act.on[data-act="star"] path { fill: currentColor; }

.ht-meta { display: inline-flex; align-items: center; gap: 5px; flex: none; font: 0.82em/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ht-add { color: var(--add); }
.ht-del { color: var(--del); }
.ht-status {
  min-width: 16px; height: 16px; padding: 0 3px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 700; color: var(--fg-2); border: 1px solid currentColor;
}
.ht-status-added { color: var(--add); }
.ht-status-removed { color: var(--del); }
.ht-status-modified, .ht-status-changed { color: var(--mod); }
.ht-status-renamed, .ht-status-copied { color: var(--ren); }
.ht-row:hover .ht-meta { display: none; }

.ht-group {
  margin: 10px 12px 2px; color: var(--fg-3); font-size: 0.8em; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ht-bookmarks .ht-icon { color: var(--fg-2); margin-left: 4px; }

/* ---- CI/CD ---- */
.ht-ci { color: var(--fg-2); }
.ht-ci-ok { color: var(--add); }
.ht-ci-fail { color: var(--del); }
.ht-ci-running, .ht-ci-queued, .ht-ci-warn { color: var(--mod); }
.ht-ci-running .ht-svg { animation: ht-spin 1s linear infinite; }
.ht-ci-list .ht-row:hover .ht-ci-time { display: inline-flex; }
.ht-ci-time { color: var(--fg-3); }
.ht-group-link { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ht-group-link > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ht-group-link .ht-link { text-transform: none; letter-spacing: 0; font-weight: 400; text-decoration: none; flex: none; }
.ht-ci-list .ht-empty { padding: 6px 16px; font-size: 0.92em; }
.ht-ci-list .ht-row { position: relative; }

/* job detail */
.ht-ci-detail { position: sticky; top: -2px; z-index: 1; background: var(--bg); padding: 4px 0 6px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.ht-ci-back {
  display: flex; align-items: center; gap: 4px; max-width: calc(100% - 12px); margin: 0 6px; padding: 3px 6px;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg-2); cursor: pointer; font-size: 0.9em;
}
.ht-ci-back span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-ci-back:hover { background: var(--bg-hover); color: var(--fg); }
.ht-ci-back:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ht-ci-back-icon { display: inline-flex; transform: rotate(180deg); }
.ht-ci-back-icon .ht-svg { width: 12px; height: 12px; }
.ht-ci-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px 0 16px; }
.ht-ci-head .ht-ci .ht-svg { width: 18px; height: 18px; }
.ht-ci-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ht-ci-head-text strong, .ht-ci-head-text span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-ci-head-text span { color: var(--fg-2); font-size: 0.85em; }
.ht-ci-head .ht-btn { flex: none; }
.ht-live {
  display: inline-flex; align-items: center; gap: 4px; margin-right: 6px; color: var(--mod); font-weight: 600;
}
.ht-live::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor;
  animation: ht-pulse 1.4s ease-in-out infinite;
}
@keyframes ht-pulse { 50% { opacity: 0.25; } }
.ht-log-live { display: inline-block; margin: 0 10px 8px; font-size: 0.9em; text-decoration: none; }
.ht-more { display: flex; justify-content: center; padding: 8px 12px 4px; }
.ht-more .ht-secondary { width: 100%; }
.ht-more .ht-loading-row { padding-left: 0; }

/* step logs, styled like GitHub's log viewer */
.ht-log { margin: 2px 6px 6px; border-radius: 6px; background: var(--bg-2); border: 1px solid var(--border); overflow: hidden; }
.ht-log-note { display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--fg-2); font-size: 0.9em; }
.ht-log > .ht-link { margin: 0 10px 8px; }
.ht-log-lines {
  max-height: 60vh; overflow: auto; padding: 6px 0;
  font: 11.5px/1.55 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  scrollbar-width: thin;
}
.ht-log-line { display: flex; gap: 10px; padding: 0 10px 0 0; white-space: pre; min-width: max-content; }
.ht-log-line:hover { background: var(--bg-hover); }
.ht-log-n { flex: none; width: 34px; text-align: right; color: var(--fg-3); user-select: none; }
.ht-log-text { color: var(--fg); }
.ht-log-group .ht-log-text { font-weight: 600; }
.ht-log-command .ht-log-text { color: var(--ren); }
.ht-log-error { background: color-mix(in srgb, var(--del) 14%, transparent); }
.ht-log-error .ht-log-text { color: var(--del); }
.ht-log-warning { background: color-mix(in srgb, var(--mod) 14%, transparent); }
.ht-log-warning .ht-log-text { color: var(--mod); }
.ht-log-notice .ht-log-text, .ht-log-debug .ht-log-text { color: var(--fg-2); }

/* ---- states ---- */
.ht-loading, .ht-empty { display: flex; align-items: center; gap: 8px; padding: 14px 16px; color: var(--fg-2); }
.ht-loading-row { display: flex; align-items: center; gap: 8px; height: 26px; padding-left: calc(30px + var(--depth, 0) * 14px); color: var(--fg-3); font-size: 0.92em; }
.ht-spinner {
  width: 13px; height: 13px; border-radius: 50%; flex: none;
  border: 2px solid var(--border); border-top-color: var(--accent);
  animation: ht-spin 0.7s linear infinite;
}
@keyframes ht-spin { to { transform: rotate(360deg); } }
.ht-notice {
  margin: 4px 10px 6px; padding: 7px 10px; border-radius: 6px; font-size: 0.88em;
  background: color-mix(in srgb, var(--mod) 12%, transparent); color: var(--fg-2);
}
.ht-notice { display: flex; flex-direction: column; gap: 4px; }
.ht-notice-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.ht-notice-actions .ht-link { font-size: 0.95em; color: var(--fg-2); }
.ht-notice-actions .ht-link:hover { color: var(--fg); }
.ht-notice-actions .ht-btn { width: 22px; height: 22px; }
.ht-notice-actions .ht-btn .ht-svg { width: 13px; height: 13px; }
.ht-message { margin: 14px 12px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.ht-message strong { display: block; margin-bottom: 4px; }
.ht-message p { margin: 0 0 10px; color: var(--fg-2); }
.ht-message-actions { display: flex; gap: 6px; }
.ht-primary, .ht-secondary { height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.92em; }
.ht-primary { border: 1px solid transparent; background: var(--primary); color: var(--primary-fg); }
.ht-primary:hover { filter: brightness(1.1); }
.ht-secondary { border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
.ht-secondary:hover { background: var(--bg-hover); }

/* ---- links ---- */
.ht-link { padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; font-size: inherit; }
.ht-link:hover { text-decoration: underline; }

.ht-toast {
  position: absolute; left: 50%; bottom: 40px; transform: translate(-50%, 8px);
  padding: 6px 12px; border-radius: 6px; background: var(--fg); color: var(--bg);
  font-size: 0.9em; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 0.15s, transform 0.15s;
}
.ht-toast.show { opacity: 1; transform: translate(-50%, 0); }

/* ---- settings ---- */
.ht-root.settings-open .ht-search { display: none; }
.ht-btn.active { background: var(--bg-hover); color: var(--accent); }
.ht-settings { padding: 4px 12px 12px; }
.ht-settings-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 0 4px; }
.ht-settings-head strong { font-size: 1.05em; }
.ht-section { padding: 10px 0 12px; border-bottom: 1px solid var(--border); }
.ht-section:last-of-type { border-bottom: 0; }
.ht-section h3 { margin: 0 0 6px; font-size: 0.82em; font-weight: 600; color: var(--fg-2); text-transform: uppercase; letter-spacing: 0.04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-help { margin: 0 0 8px; color: var(--fg-2); font-size: 0.88em; }
.ht-center { text-align: center; margin-top: 12px; }
.ht-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; font-size: 0.92em; }
.ht-field > span { font-weight: 600; }
.ht-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; }
.ht-inline .ht-input { flex: 1; min-width: 0; }
.ht-input {
  height: 28px; width: 100%; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-input); color: var(--fg); font: inherit; outline: none;
}
.ht-input:focus { border-color: var(--accent); }
.ht-check { display: flex; align-items: center; gap: 8px; margin: 5px 0; cursor: pointer; font-size: 0.92em; }
.ht-check input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); flex: none; }
.ht-danger { color: var(--del); }
.ht-status-line { margin: 2px 0 0; min-height: 1.2em; color: var(--fg-2); font-size: 0.88em; }
.ht-status-line.ok { color: var(--add); }
.ht-status-line.err { color: var(--del); }
.ht-settings .ht-link { font-size: 0.92em; text-decoration: none; }
.ht-account { margin-bottom: 8px; }
.ht-signed-in { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ht-signed-in > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-avatar { width: 24px; height: 24px; border-radius: 50%; flex: none; }
.ht-github-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 32px; }
.ht-code {
  margin: 4px 0 8px; padding: 8px; border: 1px dashed var(--border); border-radius: 6px; background: var(--bg-input);
  text-align: center; font: 600 1.35em/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.12em;
  cursor: copy; user-select: all;
}
.ht-details { margin-top: 4px; }
.ht-details summary { cursor: pointer; color: var(--fg-2); font-size: 0.88em; margin-bottom: 6px; }
.ht-details summary:hover { color: var(--fg); }

@media (prefers-reduced-motion: reduce) {
  .ht-panel, .ht-toggle, .ht-chevron, .ht-toast { transition: none; }
  .ht-menu, .ht-ci-running .ht-svg, .ht-live::before { animation: none; }
}
`;

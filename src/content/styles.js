// Sidebar styles, injected into the sidebar's shadow root so GitHub's CSS
// and ours never collide.
HT.CSS = String.raw`
:host { all: initial; }
.ht-root[hidden] { display: none; }
.ht-root {
  --ht-width: 300px;
  --ht-font: 14px;
  font: var(--ht-font)/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
.ht-root[data-theme="light"] {
  --bg: #ffffff; --bg-2: #f6f8fa; --bg-hover: #eff2f5; --bg-sel: rgba(129, 139, 152, 0.15); --bg-input: #ffffff;
  --fg: #1f2328; --fg-2: #5b636d; --fg-3: #8a929b; --border: #d6dde4;
  --accent: #3f3f46; --accent-2: #18181b; --primary: #18181b; --primary-fg: #ffffff; --star: #d29a00;
  --add: #1a7f37; --del: #cf222e; --mod: #9a6700; --ren: #0969da;
  --mark: #fff1b8; --shadow: 0 10px 30px rgba(31, 35, 40, 0.18);
  --tk-com: #59636e; --tk-kw: #cf222e; --tk-str: #0a3069; --tk-num: #0550ae; --tk-fn: #6639ba; --tk-type: #953800; --tk-tag: #116329; --tk-var: #953800;
  --ansi-0: #24292f; --ansi-1: #cf222e; --ansi-2: #116329; --ansi-3: #4d2d00; --ansi-4: #0969da; --ansi-5: #8250df; --ansi-6: #1b7c83; --ansi-7: #6e7781;
  --ansi-8: #57606a; --ansi-9: #a40e26; --ansi-10: #1a7f37; --ansi-11: #633c01; --ansi-12: #218bff; --ansi-13: #a475f9; --ansi-14: #3192aa; --ansi-15: #8c959f;
}
.ht-root[data-theme="dark"] {
  --bg: #0f141a; --bg-2: #161c24; --bg-hover: #1d2530; --bg-sel: rgba(101, 108, 118, 0.2); --bg-input: #0b1015;
  --fg: #e3e9ef; --fg-2: #9aa4ae; --fg-3: #6b747e; --border: #2a323c;
  --accent: #d4d4d8; --accent-2: #fafafa; --primary: #fafafa; --primary-fg: #18181b; --star: #e3b341;
  --add: #3fb950; --del: #f85149; --mod: #d29922; --ren: #58a6ff;
  --mark: #5a4a12; --shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  --tk-com: #9198a1; --tk-kw: #ff7b72; --tk-str: #a5d6ff; --tk-num: #79c0ff; --tk-fn: #d2a8ff; --tk-type: #ffa657; --tk-tag: #7ee787; --tk-var: #ffa657;
  --ansi-0: #484f58; --ansi-1: #ff7b72; --ansi-2: #3fb950; --ansi-3: #d29922; --ansi-4: #58a6ff; --ansi-5: #bc8cff; --ansi-6: #39c5cf; --ansi-7: #b1bac4;
  --ansi-8: #6e7681; --ansi-9: #ffa198; --ansi-10: #56d364; --ansi-11: #e3b341; --ansi-12: #79c0ff; --ansi-13: #d2a8ff; --ansi-14: #56d4dd; --ansi-15: #f0f6fc;
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; }
.ht-svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round; flex: none; }

/* ---- edge toggle ---- */
.ht-toggle {
  /* Below the page header, or where the user dragged it (kept on screen). */
  position: fixed; z-index: 2;
  top: max(calc(var(--ht-page-top, 0px) + 8px), min(var(--ht-toggle-y, 0px), calc(100vh - 62px)));
  width: 26px; display: flex; flex-direction: column; align-items: center;
  border: 1px solid var(--border); background: var(--bg); color: var(--fg-2);
  box-shadow: var(--shadow);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.ht-root[data-dock="left"] .ht-toggle { left: 0; border-left: 0; border-radius: 0 8px 8px 0; }
.ht-root[data-dock="right"] .ht-toggle { right: 0; border-right: 0; border-radius: 8px 0 0 8px; }
.ht-toggle-open {
  width: 100%; height: 38px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.ht-toggle-open:hover { color: var(--fg); }
.ht-toggle-open .ht-svg { width: 18px; height: 18px; }
/* The grip grows out below the logo on hover, so the logo never moves. */
.ht-toggle-grip {
  width: 100%; height: 0; overflow: hidden; opacity: 0;
  display: flex; align-items: flex-start; justify-content: center;
  color: var(--fg-2); cursor: grab; touch-action: none;
  transition: height 0.12s ease, opacity 0.12s ease;
}
.ht-toggle:hover .ht-toggle-grip, .ht-root.moving-toggle .ht-toggle-grip { height: 20px; opacity: 1; }
.ht-toggle-grip:hover { color: var(--fg); }
.ht-root.moving-toggle .ht-toggle-grip { cursor: grabbing; }
.ht-root.moving-toggle .ht-toggle { transition: none; }
@media (hover: none) { .ht-toggle-grip { height: 20px; opacity: 1; } }
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

/* Hold a tab for split view: the underline fills while holding; the tab
   shown below gets a dashed underline. */
.ht-tab.holding::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: 6px;
  background: var(--fg-2); transform-origin: left; animation: ht-hold 450ms linear forwards;
}
@keyframes ht-hold { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.ht-tab.split { color: var(--fg); }
.ht-tab.split:not(.active)::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: repeating-linear-gradient(to right, var(--tab-active, #fd8c73) 0 4px, transparent 4px 7px);
}

/* ---- split view: the held tab beside the current one ---- */
.ht-stack { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ht-stack[data-split="top"] { flex-direction: column-reverse; }
.ht-stack[data-split="right"] { flex-direction: row; }
.ht-stack[data-split="left"] { flex-direction: row-reverse; }
.ht-main { flex: 1 1 0; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.ht-main > .ht-body { min-height: 0; }
.ht-split { flex: 0 0 var(--ht-split, 45%); min-height: 96px; min-width: 0; display: flex; flex-direction: column; border-top: 1px solid var(--border); }
.ht-split[hidden], .ht-split-gap[hidden] { display: none; }
.ht-root.split .ht-body:not(.ht-split-body) { min-height: 96px; }
.ht-stack[data-split="top"] .ht-split { border-top: 0; border-bottom: 1px solid var(--border); }
.ht-stack[data-split="left"] .ht-split, .ht-stack[data-split="right"] .ht-split { min-height: 0; min-width: 120px; border-top: 0; }
.ht-stack[data-split="right"] .ht-split { border-left: 1px solid var(--border); }
.ht-stack[data-split="left"] .ht-split { border-right: 1px solid var(--border); }
.ht-stack[data-split="left"] > .ht-main, .ht-stack[data-split="right"] > .ht-main { min-width: 120px; }
/* The split pane's own search sits under its title. */
.ht-split-search { padding: 0 8px 6px; }
/* The middle space between the panes: hold it to resize. */
.ht-split-gap { flex: none; height: 8px; cursor: row-resize; position: relative; z-index: 1; }
.ht-stack[data-split="left"] .ht-split-gap, .ht-stack[data-split="right"] .ht-split-gap { height: auto; width: 8px; cursor: col-resize; }
.ht-split-gap::after { content: ""; position: absolute; inset: 3px 12px; border-radius: 2px; background: transparent; }
.ht-stack[data-split="left"] .ht-split-gap::after, .ht-stack[data-split="right"] .ht-split-gap::after { inset: 12px 3px; }
.ht-split-gap:hover::after, .ht-root.resizing .ht-split-gap::after { background: var(--accent); }
.ht-split-head {
  position: relative; flex: none; display: flex; align-items: center; gap: 8px; height: 34px; padding: 4px 4px 0 8px;
  color: var(--fg-2); font-size: 12px; font-weight: 600; user-select: none;
}
/* Six-dot grip: drag it to move the pane. */
.ht-split-grip { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 24px; border-radius: 6px; color: var(--fg-2); cursor: grab; }
.ht-split-grip:hover, .ht-root.moving .ht-split-grip { background: var(--bg-hover); color: var(--fg); }
/* The grip shows when the cursor is over the pane (always on touch screens). */
.ht-split-grip { opacity: 0; transition: opacity 0.12s ease; }
.ht-split:hover .ht-split-grip, .ht-root.moving .ht-split-grip { opacity: 1; }
@media (hover: none) { .ht-split-grip { opacity: 1; } }
.ht-root.moving, .ht-root.moving * { cursor: grabbing !important; user-select: none; }
.ht-root.resizing .ht-stack { user-select: none; }
.ht-split-title { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; }
.ht-split-title > span { overflow: hidden; text-overflow: ellipsis; }
.ht-split-head .ht-btn { width: 24px; height: 24px; }
.ht-split-body { flex: 1; }

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
  border: 0; border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; text-align: left; font: inherit; user-select: none;
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
.ht-menu-grip { display: inline-flex; margin-left: auto; color: var(--fg-2); visibility: hidden; cursor: grab; }
.ht-menu-item:hover .ht-menu-grip, .ht-menu-item:focus-visible .ht-menu-grip { visibility: visible; }
.ht-menu-desc + .ht-menu-grip { margin-left: 0; }
.ht-menu-item.dragging { opacity: 0.4; }
.ht-menu-item.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
.ht-menu-item.drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
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
.ht-supporter { display: inline-flex; flex: none; color: var(--fg-2); }
.ht-supporter svg { width: 12px; height: 12px; }
.ht-supporter.donor { color: var(--fgColor-sponsors, #db61a2); }

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
/* The box folds into its icon, which sits with the pane's other buttons at
   the right; open, the box fills the row before them at the buttons' height,
   so the row never grows. */
.ht-search > .ht-search-input { height: 26px; padding-left: 8px; margin: 0 4px 0 0; }
.ht-search { min-height: 26px; }
.search-closed > .ht-search { justify-content: flex-end; }
.search-closed > .ht-search > .ht-search-input { display: none; }
.ht-search-toggle.on .ht-svg path { fill: none; }
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
  /* GitHub's tree geometry: 32px rows, 8px per level, a 16px toggle column,
     8px gaps, rows inset 10px so the current-item bar fits on the left. */
  display: flex; align-items: center; gap: 8px;
  height: 32px; margin: 0 8px 0 10px; padding: 0 8px 0 calc(var(--depth, 0) * 8px);
  border-radius: 6px; color: var(--fg); text-decoration: none; white-space: nowrap; cursor: pointer; outline: none;
}
.ht-row:hover { background-color: var(--bg-hover); }
.ht-row:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
/* GitHub's current item: neutral fill and a 4x24 accent bar left of the row. */
.ht-row.selected { position: relative; background-color: var(--bg-sel); }
.ht-row.selected::before {
  content: ""; position: absolute; left: -8px; top: calc(50% - 12px); width: 4px; height: 24px;
  border-radius: 6px; background: var(--accent);
}
.ht-chevron { width: 16px; display: inline-flex; flex: none; color: var(--fg-2); transition: transform 0.12s ease; }
.ht-chevron .ht-svg { width: 12px; height: 12px; margin: 0 auto; }
/* Indent guides at each ancestor's toggle, shown while hovering the tree (always in the branch list). */
.ht-tree:hover .ht-row, .ht-branch-list .ht-row {
  background-image: repeating-linear-gradient(to right, transparent 0 7.5px, var(--border-muted, var(--border)) 7.5px 8.5px, transparent 8.5px 8px);
  background-size: calc(var(--depth, 0) * 8px + 1px) 100%; background-repeat: no-repeat;
}
.ht-ic-gh path { fill: currentColor; stroke: none; }
.ht-row[aria-expanded="true"] .ht-chevron { transform: rotate(90deg); }
.ht-icon { display: inline-flex; flex: none; color: var(--fg-2); }
.ht-icon .ht-ic-gh { color: var(--fg-2); }
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
.ht-status { display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--fg-2); }
.ht-status .ht-svg { width: 16px; height: 16px; }
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
.ht-ci-tools { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.ht-ci-tools .ht-btn.on { color: var(--accent); }
@container (max-width: 250px) { .ht-ci-site { display: none; } }
.ht-pop {
  position: absolute; left: 8px; top: calc(100% - 2px); z-index: 5; min-width: 190px; max-width: calc(100% - 16px); padding: 4px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow);
  font-size: 13px; color: var(--fg);
}
.ht-commit-dot { color: var(--fg-3); }
/* Commits are two lines: the message, then sha · author · when. */
.ht-commit-list .ht-row { height: 44px; }
.ht-commit-list .ht-name { display: flex; flex-direction: column; justify-content: center; line-height: 1.3; }
.ht-commit-list .ht-commit-title { display: block; overflow: hidden; text-overflow: ellipsis; }
.ht-commit-list .ht-dir { display: block; margin-left: 0; overflow: hidden; text-overflow: ellipsis; }
.ht-badge {
  flex: none; margin-left: 6px; padding: 0 6px; border: 1px solid var(--border); border-radius: 999px;
  color: var(--fg-2); font-size: 0.78em; line-height: 16px;
}
.ht-badge-accent { color: var(--accent); border-color: var(--accent); }
.ht-badge-count { margin-left: auto; margin-right: 2px; }
/* ---- Branches: two-line rows where the site tells the last commit ---- */
.ht-branch-list .ht-row.ht-two { height: 44px; }
.ht-branch-list .ht-row.ht-two .ht-name { display: flex; flex-direction: column; justify-content: center; line-height: 1.3; }
.ht-branch-list .ht-row.ht-two .ht-name > span { display: block; overflow: hidden; text-overflow: ellipsis; }
.ht-branch-list .ht-row.ht-two .ht-dir { margin-left: 0; }
.ht-branch-list .ht-row[aria-current="true"] .ht-branch-name { font-weight: 600; }
/* A dot on the CI/CD tab: running (pulsing) or failed. */
.ht-tab-dot {
  position: absolute; top: calc(50% - 12px); right: 4px; width: 8px; height: 8px; border-radius: 50%;
  border: 1.5px solid var(--bg-header, var(--bg)); background: var(--mod); box-sizing: content-box;
}
.ht-tab-dot.fail { background: var(--del); }
.ht-tab-dot.running { animation: ht-pulse 1.4s ease-in-out infinite; }
@keyframes ht-pulse { 50% { opacity: 0.3; } }
.ht-pop-title { padding: 4px 8px 2px; color: var(--fg-3); font-size: 0.78em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.ht-pop-item {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.ht-pop-item:hover, .ht-pop-item:focus-visible { background: var(--bg-hover); }
.ht-pop-check { display: inline-flex; width: 16px; visibility: hidden; }
.ht-pop-item.on .ht-pop-check { visibility: visible; }
.ht-pop-count { margin-left: auto; color: var(--fg-2); }
.ht-pop-sep { height: 1px; margin: 4px 0; background: var(--border); }
.ht-group-link .ht-link { text-transform: none; letter-spacing: 0; font-weight: 400; text-decoration: none; flex: none; }
.ht-ci-list .ht-empty { padding: 6px 16px; font-size: 0.92em; }
.ht-ci-note { flex-direction: column; align-items: flex-start; gap: 4px; }
.ht-ci-list .ht-row { position: relative; }

/* job detail */
/* job detail, laid out like GitHub's job page */
.ht-ci-page { padding: 6px 8px 8px; }
.ht-ci-back {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 6px; margin-left: -2px;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg-2); cursor: pointer; font-size: 12px;
}
.ht-ci-back:hover { background: var(--bg-hover); color: var(--fg); }
.ht-ci-back:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ht-ci-back-icon { display: inline-flex; transform: rotate(180deg); }
.ht-ci-back-icon .ht-svg { width: 12px; height: 12px; }
.ht-ci-title { display: flex; align-items: center; gap: 8px; padding: 6px 4px 0; min-width: 0; }
.ht-ci-title .ht-ci .ht-svg { width: 18px; height: 18px; }
.ht-ci-title h2 {
  margin: 0; min-width: 0; font-size: 16px; font-weight: 600; line-height: 1.4; color: var(--fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ht-ci-title h2 span { color: var(--fg-2); font-weight: 400; }

/* The job card: GitHub's inset surface, 1px border, rounded, resting shadow. */
.ht-ci-card {
  margin: 0 8px 12px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-input); box-shadow: var(--shadow-card, 0 1px 1px rgba(1, 4, 9, 0.5));
}
/* In the job view, search and tools live in the card header. */
.ci-job > .ht-search { display: none; }
.ci-job > .ht-body { padding-top: 0; }
.ht-ci-card-top { position: sticky; top: 0; z-index: 2; border-radius: 6px 6px 0 0; background: var(--bg-input); }
.ht-ci-card-head { display: flex; align-items: center; gap: 8px; padding: 12px 6px 10px 12px; }
.ht-ci-card-actions { display: flex; gap: 2px; flex: none; }
.ht-ci-search { position: relative; display: flex; padding: 0 8px 8px; }
.ht-ci-search .ht-search-icon { left: 17px; top: 7px; }
.ht-ci-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ht-ci-job-name {
  color: var(--accent); font-size: 14px; font-weight: 600; text-decoration: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ht-ci-job-name:hover { text-decoration: underline; }
.ht-ci-job-num { color: var(--fg-2); font-weight: 400; }
.ht-ci-head-text > span { color: var(--fg-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-ci-card .ht-ci-steps { padding: 0 8px 8px; }
.ht-ci-card .ht-ci-steps .ht-row { margin: 0; }
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
.ht-ci-steps .ht-row { height: 28px; }
.ht-ci-steps .ht-row[aria-expanded="true"] {
  position: sticky; top: calc(var(--ht-detail-h, 0px) - 1px); z-index: 1; margin-top: 4px;
  background: color-mix(in srgb, var(--fg) 22%, var(--bg-input)); box-shadow: 0 0 0 2px var(--bg-input);
}
.ht-ci-steps .ht-row:hover { background: color-mix(in srgb, var(--fg) 12%, var(--bg-input)); }
.ht-ci-steps .ht-row[aria-expanded="true"]:hover { background: color-mix(in srgb, var(--fg) 26%, var(--bg-input)); }
/* GitHub shows passed steps in the text color; only failures and running steps get color. */
.ht-ci-steps .ht-ci-ok { color: var(--fg); }
.ht-ci-hits { flex: none; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--mark); color: var(--fg); font-size: 11px; line-height: 16px; text-align: center; }
.ht-log { margin: 4px 0 8px; }
.ht-log-note { display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: var(--fg-2); font-size: 0.9em; }
.ht-log > .ht-link { margin: 0 10px 8px; }
.ht-log-lines { padding: 4px 0; font-size: 12px; line-height: 20px; }
.ht-log-line { display: flex; align-items: flex-start; gap: 10px; padding-right: 6px; border-radius: 6px; }
.ht-log-line:hover { background: var(--bg-hover); }
.ht-log-n { flex: none; width: 30px; text-align: right; color: var(--fg-2); user-select: none; font-variant-numeric: tabular-nums; }
.ht-log-text { flex: 1; min-width: 0; color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; }
.ht-log-text a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.ht-log-text a:hover { color: var(--accent); }
.ht-log-text mark { background: var(--mark); color: inherit; border-radius: 2px; }
.ht-log-fold-head { cursor: pointer; }
.ht-log-caret {
  display: inline-block; width: 0; height: 0; margin: 0 5px 1px 1px; vertical-align: middle;
  border-style: solid; border-width: 3.5px 0 3.5px 5px; border-color: transparent transparent transparent var(--fg);
  transition: transform 0.12s ease;
}
.ht-log-fold.open > .ht-log-fold-head .ht-log-caret { transform: rotate(90deg); }
.ht-log-fold-body { display: none; }
.ht-log-fold.open > .ht-log-fold-body { display: block; }
.ht-log-command .ht-log-text { color: var(--ansi-12, var(--ren)); }
.ht-log-label { font-weight: 600; }
.ht-log-error { background: color-mix(in srgb, var(--del) 15%, transparent); }
.ht-log-error .ht-log-label { color: var(--del); }
.ht-log-warning { background: color-mix(in srgb, var(--mod) 15%, transparent); }
.ht-log-warning .ht-log-label { color: var(--mod); }
.ht-log-notice .ht-log-label { color: var(--ren); }
.ht-log-debug .ht-log-text { color: var(--fg-2); }

/* ---- states ---- */
.ht-loading, .ht-empty { display: flex; align-items: center; gap: 8px; padding: 14px 16px; color: var(--fg-2); }
.ht-loading-row { display: flex; align-items: center; gap: 8px; height: 26px; padding-left: calc(34px + var(--depth, 0) * 8px); color: var(--fg-3); font-size: 0.92em; }
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
.ht-root.settings-open .ht-main > .ht-search { display: none; }
/* Settings cover the whole sidebar down to the footer, tab row included (the
   footer gear opens and closes them). The tab row, search and tree stay put
   underneath, so nothing has to be laid out again. The cover stays inside
   the panel: on GitHub, reaching up over GitHub's header put the top of the
   settings under that header (it draws above the sidebar). */
.ht-root.settings-open .ht-stack { position: absolute; inset: 0 0 32px 0; z-index: 4; background: var(--bg); }
.ht-root.settings-open .ht-split, .ht-root.settings-open .ht-split-gap { display: none; }
/* With the tree out of the flow the footer would slide up under the cover. */
.ht-root.settings-open .ht-footer { margin-top: auto; position: relative; z-index: 5; }
.ht-btn.active { background: var(--bg-hover); color: var(--accent); }
/* A newer Hector is out. */
.ht-btn.has-update { position: relative; }
.ht-btn.has-update::after { content: ''; position: absolute; top: 3px; right: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--fg); box-shadow: 0 0 0 1.5px var(--bg); }
.ht-settings { padding: 4px 12px 12px; }
.ht-settings-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 0 4px; }
.ht-settings-head strong { font-size: 1.05em; }
.ht-section { padding: 10px 0 12px; border-bottom: 1px solid var(--border); }
.ht-section:last-of-type { border-bottom: 0; }
.ht-section h3 { margin: 0 0 6px; font-size: 0.82em; font-weight: 600; color: var(--fg-2); text-transform: uppercase; letter-spacing: 0.04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-help { margin: 0 0 8px; color: var(--fg-2); font-size: 0.88em; }
.ht-subhead { margin: 12px 0 6px; font-size: 0.92em; font-weight: 600; }
.ht-repo-section .ht-subhead:first-of-type { margin-top: 4px; }
.ht-checks { list-style: none; margin: 6px 0 0; padding: 0; font-size: 0.88em; }
.ht-checks li { display: flex; align-items: flex-start; gap: 6px; padding: 2px 0; color: var(--fg-2); }
.ht-checks li .ht-svg { width: 14px; height: 14px; margin-top: 2px; }
.ht-checks li.ok .ht-svg { color: var(--add); }
.ht-checks li.err { color: var(--del); }
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
/* What a list is about: "Commits in #12", "History of main". */
.ht-scope { display: flex; align-items: center; gap: 6px; padding: 6px 12px 2px; color: var(--fg-2); font-size: 0.86em; min-width: 0; }
.ht-scope span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-scope .ht-svg { width: 14px; height: 14px; }
/* Custom tabs */
.ht-ct-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 0.92em; }
.ht-ct-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-ct-name .ht-dir { margin-left: 6px; }
.ht-import { width: 100%; min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; margin-bottom: 6px; }
.ht-scope-link { margin-left: auto; flex: none; }
.ht-custom-list .ht-row.ht-two .ht-dir { display: block; margin-left: 0; overflow: hidden; text-overflow: ellipsis; }
.ht-custom-list .ht-name { min-width: 0; }
.ht-custom-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-file-view { margin: 4px 8px 12px; padding: 6px 0; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); font: 0.86em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; user-select: text; }
.ht-file-line { display: flex; white-space: pre; }
.ht-file-no { flex: none; width: 3.5em; padding-right: 10px; text-align: right; color: var(--fg-3); user-select: none; }
.ht-file-text { flex: 1; padding-right: 10px; }
/* File and diff preview: a head row (back, name, open), then the text. */
.ht-root .ht-body.previewing { padding-top: 0; }
.ht-preview-head {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 4px;
  margin: 0 0 4px; padding: 4px 6px 4px 4px; background: var(--panel-bg, var(--bg)); border-bottom: 1px solid var(--border);
}
.ht-back .ht-svg { transform: rotate(180deg); }
.ht-preview-head > .ht-icon { display: inline-flex; flex: none; margin: 0 2px 0 2px; }
.ht-preview-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.ht-preview-name .ht-dir { margin-left: 6px; font-weight: 400; }
.ht-preview-stat { display: inline-flex; gap: 4px; flex: none; font-size: 12px; margin-right: 2px; }
.ht-preview-view { margin: 0 8px 8px; padding: 4px 0; }
.ht-preview-view .ht-file-line { width: max-content; min-width: 100%; }
/* Code colors (highlight.js). */
.tk-com { color: var(--tk-com); font-style: normal; }
.tk-kw { color: var(--tk-kw); }
.tk-str { color: var(--tk-str); }
.tk-num, .tk-const, .tk-prop, .tk-attr { color: var(--tk-num); }
.tk-fn { color: var(--tk-fn); }
.tk-type, .tk-var { color: var(--tk-type); }
.tk-tag { color: var(--tk-tag); }
.tk-punct { color: var(--fg-2); }
.ht-diff .ht-file-no { width: 3em; padding-right: 6px; }
.ht-diff .ht-file-text { padding-left: 4px; }
.ht-diff-add { background: color-mix(in srgb, var(--add) 16%, transparent); }
.ht-diff-del { background: color-mix(in srgb, var(--del) 16%, transparent); }
.ht-diff-hunk { color: var(--fg-2); background: color-mix(in srgb, var(--ren) 10%, transparent); }
/* Pull/merge requests and issues, like the sites' own lists. */
.ht-root .ht-item-list .ht-row.ht-item {
  align-items: flex-start; gap: 8px; height: auto; min-height: 0; padding: 8px 10px 8px 12px; line-height: 18px;
  border-bottom: 1px solid var(--border); border-radius: 0; margin: 0;
}
.ht-root[data-site="gitlab"] .ht-item-list .ht-row.ht-item { padding: 10px 12px; margin: 0 4px; border-radius: 0; background-image: none; }
.ht-item-list li:last-child .ht-row.ht-item { border-bottom: 0; }
.ht-row.ht-item.selected::before { left: 0; top: 8px; height: calc(100% - 16px); }
.ht-item > .ht-icon { margin: 1px 0 0; flex: none; }
.ht-item > .ht-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; white-space: normal; overflow: visible; }
.ht-item-title { font-weight: 600; color: var(--fg); overflow-wrap: anywhere; }
.ht-item-title .ht-badge { margin: 0 6px 0 0; vertical-align: 1px; }
.ht-item-sub, .ht-item-branch { color: var(--fg-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-item-branch { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.ht-item-branch .ht-svg { width: 12px; height: 12px; flex: none; }
.ht-labels { display: flex; flex-wrap: wrap; gap: 4px; }
.ht-label {
  display: inline-block; max-width: 100%; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 18px;
  background: var(--bg-hover); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ht-item-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; color: var(--fg-2); font-size: 12px; }
.ht-item-count { display: inline-flex; align-items: center; gap: 3px; }
.ht-item-count .ht-svg { width: 14px; height: 14px; }
.ht-item-updated { white-space: nowrap; }
@container (max-width: 360px) { .ht-item-updated { display: none; } }
/* The Dynamic tab: a work item's or merge request's details and activity,
   or the project's information. */
.ht-dyn { padding: 4px 12px 12px; }
.ht-dyn-head { padding: 6px 0 10px; border-bottom: 1px solid var(--border); }
.ht-dyn-title { font-size: 1.08em; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.ht-dyn-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; color: var(--fg-2); font-size: 12px; }
.ht-state-pill { display: inline-block; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 20px; font-weight: 600; color: #fff; }
.ht-pill-open { background: var(--add); }
.ht-pill-draft { background: var(--fg-3); }
.ht-pill-merged { background: var(--merged, #8250df); }
.ht-pill-closed { background: var(--del); }
.ht-root[data-site="gitlab"] .ht-pill-closed { background: var(--ren); }
.ht-dyn-section { padding: 10px 0; border-bottom: 1px solid var(--border); }
.ht-dyn-section:last-child { border-bottom: 0; }
.ht-dyn-h { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--fg-2); }
.ht-dyn-row { display: flex; gap: 12px; padding: 3px 0; font-size: 13px; }
.ht-dyn-key { flex: none; width: 92px; color: var(--fg-2); }
.ht-dyn-val { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ht-dyn-text { margin: 0 0 8px; overflow-wrap: anywhere; }
.ht-muted { color: var(--fg-3); }
.ht-activity { list-style: none; margin: 0; padding: 0 0 0 4px; border-left: 2px solid var(--border); }
.ht-act { position: relative; padding: 4px 0 8px 14px; font-size: 13px; line-height: 1.5; }
.ht-act-event::before { content: ""; position: absolute; left: -6px; top: 10px; width: 10px; height: 10px; border-radius: 50%; background: var(--bg); border: 2px solid var(--fg-3); }
.ht-act-line { overflow-wrap: anywhere; }
.ht-act-line .ht-label { margin: 0 2px; vertical-align: 1px; }
.ht-act-time { color: var(--fg-2); font-size: 12px; white-space: nowrap; }
.ht-act-card { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.ht-act-card-head { padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
.ht-act-body { padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.ht-act-quote { margin-top: 4px; padding: 6px 10px; border-left: 2px solid var(--border); }
.ht-del-text { background: color-mix(in srgb, var(--del) 25%, transparent); text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
.ht-ins-text { background: color-mix(in srgb, var(--add) 25%, transparent); text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
.ht-code-inline { padding: 0 4px; border-radius: 4px; background: var(--bg-hover); font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; }
.ht-sha { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
.ht-stats-grid { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--fg-2); }
.ht-stat { display: inline-flex; align-items: center; gap: 5px; color: inherit; text-decoration: none; }
a.ht-stat:hover { color: var(--accent); }
.ht-stat strong { color: var(--fg); }
.ht-lang-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--bg-hover); margin-bottom: 8px; }
.ht-lang-bar > span { display: block; min-width: 2px; }
.ht-lang-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--fg-2); }
.ht-lang-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.ht-lang-legend strong { color: var(--fg); font-weight: 600; }
.ht-outline { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.ht-outline li { padding: 2px 0 2px calc(var(--depth, 0) * 14px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-outline .ht-link { color: var(--fg); text-decoration: none; }
.ht-outline .ht-link:hover { color: var(--accent); text-decoration: underline; }
.ht-clone { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.ht-clone .ht-dyn-key { width: 44px; }
.ht-clone code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-state-plain { color: var(--fg-2); }
.ht-state-done { color: var(--merged, #8250df); }
.ht-state-open { color: var(--add); }
.ht-state-draft { color: var(--fg-3); }
.ht-state-merged { color: var(--merged, #8250df); }
.ht-state-closed { color: var(--del); }
.ht-menu-action { width: 100%; border: 0; background: none; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.ht-report-box { margin-top: 6px; }
.ht-report-box summary { cursor: pointer; color: var(--fg-2); font-size: 0.88em; }
.ht-report { margin: 6px 0 0; padding: 8px; max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; user-select: text; }
.ht-status-line { margin: 2px 0 0; min-height: 1.2em; color: var(--fg-2); font-size: 0.88em; }
.ht-status-line.ok { color: var(--add); }
.ht-status-line.err { color: var(--del); }
.ht-ci-source { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px 6px; margin: 0 0 8px; background: var(--bg-2, transparent); }
.ht-ci-source-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 0.92em; }
.ht-ci-source select.ht-input { width: 100%; }
.ht-ci-source.folded { padding: 6px 10px; }
.ht-ci-source.folded .ht-ci-source-head { margin: 0; }
.ht-ci-source.folded .ht-status-line { margin: 2px 0 0; font-size: 12px; }
.ht-ci-source-sum { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.ht-ci-source-sum > span { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-ci-source-head .ht-inline { margin: 0; gap: 12px; }
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

/* ---- GitLab: the sidebar is part of GitLab's chrome (no rules), its
   content sits in a panel like GitLab's, and rows follow GitLab's
   repository file tree (Pajamas): 32px rows, 16px per level, a 24px
   toggle, 8px radii, always-on indent guides. ---- */
.ht-gl { fill: currentColor; stroke: none; }
.ht-gl-file { fill: var(--fg-2); stroke: none; }
.ht-root[data-site="gitlab"] { font-family: var(--page-font, inherit); }
.ht-root[data-site="gitlab"] .ht-panel { border: 0; }
.ht-root[data-site="gitlab"] .ht-top { border-bottom: 0; background: var(--bg); }
.ht-root[data-site="gitlab"] .ht-footer { border-top: 0; }
/* GitLab: branch, file count, account and buttons share the tab row. The
   tabs keep their width and the rest takes what's left; _fitTop hides what
   doesn't fit, and the tabs scroll as a last resort, never overlap. */
.ht-top > .ht-tabs { flex: 0 1 auto; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.ht-top > .ht-tabs::-webkit-scrollbar { display: none; }
.ht-top > .ht-stats { flex: 1 1 0; min-width: 0; justify-content: flex-end; padding: 0 4px 0 8px; }
.ht-top > .ht-stats[hidden] { display: flex; visibility: hidden; padding: 0; }
.ht-top > .ht-account-chip { align-self: center; flex: 0 1 auto; max-width: 160px; }
.ht-top > .ht-account-chip[hidden] { display: none; }
.ht-top > .ht-account-chip.compact .ht-account-login, .ht-top > .ht-account-chip.compact .ht-supporter { display: none; }
.ht-top > .ht-footer-actions { flex: none; align-self: center; margin-left: 0; padding-right: 6px; }
.ht-footer-actions > [hidden] { display: none; }
.ht-more-pop { left: auto; right: 6px; top: calc(100% - 4px); }
/* Settings cover the panel under that row, which stays in reach. */
.ht-root[data-site="gitlab"].settings-open .ht-stack { inset: var(--ht-top-height, 48px) 0 0 0; }
.ht-root[data-site="gitlab"] .ht-tab-inner,
.ht-root[data-site="gitlab"] .ht-btn,
.ht-root[data-site="gitlab"] .ht-account-chip,
.ht-root[data-site="gitlab"] .ht-input,
.ht-root[data-site="gitlab"] .ht-primary,
.ht-root[data-site="gitlab"] .ht-secondary,
.ht-root[data-site="gitlab"] .ht-menu-item { border-radius: 8px; }
.ht-root[data-site="gitlab"] .ht-tab.active::after { border-radius: 0; }

.ht-root[data-site="gitlab"] .ht-search,
.ht-root[data-site="gitlab"] .ht-body {
  margin: 0 8px; background: var(--panel-bg, var(--bg)); border: 1px solid var(--panel-border, transparent);
}
.ht-root[data-site="gitlab"] .ht-search { padding: 8px 8px 4px 12px; border-bottom: 0; border-radius: 12px 12px 0 0; }
.ht-root[data-site="gitlab"] .ht-search > .ht-search-input { height: 26px; }
.ht-root[data-site="gitlab"] .ht-body { padding: 4px 0 12px; border-top: 0; border-radius: 0 0 12px 12px; }
.ht-root[data-site="gitlab"] .ht-main.ci-job > .ht-body,
.ht-root[data-site="gitlab"].settings-open .ht-main > .ht-body { border-top: 1px solid var(--panel-border, transparent); border-radius: 12px; }
.ht-root[data-site="gitlab"] .ht-main.ci-job > .ht-body { padding-top: 0; }

.ht-root[data-site="gitlab"] .ht-search-input,
.ht-root[data-site="gitlab"] .ht-input {
  height: 32px; padding: 0 8px; border: 1px solid var(--section-border, var(--border));
  background: var(--section-bg, var(--bg-input));
}
.ht-root[data-site="gitlab"] .ht-search-input { border-radius: 8px; }
.ht-root[data-site="gitlab"] .ht-search-input:focus,
.ht-root[data-site="gitlab"] .ht-input:focus {
  border-color: var(--section-border, var(--border));
  box-shadow: 0 0 0 1px var(--panel-bg, var(--bg)), 0 0 0 3px var(--focus-ring, var(--accent));
}

.ht-root[data-site="gitlab"] .ht-row {
  gap: 0; margin: 0 8px 0 4px; padding: 4px 8px 4px calc(var(--depth, 0) * 16px);
  border-radius: 8px; line-height: 16px;
}
.ht-root[data-site="gitlab"] .ht-row:not([aria-expanded]) { padding-left: calc(16px + var(--depth, 0) * 16px); }
.ht-root[data-site="gitlab"] .ht-row:not([aria-expanded]) > .ht-chevron { display: none; }
/* Builds beside expandable runs: line the icons up with theirs (24px toggle + 2px + 8px). */
.ht-root[data-site="gitlab"] .ht-row.ht-ci-flat, .ht-root[data-site="gitlab"] .ht-row.ht-flat { padding-left: calc(34px + var(--depth, 0) * 16px); }
.ht-root[data-site="gitlab"] .ht-row:focus-visible { box-shadow: inset 0 0 0 2px var(--focus-ring, var(--accent)); }
.ht-root[data-site="gitlab"] .ht-chevron {
  width: 24px; height: 24px; margin-right: 2px; align-items: center; justify-content: center; color: var(--fg);
}
.ht-root[data-site="gitlab"] .ht-chevron .ht-svg { width: 16px; height: 16px; margin: 0; }
.ht-root[data-site="gitlab"] .ht-row[aria-expanded] > .ht-icon { margin-left: 8px; }
.ht-root[data-site="gitlab"] .ht-icon { margin-right: 4px; }
.ht-root[data-site="gitlab"] .ht-gl-folder { color: var(--fg-2); }
.ht-root[data-site="gitlab"] .ht-row-actions, .ht-root[data-site="gitlab"] .ht-meta { margin-left: 8px; }
.ht-root[data-site="gitlab"] .ht-row.selected { background-color: var(--highlight, var(--bg-sel)); font-weight: 600; }
.ht-root[data-site="gitlab"] .ht-row.selected::before { display: none; }
/* A 1px guide per level, through the middle of each ancestor's toggle. Drawn in
   a translucent text color, not --border: GitLab's border and highlight greys
   are nearly the same, which made the guides vanish inside a selected or
   hovered row. */
.ht-root[data-site="gitlab"] .ht-tree .ht-row,
.ht-root[data-site="gitlab"] .ht-branch-list .ht-row,
.ht-root[data-site="gitlab"] .ht-tree:hover .ht-row {
  --ht-guide: color-mix(in srgb, var(--fg) 22%, transparent);
  background-image: repeating-linear-gradient(to right, var(--ht-guide) 0 1px, transparent 1px 16px);
  background-position: 11.5px 0; background-size: calc(var(--depth, 0) * 16px) 100%; background-repeat: no-repeat;
}
.ht-root[data-site="gitlab"] .ht-loading-row { padding-left: calc(20px + var(--depth, 0) * 16px); }

.ht-root[data-site="gitlab"] .ht-group,
.ht-root[data-site="gitlab"] .ht-section h3 { text-transform: none; letter-spacing: 0; font-size: 12px; }
.ht-root[data-site="gitlab"] .ht-group { margin: 12px 12px 4px 16px; }
/* Split view on GitLab: a second panel card beside the first. */
.ht-root[data-site="gitlab"] .ht-split {
  margin: 0 8px; border: 1px solid var(--panel-border, transparent); border-radius: 12px; background: var(--panel-bg, var(--bg));
}
.ht-root[data-site="gitlab"] .ht-split .ht-split-body { margin: 0; border: 0; border-radius: 0 0 12px 12px; background: transparent; }
.ht-root[data-site="gitlab"] .ht-split .ht-split-search { margin: 0; padding: 0 8px 4px 12px; border: 0; border-radius: 0; background: transparent; }
/* GitLab's CI colors: running is blue, and its icons don't spin. */
.ht-root[data-site="gitlab"] .ht-ci-running { color: var(--ren); }
.ht-root[data-site="gitlab"] .ht-ci-running .ht-svg { animation: none; }
.ht-root[data-site="gitlab"] .ht-ci-card { border-radius: 12px; }
.ht-root[data-site="gitlab"] .ht-log-line { border-radius: 8px; }
.ht-root[data-site="gitlab"] .ht-log-lines { padding: 4px; }
.ht-root[data-site="gitlab"] .ht-body { margin-bottom: 6px; }
/* Keep the lighter panel color from widening GitLab's own rail: no margin on the side facing the page. */
.ht-root[data-site="gitlab"][data-dock="left"] .ht-search,
.ht-root[data-site="gitlab"][data-dock="left"] .ht-body,
.ht-root[data-site="gitlab"][data-dock="left"] .ht-split { margin-right: 1px; }
.ht-root[data-site="gitlab"][data-dock="right"] .ht-search,
.ht-root[data-site="gitlab"][data-dock="right"] .ht-body,
.ht-root[data-site="gitlab"][data-dock="right"] .ht-split { margin-left: 1px; }
.ht-root[data-site="gitlab"] .ht-ci-card-top { border-radius: 12px 12px 0 0; }

/* ---- Bitbucket: Atlassian's look (3px radii, 2px borders, uppercase labels) ---- */
.ht-root[data-site="bitbucket"] { font-family: var(--page-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, "Droid Sans", "Helvetica Neue", sans-serif); }
.ht-root[data-site="bitbucket"] .ht-row { border-radius: 3px; margin: 0 8px; padding-left: calc(4px + var(--depth, 0) * 16px); }
.ht-root[data-site="bitbucket"] .ht-row.selected { background-color: var(--highlight, var(--bg-sel)); color: var(--accent); }
.ht-root[data-site="bitbucket"] .ht-row.selected .ht-icon { color: var(--accent); }
.ht-root[data-site="bitbucket"] .ht-row.selected::before { display: none; }
.ht-root[data-site="bitbucket"] .ht-row:focus-visible { box-shadow: inset 0 0 0 2px var(--focus-ring, var(--accent)); }
.ht-root[data-site="bitbucket"] .ht-search-input, .ht-root[data-site="bitbucket"] .ht-input { border-radius: 3px; border-width: 2px; }
.ht-root[data-site="bitbucket"] .ht-search-input:focus, .ht-root[data-site="bitbucket"] .ht-input:focus { border-color: var(--focus-ring, var(--accent)); box-shadow: none; }
.ht-root[data-site="bitbucket"] .ht-btn, .ht-root[data-site="bitbucket"] .ht-primary, .ht-root[data-site="bitbucket"] .ht-secondary,
.ht-root[data-site="bitbucket"] .ht-tab-inner, .ht-root[data-site="bitbucket"] .ht-ci-card, .ht-root[data-site="bitbucket"] .ht-log-line,
.ht-root[data-site="bitbucket"] .ht-pop, .ht-root[data-site="bitbucket"] .ht-menu { border-radius: 3px; }
.ht-root[data-site="bitbucket"] .ht-tab.active::after { border-radius: 0; }
.ht-root[data-site="bitbucket"] .ht-badge { border-radius: 3px; border-color: transparent; background: var(--bg-2); font-size: 0.7em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
.ht-root[data-site="bitbucket"] .ht-badge-accent { background: var(--accent); color: var(--primary-fg, #fff); }
.ht-root[data-site="bitbucket"] .ht-group, .ht-root[data-site="bitbucket"] .ht-section h3 { font-size: 0.75em; }
.ht-root[data-site="bitbucket"] .ht-ci-running { color: var(--ren); }
.ht-root[data-site="bitbucket"] .ht-ci-running .ht-svg { animation: none; }
.ht-root[data-site="bitbucket"] .ht-split { border-radius: 3px; }

@media (prefers-reduced-motion: reduce) {
  .ht-panel, .ht-toggle, .ht-chevron, .ht-toast { transition: none; }
  .ht-menu, .ht-ci-running .ht-svg, .ht-live::before, .ht-tab-dot { animation: none; }
  .ht-tab.holding::after { animation-duration: 1ms; animation-delay: 449ms; }
  .ht-log-caret { transition: none; }
}


/* A compact history list with a dedicated graph gutter. Host colors are
   inherited; graph colors encode lanes rather than success/warning states. */
.ht-root {
  --graph-0: #0969da; --graph-1: #8250df; --graph-2: #1a7f72;
  --graph-3: #bf3989; --graph-4: #9a6700; --graph-5: #57606a;
}
.ht-root[data-theme="dark"] {
  --graph-0: #79c0ff; --graph-1: #bc8cff; --graph-2: #56d4b3;
  --graph-3: #f778ba; --graph-4: #e3b341; --graph-5: #a5adba;
}
.ht-branch-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 12px 10px; }
.ht-branch-count { color: var(--fg-2); font-size: 12px; }
.ht-branch-views { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--graph-button-border, var(--border)); border-radius: 6px; background: var(--bg-2); }
.ht-branch-view { height: 24px; padding: 0 10px; border: 0; border-radius: 4px; background: transparent; color: var(--fg-2); font-size: 12px; line-height: 20px; cursor: pointer; }
.ht-branch-view:hover { color: var(--fg); background: var(--bg-hover); }
.ht-branch-view[aria-pressed="true"] { background: var(--panel-bg, var(--bg)); color: var(--fg); font-weight: 600; box-shadow: 0 1px 3px #0002; }
.ht-btn.ht-graph-toggle { width: auto; height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; margin-left: 8px; }
.ht-graph-note { padding: 8px 12px; color: var(--fg-2); font-size: 12px; }
.ht-branch-graph { display: flex; align-items: flex-start; overflow-x: auto; padding: 0 8px; }
.ht-graph-lines { flex: none; }
.ht-graph-commits { flex: 1; min-width: 160px; padding: 0; margin: 0; list-style: none; }
.ht-graph-commit { height: 44px; padding: 4px 6px; display: flex; flex-direction: column; justify-content: center; border-radius: 4px; }
.ht-graph-commit:hover, .ht-graph-commit:focus-within { background: var(--bg-hover); }
.ht-graph-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 13px; line-height: 20px; text-decoration: none; flex-shrink: 0; }
.ht-graph-meta { display: flex; align-items: center; gap: 8px; min-width: 0; height: 16px; color: var(--fg-2); font-size: 11px; line-height: 16px; }
.ht-graph-author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-graph-labels { display: flex; min-width: 0; overflow-x: auto; gap: 6px; scrollbar-width: none; }
.ht-graph-labels::-webkit-scrollbar { display: none; }
.ht-graph-ref { display: inline-flex; align-items: center; gap: 3px; min-width: 0; flex: 0 0 auto; max-width: 130px; color: var(--fg-2); text-decoration: none; }
.ht-graph-ref > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-graph-ref .ht-svg { width: 12px; height: 12px; flex: none; }
.ht-graph-current { color: var(--graph-0); font-weight: 600; }
.ht-graph-sha { color: var(--fg-2); text-decoration: none; font: 10px/16px ui-monospace, SFMono-Regular, Consolas, monospace; flex: none; }
.ht-graph-time { white-space: nowrap; margin-left: auto; overflow: hidden; text-overflow: ellipsis; }
.ht-graph-title:hover, .ht-graph-meta a:hover { color: var(--accent); text-decoration: underline; }
.ht-branch-graph a:focus-visible, .ht-branch-view:focus-visible, .ht-graph-history-note summary:focus-visible { outline: 2px solid var(--focus-ring, var(--accent)); outline-offset: -1px; }
.ht-graph-history-note { padding: 10px 12px 4px; color: var(--fg-2); font-size: 11px; }
.ht-graph-history-note summary { cursor: pointer; width: fit-content; }
.ht-graph-history-note p { margin: 6px 0 0; line-height: 1.5; }
.ht-root[data-site="gitlab"] .ht-branch-views { border-radius: 4px; background: var(--section-bg, var(--bg-2)); border-color: var(--section-border, var(--border)); }
.ht-root[data-site="gitlab"] .ht-branch-view { border-radius: 2px; }
.ht-root[data-site="gitlab"] .ht-branch-view[aria-pressed="true"] { box-shadow: 0 0 0 1px var(--section-border, var(--border)); }
`;

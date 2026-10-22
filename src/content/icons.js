// Hand-drawn 16x16 stroke icons, built with DOM APIs (no innerHTML, so pages
// enforcing Trusted Types are fine).
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  chevron: [['path', { d: 'M6 3.5 10.5 8 6 12.5' }]],
  file: [['path', { d: 'M3.5 1.5h5.5l3.5 3.5v9.5h-9z' }], ['path', { d: 'M9 1.5V5h3.5' }]],
  folder: [['path', { d: 'M1.5 3h4.5l1.5 1.75h7v8.75h-13z' }]],
  folderOpen: [
    ['path', { d: 'M1.5 13.5V3h4.5l1.5 1.75h6v2.25' }],
    ['path', { d: 'M1.5 13.5 3.75 7h11L12.5 13.5z' }],
  ],
  submodule: [['rect', { x: 1.5, y: 3, width: 13, height: 10.5, rx: 1 }], ['path', { d: 'M5 8.25h6M8.5 5.75 11 8.25 8.5 10.75' }]],
  star: [['path', { d: 'M8 1.75l1.9 3.9 4.3.6-3.1 3 .75 4.25L8 11.5l-3.85 2 .75-4.25-3.1-3 4.3-.6z' }]],
  pin: [['path', { d: 'M5.5 1.5h5M6.5 1.5v4.5L4 8.5h8L9.5 6V1.5M8 8.5v6' }]],
  unpin: [['path', { d: 'M5.5 1.5h5M6.5 1.5v4.5L4 8.5h8L9.5 6V1.5M8 8.5v6' }], ['path', { d: 'M2 2l12 12' }]],
  settings: [
    ['path', { d: 'M2 4h7M12 4h2M2 8h2M7 8h7M2 12h5M10 12h4' }],
    ['circle', { cx: 10.5, cy: 4, r: 1.5 }],
    ['circle', { cx: 5.5, cy: 8, r: 1.5 }],
    ['circle', { cx: 8.5, cy: 12, r: 1.5 }],
  ],
  close: [['path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9' }]],
  copy: [['rect', { x: 5.5, y: 5.5, width: 8, height: 9, rx: 1.25 }], ['path', { d: 'M10.5 3V2.75c0-.7-.55-1.25-1.25-1.25h-5.5c-.7 0-1.25.55-1.25 1.25v7.5c0 .7.55 1.25 1.25 1.25H4' }]],
  check: [['path', { d: 'M3 8.5l3.25 3.25L13 5' }]],
  search: [['circle', { cx: 7, cy: 7, r: 4.5 }], ['path', { d: 'M10.5 10.5l4 4' }]],
  branch: [
    ['circle', { cx: 4.5, cy: 3.5, r: 1.75 }],
    ['circle', { cx: 4.5, cy: 12.5, r: 1.75 }],
    ['circle', { cx: 11.5, cy: 4.5, r: 1.75 }],
    ['path', { d: 'M4.5 5.25v5.5M11.5 6.25c0 3-7 2-7 4.5' }],
  ],
  pull: [
    ['circle', { cx: 4, cy: 3.5, r: 1.75 }],
    ['circle', { cx: 4, cy: 12.5, r: 1.75 }],
    ['circle', { cx: 12, cy: 12.5, r: 1.75 }],
    ['path', { d: 'M4 5.25v5.5M12 10.75V6c0-1.1-.9-2-2-2H7.5M9 2.5 7.5 4 9 5.5' }],
  ],
  repo: [['path', { d: 'M3.5 13V2.75c0-.7.55-1.25 1.25-1.25h7.75v10H4.75c-.7 0-1.25.55-1.25 1.25s.55 1.25 1.25 1.25H6.5M9 13.5v2l-.75-.6-.75.6v-2' }]],
  lock: [['rect', { x: 3, y: 7, width: 10, height: 7.5, rx: 1.25 }], ['path', { d: 'M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2' }]],
  bookmark: [['path', { d: 'M4 1.5h8v13l-4-3-4 3z' }]],
  files: [['path', { d: 'M5.5 1.5h4.5l3 3v8h-7.5z' }], ['path', { d: 'M3 4.5v10h7' }]],
  diff: [['path', { d: 'M8 2.5v5M5.5 5h5M5.5 11h5' }], ['rect', { x: 2, y: 1.5, width: 12, height: 13, rx: 1.5 }]],
  refresh: [['path', { d: 'M13.5 8A5.5 5.5 0 1 1 11.9 4.1' }], ['path', { d: 'M12.25 1.5v3h-3' }]],
  external: [['path', { d: 'M9.5 1.5h5v5M14.5 1.5 8 8M12.5 9.5v4c0 .55-.45 1-1 1h-9c-.55 0-1-.45-1-1v-9c0-.55.45-1 1-1h4' }]],
  collapseAll: [['path', { d: 'M4.5 2 8 5.5 11.5 2M4.5 14 8 10.5 11.5 14M2.5 8h11' }]],
  expandAll: [['path', { d: 'M4.5 5.5 8 2 11.5 5.5M4.5 10.5 8 14 11.5 10.5M2.5 8h11' }]],
  logo: [
    ['path', { d: 'M8 1 14 4.5v7L8 15 2 11.5v-7z' }],
    ['path', { d: 'M6.25 5v6M6.25 8h3.5M6.25 11h3.5' }],
  ],
};

HT.icon = function icon(name, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ht-svg${className ? ` ${className}` : ''}`);
  for (const [tag, attrs] of ICONS[name] || ICONS.file) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
};

// Extension -> accent color, roughly following common language colors.
const EXT_COLORS = {
  js: '#e8c600', mjs: '#e8c600', cjs: '#e8c600', jsx: '#4fb8d6', ts: '#3178c6', tsx: '#3178c6', mts: '#3178c6',
  py: '#3572a5', pyi: '#3572a5', ipynb: '#da5b0b', rb: '#cc342d', go: '#00add8', rs: '#dea584', java: '#b07219',
  kt: '#a97bff', kts: '#a97bff', scala: '#c22d40', swift: '#f05138', m: '#438eff', c: '#7f8ea3', h: '#7f8ea3',
  cc: '#f34b7d', cpp: '#f34b7d', hpp: '#f34b7d', cs: '#178600', fs: '#b845fc', php: '#4f5d95', pl: '#0298c3',
  r: '#198ce7', jl: '#a270ba', lua: '#6c78d6', dart: '#00b4ab', ex: '#6e4a7e', exs: '#6e4a7e', erl: '#b83998',
  hs: '#5e5086', clj: '#db5855', elm: '#60b5cc', zig: '#ec915c', nim: '#ffc200', sol: '#6a7bbd',
  html: '#e34c26', htm: '#e34c26', css: '#663399', scss: '#c6538c', sass: '#c6538c', less: '#1d365d',
  vue: '#41b883', svelte: '#ff3e00', astro: '#ff5a03',
  json: '#cbaa1f', jsonc: '#cbaa1f', yml: '#cb171e', yaml: '#cb171e', toml: '#9c4221', xml: '#0060ac', ini: '#8a8a8a',
  env: '#8a8a8a', lock: '#8a8a8a', md: '#519aba', mdx: '#519aba', rst: '#519aba', txt: '#8a8a8a', pdf: '#e5252a',
  sh: '#4eaa25', bash: '#4eaa25', zsh: '#4eaa25', fish: '#4eaa25', ps1: '#012456', bat: '#c1f12e',
  sql: '#e38c00', graphql: '#e10098', gql: '#e10098', proto: '#6a7bbd', tf: '#7b42bc', hcl: '#7b42bc',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', webp: '#a074c4', ico: '#a074c4', svg: '#ffb13b',
  mp4: '#d14d72', mov: '#d14d72', mp3: '#d14d72', wav: '#d14d72', ttf: '#7c8b9c', woff: '#7c8b9c', woff2: '#7c8b9c',
  zip: '#8a6d3b', gz: '#8a6d3b', tar: '#8a6d3b',
};
const NAME_COLORS = {
  dockerfile: '#2496ed', makefile: '#427819', license: '#d4a72c', 'license.md': '#d4a72c', readme: '#519aba',
  '.gitignore': '#f14e32', '.gitattributes': '#f14e32', '.gitmodules': '#f14e32', 'package.json': '#cb3837',
  'cargo.toml': '#dea584', 'go.mod': '#00add8', gemfile: '#cc342d', '.editorconfig': '#8a8a8a',
};

HT.fileColor = function fileColor(name) {
  const lower = name.toLowerCase();
  if (NAME_COLORS[lower]) return NAME_COLORS[lower];
  if (lower.startsWith('readme')) return NAME_COLORS.readme;
  if (lower.startsWith('dockerfile')) return NAME_COLORS.dockerfile;
  const dot = lower.lastIndexOf('.');
  return dot > -1 ? EXT_COLORS[lower.slice(dot + 1)] || null : null;
};

HT.nodeIcon = function nodeIcon(node, open, colored = true) {
  if (node.type === 'tree') return HT.icon(open ? 'folderOpen' : 'folder', 'ht-ic-folder');
  if (node.type === 'commit') return HT.icon('submodule', 'ht-ic-folder');
  const svg = HT.icon('file', 'ht-ic-file');
  const color = colored && HT.fileColor(node.name);
  if (color) svg.style.color = color;
  return svg;
};

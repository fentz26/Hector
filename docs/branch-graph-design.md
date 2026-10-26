# Branch graph design review

Reviewed 2026-10-25. The first graph borrowed host button colors but did not
follow the information density or interaction patterns of a repository sidebar.

## Repositories studied

- [Microsoft VS Code SCM history](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmHistory.ts):
  inspected graph rendering, incoming/outgoing lanes, parent routing, node shapes,
  and the SCM stylesheet. Its 22px history rows and 11px lanes demonstrate how
  little decoration a sidebar graph needs. Hector uses 44px rows because each
  commit includes a second line for refs, author, SHA, and time. Branch lanes
  stay reserved until their pending parent is reached.
- [GitLab repository graph](https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/assets/javascripts/network/branch_graph.js):
  inspected `drawLines`, `drawDot`, reference labels, and keyboard-accessible
  anchors. It routes edges through assigned lanes, aligns metadata with nodes,
  and reveals additional information on hover. Hector keeps native HTML links,
  readable commit titles, and compact refs beside the commit metadata.
- [Octotree's public tree view](https://github.com/ovity/octotree/blob/master/src/view.tree.js):
  inspected its header, whole-row navigation, truncation, lazy loading, and
  selection synchronization. The public repository is an older limited version,
  not the current commercial product. Its useful lesson here is a compact
  navigation surface with a small header, rather than a graph dashboard.
- [Git Graph renderer](https://github.com/mhutchie/vscode-git-graph/blob/master/web/graph.ts):
  inspected its explicit branch paths, grid coordinates, and lane color handling.
  This is a source-available reference; no implementation code was copied.

## Changes made

- Explicit List / Graph selection with a persistent selected state and keyboard focus.
- A branch count in the toolbar; no multi-line instructional block above history.
- Fixed 44px rows, no per-row rules, normal host text colors and restrained hover.
- Readable refs with branch icons instead of tiny outlined pills.
- Monospace short SHAs; full title, author, and date available through native tooltips.
- Straight reserved lanes, short branch bends, distinct graph colors, and hollow merge nodes.
- First-parent continuation prefers the commit's lane instead of a different free lane.
- History limits remain visible in an expandable footer. Partial errors retain retry.

The rendering and layout are original implementations. Existing host theme
sampling supplies text, background, borders, hover, font, and focus colors.
Graph colors encode lanes independently of success/warning UI colors.

## Validation

`node scripts/test-branch-graph.mjs` covers topology, first-parent continuity,
merge lanes, deduplication, API adapters, request concurrency, partial failures,
and stale results. Browser fixtures cover light/dark modes, view switching,
filtering, keyboard focus, and row sizing. Live host-theme checks render a
fixture with colors sampled from public GitHub and GitLab pages; they are not
an authenticated end-to-end extension test.

// Run with node scripts/test-branch-graph.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = vm.createContext({ HT: {} });
for (const file of ['util', 'github', 'gitlab', 'sidebar']) {
  vm.runInContext(fs.readFileSync(new URL(`../src/content/${file}.js`, import.meta.url), 'utf8'), ctx);
}
const commits = [
  { sha: 'merge', parents: ['left', 'right'], date: '2020-01-01' },
  { sha: 'left', parents: ['base'], date: '2021-01-01' },
  { sha: 'right', parents: ['base'], date: '2022-01-01' },
  { sha: 'base', parents: ['outside'] },
];
const rows = ctx.HT.layoutBranchGraph(commits);
const at = new Map(rows.map((r, i) => [r.commit.sha, i]));
assert.equal(rows.length, 4);
for (const c of commits) for (const p of c.parents) if (at.has(p)) assert.ok(at.get(c.sha) < at.get(p));
assert.notEqual(rows.find((r) => r.commit.sha === 'left').lane, rows.find((r) => r.commit.sha === 'right').lane);
assert.equal(ctx.HT.layoutBranchGraph([...commits, commits[0]]).length, 4);
assert.equal(ctx.HT.layoutBranchGraph([]).length, 0);
// A finished lane to the left must not pull another branch's first parent over.
const continuity = ctx.HT.layoutBranchGraph([
  { sha: 'tip', parents: ['short', 'long'] },
  { sha: 'short', parents: [], date: '2025-01-02' },
  { sha: 'long', parents: ['ancestor'], date: '2025-01-01' },
  { sha: 'ancestor', parents: [] },
]);
assert.equal(continuity.find((r) => r.commit.sha === 'long').lane,
  continuity.find((r) => r.commit.sha === 'ancestor').lane);
for (const row of rows) for (const parent of row.commit.parents || []) {
  if (!at.has(parent)) continue;
  const target = rows[at.get(parent)];
  assert.ok(rows.slice(at.get(row.commit.sha) + 1, at.get(parent)).every((r) => r.lane !== target.lane),
    'A reserved parent lane cannot contain an unrelated commit');
}

ctx.HT.api = { request: async () => ({ data: [{ sha: 'a', parents: [{ sha: 'b' }], commit: {} }] }) };
assert.equal((await ctx.HT.providers.github.commits({ owner: 'o', repo: 'r' }, 'main', 1)).items[0].parents[0], 'b');
ctx.HT.api.request = async () => ({ data: [{ id: 'a', parent_ids: ['b'] }] });
assert.equal((await ctx.HT.providers.gitlab.commits({ projectId: 1 }, 'main', 1)).items[0].parents[0], 'b');
let active = 0, peak = 0, refreshes = 0;
ctx.HT.provider = { commits: async (_, ref) => {
  active++; peak = Math.max(peak, active);
  await new Promise((r) => setTimeout(r, 2));
  active--;
  if (ref === 'bad') throw new Error('denied');
  return { items: commits };
} };
const graph = { commits: [], errors: [], loading: true };
const st = { graph };
const sidebar = Object.assign(Object.create(ctx.HT.Sidebar.prototype), {
  ctx: {}, branches: st, _refreshTab() { refreshes++; },
});
await sidebar._loadBranchGraph(st, graph, ['a', 'bad', 'b'].map((name) => ({ name })));
assert.equal(peak, 2);
assert.equal(graph.commits.length, 4);
assert.equal(graph.errors[0], 'bad');
assert.equal(graph.loading, false);
assert.equal(refreshes, 1);
const stale = { commits: [], errors: [], loading: true };
st.graph = stale;
const pending = sidebar._loadBranchGraph(st, stale, [{ name: 'a' }]);
st.graph = {};
await pending;
assert.equal(stale.loading, true);
assert.equal(refreshes, 1);
console.log('Branch graph checks passed: topology, lanes, deduplication, adapters, concurrency, partial errors, stale loads.');

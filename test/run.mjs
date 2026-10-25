// Unit tests for the pure parts of Hector: matching, ANSI, log parsers,
// bookmark/backup cleaning and the tree cache guard. No browser needed:
//   node test/run.mjs
// The content scripts are loaded into one VM context with a tiny `chrome`
// stand-in, the way wasm/test/parity.mjs does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- a browser-ish context ----
const stores = { local: {}, sync: {} };
const area = (name) => ({
  async get(keys) {
    const all = stores[name];
    if (keys == null) return { ...all };
    if (typeof keys === 'string') return keys in all ? { [keys]: all[keys] } : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
    return { ...keys, ...Object.fromEntries(Object.keys(keys).filter((k) => k in all).map((k) => [k, all[k]])) };
  },
  async set(items) {
    Object.assign(stores[name], structuredClone(items));
  },
  async remove(keys) {
    for (const k of [].concat(keys)) delete stores[name][k];
  },
  async clear() {
    stores[name] = {};
  },
});
const ctx = {
  console,
  performance,
  setTimeout,
  clearTimeout,
  URL,
  TextEncoder,
  TextDecoder,
  crypto: globalThis.crypto,
  btoa,
  atob,
  structuredClone,
  Node: class {},
  document: { body: { dataset: {} }, createElement: () => ({ style: {} }) },
  navigator: {},
  location: { host: 'github.com', origin: 'https://github.com', href: 'https://github.com/' },
  chrome: {
    storage: { local: area('local'), sync: area('sync'), onChanged: { addListener() {} } },
    runtime: { getManifest: () => ({ host_permissions: [] }) },
    permissions: { contains: async () => true, getAll: async () => ({ origins: [] }), remove: async () => {} },
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['content/util.js', 'content/storage.js', 'content/api.js', 'content/tree.js', 'content/github.js', 'content/gitlab.js', 'content/teamcity.js', 'options/backup.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'src', f), 'utf8'), ctx, { filename: f });
}
const { HT } = ctx;

// Values made inside the VM have that realm's prototypes, so compare by shape.
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n  ${err.message.split('\n').join('\n  ')}`);
  }
}

// ---- fuzzy matching ----
await test('fuzzy prefers a substring in the file name', () => {
  const inName = HT.fuzzy('main', 'src/main.rs');
  const inDir = HT.fuzzy('main', 'main/other.rs');
  assert.ok(inName.score > inDir.score);
  same(inName.indices, [4, 5, 6, 7]);
});
await test('fuzzy falls back to a subsequence and rejects misses', () => {
  assert.ok(HT.fuzzy('gprs', 'crates/engine/src/gpu_offscreen.rs'));
  assert.equal(HT.fuzzy('zzq', 'src/main.rs'), null);
});
await test('fuzzy gives the same answer with a pre-lowered text', () => {
  const t = 'Engine/Source/Programs/xtask/src/Main.RS';
  same(HT.fuzzy('main.rs', t), HT.fuzzy('main.rs', t, t.toLowerCase()));
});

// ---- ANSI ----
await test('ansi splits SGR codes into styled segments', () => {
  const segs = HT.ansi('a \x1b[1;31mred\x1b[0m \x1b[38;5;196mx\x1b[38;2;1;2;3my');
  same(segs.map((s) => s.text), ['a ', 'red', ' ', 'x', 'y']);
  assert.equal(segs[1].fg, 1);
  assert.equal(segs[1].bold, true);
  assert.equal(segs[3].fg, 'rgb(255, 0, 0)');
  assert.equal(segs[4].fg, 'rgb(1, 2, 3)');
});
await test('ansi drops cursor escapes', () => {
  assert.equal(HT.ansi('\x1b[2Kline\x1b[1A').map((s) => s.text).join(''), 'line');
  assert.equal(HT.stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

// ---- bookmarks ----
await test('cleanBookmarks keeps https links with known fields only', () => {
  const out = HT.cleanBookmarks([
    { url: 'https://github.com/a/b', title: 'ok', kind: 'repo', extra: 1 },
    { url: 'http://github.com/a/b', title: 'plain http' },
    { url: 'javascript:alert(1)', title: 'xss' },
    { url: 'https://github.com/a/b/blob/main/x', title: 'file', kind: 'weird' },
    { title: 'no url' },
  ]);
  assert.equal(out.length, 2);
  same(Object.keys(out[0]).sort(), ['added', 'host', 'kind', 'ref', 'repo', 'title', 'url']);
  assert.equal(out[1].kind, 'file');
  assert.equal(out[0].host, 'github.com');
});

// ---- TeamCity helpers ----
await test('teamcityLink reads the three link shapes', () => {
  same(HT.teamcityLink('https://tc.example.com/viewLog.html?buildId=42&buildTypeId=P_B'), { server: 'https://tc.example.com', buildId: '42', buildTypeId: 'P_B' });
  same(HT.teamcityLink('https://tc.example.com/buildConfiguration/P_B/43'), { server: 'https://tc.example.com', buildId: '43', buildTypeId: 'P_B' });
  same(HT.teamcityLink('https://tc.example.com/build/44'), { server: 'https://tc.example.com', buildId: '44' });
  assert.equal(HT.teamcityLink('https://ci.example.com/job/x/1'), null);
});
await test('teamcityIds accepts IDs and rejects locator injection', () => {
  assert.equal(HT.teamcityIds(' Proj_Build , Other.Cfg-2 '), 'Proj_Build,Other.Cfg-2');
  assert.equal(HT.teamcityIds('X),count:1000,foo:('), '');
  assert.equal(HT.teamcityIds(''), '');
  assert.equal(HT.teamcityIds(Array.from({ length: 21 }, (_, i) => `a${i}`).join(',')), '');
});
await test('parseConfig reads teamcity.toml and ignores a bad job id', () => {
  const toml = `# ci\n[[server]]\nurl = 'https://tc.example.com/'\nproject = "Proj"\njob = 'Proj_Build'\n[[server]]\nurl='https://other'\n`;
  same(HT.teamcity.parseConfig(toml), { url: 'https://tc.example.com', buildType: 'Proj_Build' });
  same(HT.teamcity.parseConfig(`[[server]]\nurl = 'https://tc.example.com'\njob = 'x),y:('`), { url: 'https://tc.example.com', buildType: '' });
  assert.equal(HT.teamcity.parseConfig('nothing here'), null);
  assert.equal(HT.teamcity.parseConfig(`[[server]]\nurl = 'ftp://tc'`), null);
});

// ---- log parsers ----
await test('github steps splits a log between steps by time', () => {
  const job = {
    steps: [
      { number: 1, name: 'Set up job', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:05Z' },
      { number: 2, name: 'Run tests', started_at: '2026-01-01T00:00:05Z', completed_at: '2026-01-01T00:00:09Z' },
    ],
  };
  const text = ['2026-01-01T00:00:01.0Z setup line', '2026-01-01T00:00:05.0Z ##[group]Run npm test', '2026-01-01T00:00:06.0Z ok', ''].join('\n');
  const { byStep } = HT.providers.github.steps(job, text);
  same(byStep.get(1), ['setup line']);
  same(byStep.get(2), ['##[group]Run npm test', 'ok']);
});
await test('gitlab steps come from section markers', () => {
  const text = [
    'section_start:1700000000:prepare_executor\r\x1b[0KPreparing the "docker" executor',
    'Using Docker',
    'section_end:1700000003:prepare_executor\r\x1b[0K',
    'section_start:1700000003:step_script\r\x1b[0KExecuting "step_script" stage',
    'section_start:1700000004:inner\r\x1b[0KInner title',
    'nested output',
    'section_end:1700000005:inner\r\x1b[0K',
    'ERROR: Job failed: exit code 1',
    'section_end:1700000006:step_script\r\x1b[0K',
  ].join('\n');
  const { steps, byStep } = HT.providers.gitlab.steps({ status: 'completed', conclusion: 'failure' }, text);
  same(steps.map((s) => s.name), ['Preparing the "docker" executor', 'Executing "step_script" stage']);
  assert.equal(steps[1].conclusion, 'failure');
  assert.equal(steps[0].conclusion, 'success');
  same(byStep.get(2), ['##[group]Inner title', 'nested output', '##[endgroup]', 'ERROR: Job failed: exit code 1']);
});
await test('teamcity steps fold nested blocks', () => {
  const text = ['[10:00:00]i: Collecting changes (1s)', '[10:00:01]i: Step 1/2: Build (3s)', '[10:00:01]i:\t [Step 1/2] Starting', '[10:00:02]W:\t [Step 1/2] warning here', '[10:00:04]E: Step 2/2: Test (1s)', '[10:00:04]i:\t [Step 2/2] failed'].join(
    '\n'
  );
  const { steps, byStep } = HT.teamcity.steps({ status: 'completed' }, text);
  same(steps.map((s) => [s.name, s.conclusion, s.duration]), [['Collecting changes', 'success', 1000], ['Step 1/2: Build', 'success', 3000], ['Step 2/2: Test', 'failure', 1000]]);
  same(byStep.get(2), ['Starting', '\x1b[33mwarning here\x1b[0m']);
});

// ---- ref resolution ----
await test('resolveRef picks the longest branch that matches the path', async () => {
  const lookup = async () => ['feature', 'feature/x'];
  same(await HT.api.resolveRef(['feature', 'x', 'src', 'a.js'], [], lookup), { ref: 'feature/x', path: 'src/a.js' });
  same(await HT.api.resolveRef(['main', 'README.md'], ['main'], lookup), { ref: 'main', path: 'README.md' });
  same(await HT.api.resolveRef(['a'.repeat(40)], [], lookup), { ref: 'a'.repeat(40), path: '' });
});

// ---- tree cache guard ----
await test('cache.tooBig answers from the row count without serializing', () => {
  const big = { entries: Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}` })) };
  const stringify = ctx.JSON?.stringify;
  const J = vm.runInContext('JSON', ctx);
  const orig = J.stringify;
  J.stringify = () => {
    throw new Error('should not serialize');
  };
  try {
    assert.equal(HT.cache.tooBig(big), true);
  } finally {
    J.stringify = orig;
  }
  assert.equal(HT.cache.tooBig({ entries: [{ path: 'a' }] }), false);
  void stringify;
});

// ---- backup ----
await test('backup keeps every tab and round-trips encrypted tokens', async () => {
  stores.sync = {
    tabOrder: ['ci', 'commits', 'branches', 'files', 'changes', 'bookmarks', 'settings'],
    hiddenTabs: ['branches'],
    width: 5000,
    theme: 'purple',
    enterpriseHosts: ['git.example.com', 'http://gl.local:8080'],
    'ci:github.com/a/b': { teamcity: { server: 'https://tc.example.com', ids: 'P_B' } },
    'ci:github.com/a/c': { teamcity: { server: 'https://tc.example.com', ids: 'x),y:(' }, native: false },
  };
  stores.local = { tokens: { 'github.com': 'ghp_x', 'tc:tc.example.com': 'tc_y', 'bad host!': 'z' }, bookmarks: [{ url: 'https://github.com/a/b', title: 'b' }] };
  const file = await HT.backup.build({ bookmarks: true, tokens: true, passphrase: 'correct horse' });
  same(file.settings.tabOrder, stores.sync.tabOrder);
  same(file.settings.hiddenTabs, ['branches']);
  assert.equal(file.settings.width, 800);
  assert.equal('theme' in file.settings, false);
  same(file.selfHosted, ['git.example.com', 'http://gl.local:8080']);
  same(file.repos['github.com/a/b'], { teamcity: { server: 'https://tc.example.com', ids: 'P_B' } });
  same(file.repos['github.com/a/c'], { native: false, teamcity: { server: 'https://tc.example.com' } });
  assert.equal(file.tokens.cipher, 'AES-GCM');
  assert.equal(JSON.stringify(file).includes('ghp_x'), false);

  const { counts, hasTokens } = HT.backup.inspect(JSON.stringify(file));
  assert.equal(hasTokens, true);
  same(counts, { settings: 3, selfHosted: 2, repos: 2, bookmarks: 1 });

  stores.sync = {};
  stores.local = {};
  await assert.rejects(HT.backup.restore(file, 'wrong'), /Wrong passphrase/);
  const missing = await HT.backup.restore(file, 'correct horse');
  same(stores.local.tokens, { 'github.com': 'ghp_x', 'tc:tc.example.com': 'tc_y' });
  same(stores.sync.tabOrder, file.settings.tabOrder);
  same(stores.sync.enterpriseHosts, ['git.example.com', 'http://gl.local:8080']);
  same(missing, []);
});

console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} tests passed`);
process.exit(failed ? 1 : 0);

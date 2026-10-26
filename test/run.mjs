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
  URLSearchParams,
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
for (const f of ['content/util.js', 'content/storage.js', 'content/url.js', 'content/api.js', 'content/tree.js', 'content/github.js', 'content/gitlab.js', 'content/bitbucket.js', 'content/bitbucket_server.js', 'content/ci.js', 'content/teamcity.js', 'content/jenkins.js', 'content/customci.js', 'options/backup.js']) {
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
  stores.local = { tokens: { 'github.com': 'ghp_x', 'ci:tc.example.com': 'tc_y', 'bad host!': 'z' }, bookmarks: [{ url: 'https://github.com/a/b', title: 'b' }] };
  const file = await HT.backup.build({ bookmarks: true, tokens: true, passphrase: 'correct horse' });
  // An old saved order may still list 'settings', which is no longer a tab.
  same(file.settings.tabOrder, stores.sync.tabOrder.filter((t) => t !== 'settings'));
  same(file.settings.hiddenTabs, ['branches']);
  assert.equal(file.settings.width, 800);
  assert.equal('theme' in file.settings, false);
  same(file.selfHosted, ['git.example.com', 'http://gl.local:8080']);
  // Older settings (one `teamcity`) come out as a source list; a bad ID drops that source.
  same(file.repos['github.com/a/b'], { sources: [{ type: 'teamcity', server: 'https://tc.example.com', ids: 'P_B' }] });
  same(file.repos['github.com/a/c'], { native: false });
  assert.equal(file.tokens.cipher, 'AES-GCM');
  assert.equal(JSON.stringify(file).includes('ghp_x'), false);

  const { counts, hasTokens } = HT.backup.inspect(JSON.stringify(file));
  assert.equal(hasTokens, true);
  same(counts, { settings: 3, selfHosted: 2, repos: 2, bookmarks: 1 });

  stores.sync = {};
  stores.local = {};
  await assert.rejects(HT.backup.restore(file, 'wrong'), /Wrong passphrase/);
  const missing = await HT.backup.restore(file, 'correct horse');
  same(stores.local.tokens, { 'github.com': 'ghp_x', 'ci:tc.example.com': 'tc_y' });
  same(stores.sync.tabOrder, file.settings.tabOrder);
  same(stores.sync.enterpriseHosts, ['git.example.com', 'http://gl.local:8080']);
  same(missing, []);
});


// ---- external CI sources ----
await test('ci.sources normalizes old and new settings and drops bad ones', () => {
  same(HT.ci.sources({ teamcity: { server: 'tc.example.com/', ids: ' A , B ' } }), [{ type: 'teamcity', server: 'https://tc.example.com', ids: 'A,B' }]);
  const list = HT.ci.sources({
    sources: [
      { type: 'jenkins', server: 'https://ci.example.com/', ids: 'folder/job, multi' },
      { type: 'custom', server: 'https://api.example.com/builds?sha={sha}&repo={owner}/{repo}', name: 'My CI' },
      { type: 'custom', server: 'ftp://nope' },
      { type: 'teamcity', server: 'https://tc.example.com', ids: 'x),y:(' },
      { type: 'other', server: 'https://x' },
      'junk',
    ],
  });
  same(list, [
    { type: 'jenkins', server: 'https://ci.example.com', ids: 'folder/job,multi' },
    { type: 'custom', server: 'https://api.example.com/builds?sha={sha}&repo={owner}/{repo}', name: 'My CI' },
  ]);
  assert.equal(HT.ci.cleanIds('jenkins', 'a/b, c d'), 'a/b,c d');
  assert.equal(HT.ci.cleanIds('jenkins', '../x'), '');
  assert.equal(HT.ci.fill('https://x/b?sha={sha}&ref={ref}&z={unknown}', { sha: 'abc', ref: 'feat/x' }), 'https://x/b?sha=abc&ref=feat%2Fx&z={unknown}');
  assert.equal(HT.ci.label({ type: 'custom', server: 'https://api.example.com/x' }), 'api.example.com');
  assert.equal(HT.ci.sourceKey({ type: 'jenkins', server: 'https://ci.example.com' }), 'ext:jenkins:https://ci.example.com');
});

await test('jenkins links, multibranch builds and pipeline stages', async () => {
  same(HT.jenkins.linkFor('https://ci.example.com/job/team/job/app/42/display/redirect'), { server: 'https://ci.example.com', job: 'team/app', buildId: '42' });
  assert.equal(HT.jenkins.linkFor('https://ci.example.com/view/all/'), null);
  // A fake Jenkins behind the message channel: a multibranch job with two branches.
  const calls = [];
  const sent = HT.api.send;
  HT.api.send = async (msg) => {
    calls.push(msg);
    if (msg.type === 'ci:access') return { granted: true, hasToken: false };
    const p = msg.path;
    if (p.startsWith('/job/app/api/json')) return { ok: true, data: { jobs: [{ name: 'main' }, { name: 'feature%2Fx' }] } };
    if (p.startsWith('/job/app/job/feature%252Fx/api/json')) {
      return { ok: true, data: { builds: [{ number: 7, result: 'FAILURE', building: false, timestamp: 1700000000000, duration: 65000, url: 'https://ci.example.com/job/app/job/feature%252Fx/7/', actions: [{}, { lastBuiltRevision: { SHA1: 'abc' } }] }] } };
    }
    if (p.endsWith('/7/consoleText')) return { ok: true, data: 'Started by user x\n[Pipeline] { (Build)\nmake\n[Pipeline] {\ninner\n[Pipeline] }\n[Pipeline] }\n[Pipeline] { (Test)\nERROR: tests failed\n[Pipeline] }\nFinished: FAILURE\n' };
    return { ok: false, status: 404, data: { message: 'nope' } };
  };
  try {
    const source = { type: 'jenkins', server: 'https://ci.example.com', ids: 'app' };
    const res = await HT.jenkins.load({ source, target: { ref: 'feature/x', label: 'feature/x' }, limit: 10, recentShas: async () => [], statuses: async () => [] });
    assert.equal(res.builds.length, 1);
    const b = res.builds[0];
    same([b.ci, b.id, b.name, b.run_number, b.status, b.conclusion, b.sha, b.duration], ['jenkins', 'app/feature/x#7', 'app/feature/x', 7, 'completed', 'failure', 'abc', 65000]);
    assert.ok(calls.every((c) => c.type !== 'ci' || (c.ci === 'jenkins' && c.server === 'https://ci.example.com')));
    const text = await HT.jenkins.log(null, b);
    const { steps, byStep } = HT.jenkins.steps(b, text);
    same(steps.map((s) => [s.name, s.conclusion]), [['Console output', 'success'], ['Build', 'success'], ['Test', 'failure']]);
    same(byStep.get(2), ['make', '##[group][Pipeline] {', 'inner', '##[endgroup]', '[Pipeline] }']);
  } finally {
    HT.api.send = sent;
  }
});

await test('custom endpoint builds, statuses and logs', async () => {
  const sent = HT.api.send;
  const seen = [];
  HT.api.send = async (msg) => {
    seen.push(msg);
    if (msg.path.startsWith('/builds?')) {
      return {
        ok: true,
        data: {
          builds: [
            { id: 9, name: 'unit', state: 'running', url: 'https://ci.example.com/b/9', started_at: '2026-01-01T00:00:00Z' },
            { id: 8, name: 'lint', result: 'UNSTABLE', url: 'javascript:alert(1)', log_url: 'https://ci.example.com/b/8/log', steps: [{ name: 'install', status: 'passed', log: 'a\nb' }, { name: 'lint', status: 'failed' }] },
            { id: 7, name: 'deploy', status: 'passed', log: 'inline log' },
            null,
          ],
        },
      };
    }
    if (msg.path === '/b/8/log') return { ok: true, data: 'remote log\nline 2' };
    return { ok: false, status: 404, data: {} };
  };
  try {
    const source = { type: 'custom', server: 'https://ci.example.com/builds?sha={sha}&repo={owner}/{repo}', name: 'Acme CI' };
    const res = await HT.customCI.load({ source, target: { sha: 'abc', label: 'abc' }, limit: 10, repo: { owner: 'o', repo: 'r' }, recentShas: async () => [] });
    assert.equal(seen[0].path, '/builds?sha=abc&repo=o/r'); // a literal "/" between placeholders stays
    assert.equal(seen[0].server, 'https://ci.example.com');
    same(res.builds.map((b) => [b.name, b.status, b.conclusion, b.html_url]), [['unit', 'in_progress', null, 'https://ci.example.com/b/9'], ['lint', 'completed', 'allowed_failure', null], ['deploy', 'completed', 'success', null]]);
    assert.equal(await HT.customCI.log(null, res.builds[2]), 'inline log');
    const lint = res.builds[1];
    const text = await HT.customCI.log(null, lint);
    assert.equal(text, 'a\nb\n'); // the steps' logs, joined; a step without one is an empty line
    const { steps, byStep } = HT.customCI.steps(lint, text);
    same(steps.map((s) => [s.name, s.conclusion]), [['install', 'success'], ['lint', 'failure']]);
    same(byStep.get(1), ['a', 'b']);
  } finally {
    HT.api.send = sent;
  }
});


// ---- Bitbucket ----
await test('bitbucket parse reads repository, file, branch and pull request pages', () => {
  const bb = HT.providers.bitbucket;
  const at = (pathname, search = '') => bb.parse({ host: 'bitbucket.org', origin: 'https://bitbucket.org', pathname, search });
  same(at('/atlassian/aui/src/master/packages/core/'), { host: 'bitbucket.org', origin: 'https://bitbucket.org', owner: 'atlassian', repo: 'aui', kind: 'tree', segments: ['master', 'packages', 'core'], at: null });
  same(at('/atlassian/aui/src/95b1801e7fbc/README.md', '?at=feature%2Fx').at, 'feature/x');
  same(at('/atlassian/aui/pull-requests/5474/diff').pullNumber, 5474);
  same(at('/atlassian/aui/').kind, 'repo');
  assert.equal(at('/atlassian/workspace/overview/'), null);
  assert.equal(at('/account/settings/'), null);
  assert.equal(at('/dashboard/overview'), null);
  assert.equal(bb.compareUrl({ origin: 'https://bitbucket.org', owner: 'a', repo: 'b' }, 'main', 'feat/x'), 'https://bitbucket.org/a/b/branches/compare/feat%2Fx%0Dmain');
});
await test('bitbucket resolves ?at= branches without a lookup and maps statuses', async () => {
  const bb = HT.providers.bitbucket;
  const ctx = { host: 'bitbucket.org', origin: 'https://bitbucket.org', owner: 'a', repo: 'b', at: 'feature/x' };
  same(await bb.resolveRef(ctx, ['95b1801e7fbc', 'src', 'index.js'], []), { ref: 'feature/x', path: 'src/index.js' });
  assert.ok(bb.codeUrl(ctx, 'feature/x', 'src/index.js', false).endsWith('/src/95b1801e7fbc/src/index.js?at=feature%2Fx'));
  const sent = HT.api.request;
  HT.api.request = async (path) => {
    if (path.includes('/statuses')) {
      return {
        data: {
          values: [
            { key: 'bamboo-1', name: 'Bamboo build', state: 'SUCCESSFUL', url: 'https://bamboo.example.com/browse/X-1', created_on: '2026-01-01T00:00:00Z', updated_on: '2026-01-01T00:05:00Z' },
            { key: 'p', name: 'own', state: 'INPROGRESS', url: 'https://bitbucket.org/a/b/addon/pipelines/home#!/results/1' },
            { key: 'j', name: 'Jenkins', state: 'FAILED', url: 'https://jenkins.example.com/job/x/3/' },
          ],
        },
      };
    }
    throw new Error(`unexpected ${path}`);
  };
  try {
    const jobs = await bb.externalStatuses(ctx, 'abc');
    same(jobs.map((j) => [j.name, j.status, j.conclusion, j.ci]), [['Bamboo build', 'completed', 'success', 'Bamboo'], ['Jenkins', 'completed', 'failure', 'Jenkins']]);
  } finally {
    HT.api.request = sent;
  }
});
await test('bitbucket splits a step log by its echoed commands', () => {
  const bb = HT.providers.bitbucket;
  const text = 'Cloning into…\n+ npm ci\nadded 10 packages\n+ npm test\n1 failing\n';
  const { steps, byStep } = bb.steps({ status: 'completed', conclusion: 'failure' }, text);
  same(steps.map((s) => [s.name, s.conclusion]), [['Setup', 'success'], ['npm ci', 'success'], ['npm test', 'failure']]);
  same(byStep.get(3), ['+ npm test', '1 failing']);
});

await test('bitbucket server pages: context path, personal repos, refs in ?at=', () => {
  const p = HT.providers.bitbucketServer;
  const at = (href) => JSON.parse(JSON.stringify(p.parse(new URL(href))));
  const a = at('https://git.example/projects/KEY/repos/app/browse/src/main.py?at=refs%2Fheads%2Ffeature%2Fx');
  same([a.contextPath, a.owner, a.repo, a.kind, a.at, a.segments], ['', 'KEY', 'app', 'tree', 'feature/x', ['src', 'main.py']]);
  const b = at('https://host.example/code/users/jo/repos/notes/pull-requests/12/diff');
  same([b.contextPath, b.owner, b.kind, b.pullNumber], ['/code', '~jo', 'pull', 12]);
  assert.equal(p.base(b), 'https://host.example/code/users/jo/repos/notes');
  assert.equal(p._path(b), '/code/rest/api/1.0/projects/~jo/repos/notes');
  assert.equal(at('https://git.example/projects/KEY/repos/app/browse').kind, 'repo');
  assert.equal(p.parse(new URL('https://git.example/projects/KEY')), null);
  assert.equal(p.parse(new URL('https://git.example/dashboard')), null);
  assert.equal(p.codeUrl(a, 'feature/x', 'src/main.py'), 'https://git.example/projects/KEY/repos/app/browse/src/main.py?at=refs%2Fheads%2Ffeature%2Fx');
  assert.equal(p.codeUrl(a, 'refs/tags/v1', ''), 'https://git.example/projects/KEY/repos/app/browse?at=refs%2Ftags%2Fv1');
});

await test('bitbucket server tree, pull request files and build statuses', async () => {
  const p = HT.providers.bitbucketServer;
  const ctx = p.parse(new URL('https://git.example/projects/K/repos/r/browse'));
  const request = HT.api.request;
  const paths = [];
  const answers = [
    [/\/files\?at=main&limit=1000&start=0$/, { values: ['a.txt', 'src/b.js'], isLastPage: false, nextPageStart: 2 }],
    [/\/files\?at=main&limit=1000&start=2$/, { values: ['src/deep/c.md'], isLastPage: true }],
    [/\/pull-requests\/7\/changes/, { values: [{ path: { toString: 'x.js' }, type: 'ADD' }, { path: { toString: 'new.js' }, srcPath: { toString: 'old.js' }, type: 'MOVE' }], isLastPage: true }],
    [/build-status\/1\.0\/commits\/abc/, { values: [{ key: 'J1', name: 'Jenkins build', state: 'FAILED', url: 'https://ci.example/1', dateAdded: 0 }, { key: 'X', state: 'INPROGRESS', url: 'javascript:alert(1)' }], isLastPage: true }],
  ];
  HT.api.request = async (path) => {
    paths.push(path);
    const hit = answers.find(([re]) => re.test(path));
    if (!hit) throw Object.assign(new Error(`unexpected ${path}`), { status: 404 });
    return { data: hit[1] };
  };
  HT.api.clearMemo();
  try {
    const t = await p.tree(ctx, 'main');
    same([t.complete, t.entries.map((e) => e.path)], [true, ['a.txt', 'src/b.js', 'src/deep/c.md']]);
    const files = await p.pullFiles(ctx, 7);
    same(files.map((f) => [f.status, f.path, f.previous || null]), [['added', 'x.js', null], ['renamed', 'new.js', 'old.js']]);
    const st = await p.externalStatuses(ctx, 'abc');
    same(st.map((s) => [s.name, s.status, s.conclusion, s.html_url]), [['Jenkins build', 'completed', 'failure', 'https://ci.example/1'], ['X', 'in_progress', null, null]]);
  } finally {
    HT.api.request = request;
  }
});

// ---- background worker: CI request guard ----
await test('ci requests stay on the CI API after the browser resolves dot segments', async () => {
  const fetched = [];
  const listen = { addListener() {} };
  const bgStores = {
    local: { tokens: { 'ci:jenkins.example': 'me:pässword' } },
    sync: { enterpriseHosts: ['bbs.example'], 'ci:github.com/o/r': { sources: [{ type: 'teamcity', server: 'https://tc.example' }, { type: 'jenkins', server: 'https://jenkins.example' }] } },
  };
  const bgArea = (name) => ({ async get(keys) { const all = bgStores[name]; return keys == null ? { ...all } : Object.fromEntries([].concat(keys).filter((k) => k in all).map((k) => [k, all[k]])); }, async set(items) { Object.assign(bgStores[name], items); } });
  const bg = {
    console, URL, TextEncoder, btoa, setTimeout, clearTimeout,
    fetch: async (url, init) => (fetched.push({ url, auth: init.headers.Authorization }), new Response('{}', { status: 200 })),
    chrome: {
      runtime: { id: 'x', getURL: (p) => `ext://x/${p}`, onMessage: listen, onInstalled: listen, onStartup: listen },
      storage: { local: bgArea('local'), sync: bgArea('sync'), onChanged: listen },
      permissions: { contains: async () => true, onAdded: listen, onRemoved: listen },
      tabs: { onRemoved: listen }, action: { onClicked: listen }, commands: { onCommand: listen },
    },
  };
  vm.createContext(bg);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/background.js'), 'utf8'), bg, { filename: 'background.js' });
  const ask = (ci, server, p) => bg.ciRequest({ ci, server, path: p });
  for (const p of ['/app/rest/../../admin/admin.html', '/app/rest/%2e%2e/%2E%2E/login.html', '/app/rest/./server']) {
    assert.equal((await ask('teamcity', 'https://tc.example', p)).error, 'Request blocked.', p);
  }
  for (const p of ['/job/../job/../api/json', '/job/%2e%2e/1/consoleText']) {
    assert.equal((await ask('jenkins', 'https://jenkins.example', p)).error, 'Request blocked.', p);
  }
  for (const p of ['/rest/api/1.0/../../admin', '/admin/users', '/code/rest/api/1.0/%2E%2E/x', '/plugins/servlet/other']) {
    assert.equal((await bg.apiRequest({ host: 'bbs.example', provider: 'bitbucket-server', path: p })).error, 'Request blocked.', p);
  }
  assert.equal(fetched.length, 0);
  assert.equal((await bg.apiRequest({ host: 'bbs.example', provider: 'bitbucket-server', path: '/code/rest/api/1.0/projects/K/repos/r/files?at=main' })).ok, true);
  assert.equal(fetched.pop().url, 'https://bbs.example/code/rest/api/1.0/projects/K/repos/r/files?at=main');
  assert.equal((await ask('teamcity', 'https://tc.example', '/app/rest/server?fields=version')).ok, true);
  assert.equal((await ask('jenkins', 'https://jenkins.example', '/job/a%20b/api/json?tree=builds[number]{0,5}')).ok, true);
  same(fetched.map((f) => f.url), ['https://tc.example/app/rest/server?fields=version', 'https://jenkins.example/job/a%20b/api/json?tree=builds[number]{0,5}']);
  // A non-Latin-1 user:token is sent as UTF-8 Basic instead of throwing.
  assert.equal(fetched[1].auth, `Basic ${Buffer.from('me:pässword').toString('base64')}`);
});


console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} tests passed`);
process.exit(failed ? 1 : 0);

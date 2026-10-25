// Checks the WASM matcher against HT.fuzzy (src/content/tree.js): same matches,
// same order, same highlight positions. Then times both.
//   node wasm/test/parity.mjs path/to/hector_core.wasm [paths.txt]
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = path.join(here, '../../src/content/');
const ctx = { console, performance, document: {}, navigator: {}, chrome: {}, location: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['util.js', 'tree.js']) vm.runInContext(fs.readFileSync(content + f, 'utf8'), ctx);
const { HT } = ctx;

const wasmFile = process.argv[2];
const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmFile), {});
const w = instance.exports;
const enc = new TextEncoder();
const put = (text) => {
  const bytes = enc.encode(text);
  const ptr = w.alloc(bytes.length);
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
};
let handle = 0;
const index = (paths) => { const [p, n] = put(paths.join('\n')); if (handle) w.free(handle); handle = w.load(p, n); w.dealloc(p, n); };
const search = (query, limit = 300) => {
  const [p, n] = put(query);
  const words = w.search(handle, p, n, limit);
  w.dealloc(p, n);
  const out = new Uint32Array(w.memory.buffer, w.out_ptr(), words);
  const total = out[0], k = out[1], results = [];
  for (let o = 2, r = 0; r < k; r++) { const cnt = out[o + 1]; results.push({ i: out[o], indices: Array.from(out.subarray(o + 2, o + 2 + cnt)) }); o += 2 + cnt; }
  return { total, results };
};
const js = (paths, query, limit = 300) => {
  const hits = [];
  paths.forEach((p, i) => { const m = HT.fuzzy(query, p); if (m) hits.push({ i, ...m }); });
  hits.sort((a, b) => b.score - a.score); // stable, like the tree's filter
  return { total: hits.length, results: hits.slice(0, limit).map(({ i, indices }) => ({ i, indices })) };
};

const base = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean) : [];
const synthetic = ['src/main.rs', 'src/lib/Parser.ts', 'README.md', 'docs/Guía/ñandú.md', 'crates/engine/src/gpu_offscreen.rs', 'ünïcode/Ünïcode_Test.rs',
  'emoji/😀/smile.txt', 'Engine/Source/Programs/xtask/src/main.rs', 'a b/c d/e f.txt', 'K/Kelvin.txt', 'src/İstanbul.rs', 'x/x/x/x/x.x'];
const paths = [...base, ...synthetic];
const queries = ['main', 'gprs', 'zzq', 'Main.RS', 'src main', 'ñand', 'unicode', 'smile', 'gpu off', 'e f', 'k', 'ist', '😀', 'x.x', 'rs', 'ed', 'xtask', 'evidence'];

let bad = 0;
index(paths);
for (const q of queries) {
  const a = js(paths, q), b = search(q);
  const same = a.total === b.total && JSON.stringify(a.results) === JSON.stringify(b.results);
  if (!same) { bad++; console.log(`MISMATCH "${q}": js total ${a.total}, wasm total ${b.total}`, JSON.stringify(a.results.slice(0, 2)), JSON.stringify(b.results.slice(0, 2))); }
}
console.log(bad ? `${bad} of ${queries.length} queries differ` : `parity: all ${queries.length} queries identical (${paths.length} paths)`);

if (process.argv[3]) {
  const scale = (n) => { const out = []; for (let i = 0; out.length < n; i++) for (const p of base) { if (out.length >= n) break; out.push(i ? `pkg${i % 97}/mod${i}/${p}` : p); } return out; };
  const time = (fn, reps) => { const xs = []; for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); } xs.sort((x, y) => x - y); return xs[xs.length >> 1]; };
  console.log('\nfiles     index load   JS filter       WASM filter     speedup   (query "gprs", median)');
  for (const n of [567, 5670, 56700, 567000]) {
    const set = scale(n);
    const load = time(() => index(set), 3);
    const reps = n > 100000 ? 3 : 7;
    const tj = time(() => js(set, 'gprs'), reps), tw = time(() => search('gprs'), reps);
    const same = JSON.stringify(js(set, 'gprs')) === JSON.stringify(search('gprs'));
    console.log(String(n).padEnd(9), (load.toFixed(1) + ' ms').padEnd(12), (tj.toFixed(1) + ' ms').padEnd(15), (tw.toFixed(1) + ' ms').padEnd(15), (tj / tw).toFixed(1) + 'x', same ? '' : ' (RESULTS DIFFER)');
  }
}

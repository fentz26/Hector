// Ranked file search for trees too big for the JavaScript filter to feel
// instant. The work happens in WebAssembly (wasm/, Rust) inside the background
// worker, off this page's main thread and out of reach of the page's CSP. The
// results are exactly what HT.fuzzy plus a sort give (wasm/test/parity.mjs
// checks that). If anything goes wrong, `failed` turns on and the tree goes
// back to the JavaScript filter for good.
HT.fast = {
  MIN_FILES: 50000,
  failed: false,
  _files: null, // the array the worker's index was built from
  _indexing: null, // { files, promise }

  // { total, results: [{ i (index into files), indices }] }, best match first.
  async query(files, text, limit) {
    try {
      await this._ensure(files);
      let res = await HT.api.send({ type: 'wasm:search', query: text, limit });
      if (res?.needIndex) {
        // The worker was stopped and forgot the index.
        this._files = null;
        await this._ensure(files);
        res = await HT.api.send({ type: 'wasm:search', query: text, limit });
      }
      if (!res?.ok) throw new Error(res?.error || 'search failed');
      return res;
    } catch (err) {
      this.failed = true;
      this.error = String(err?.message || err); // kept for debugging; nothing else reads it
      throw err;
    }
  },

  _ensure(files) {
    if (this._files === files) return Promise.resolve();
    if (this._indexing?.files !== files) {
      const promise = HT.api
        .send({ type: 'wasm:index', paths: files.map((f) => f.path).join('\n') })
        .then((res) => {
          if (!res?.ok) throw new Error(res?.error || 'index failed');
          this._files = files;
        })
        .finally(() => {
          if (this._indexing?.promise === promise) this._indexing = null;
        });
      this._indexing = { files, promise };
    }
    return this._indexing.promise;
  },
};

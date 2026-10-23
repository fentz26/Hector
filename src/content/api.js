// GitHub REST client. Requests are proxied through the background worker,
// which owns the token and the ETag cache.
HT.ApiError = class ApiError extends Error {
  constructor(res) {
    super(res.data?.message || res.error || `GitHub API error (${res.status})`);
    this.status = res.status;
    this.rateLimited = (res.status === 403 || res.status === 429) && res.rateRemaining === '0';
    this.rateReset = res.rateReset ? Number(res.rateReset) * 1000 : null;
    this.hasToken = res.hasToken;
  }
};

HT.api = {
  onRate: null,
  _memo: new Map(),

  // Firefox suspends idle background pages; the first message while it
  // restarts can fail, so retry a few times before giving up.
  async send(msg) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await chrome.runtime.sendMessage(msg);
      } catch (err) {
        if (!chrome.runtime?.id) {
          const e = new Error('HectaTree was updated or reloaded. Refresh this page to continue.');
          e.status = -1;
          throw e;
        }
        if (attempt >= 3) {
          const e = new Error(`Can't reach HectaTree's background: ${err.message}`);
          e.status = -2;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  },

  async request(path) {
    const res = await this.send({ type: 'api', host: location.host, path });
    if (res?.rateRemaining != null) this.onRate?.(Number(res.rateRemaining), Number(res.rateLimit));
    if (!res?.ok) throw new HT.ApiError(res || { status: 0 });
    return res;
  },

  // Memoize in-flight and completed GETs for the lifetime of the page.
  get(path) {
    if (!this._memo.has(path)) {
      const p = this.request(path).catch((err) => {
        this._memo.delete(path);
        throw err;
      });
      this._memo.set(path, p);
    }
    return this._memo.get(path);
  },

  clearMemo() {
    this._memo.clear();
  },

  repoPath(o, r) {
    return `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`;
  },

  async repo(o, r) {
    return (await this.get(this.repoPath(o, r))).data;
  },

  // Branch names may contain slashes, so /tree/feature/x/src is ambiguous.
  // Ask for refs that start with the first segment and pick the longest match.
  async resolveRef(o, r, segments, knownRefs = []) {
    if (!segments.length) return null;
    const joined = segments.join('/');
    for (const ref of knownRefs) {
      if (ref && (joined === ref || joined.startsWith(`${ref}/`))) {
        return { ref, path: joined.slice(ref.length + 1) };
      }
    }
    if (/^[0-9a-f]{40}$/i.test(segments[0])) {
      return { ref: segments[0], path: segments.slice(1).join('/') };
    }
    const names = new Set();
    for (const kind of ['heads', 'tags']) {
      try {
        const { data } = await this.get(`${this.repoPath(o, r)}/git/matching-refs/${kind}/${encodeURIComponent(segments[0])}`);
        for (const ref of data || []) names.add(ref.ref.replace(/^refs\/(heads|tags)\//, ''));
      } catch {
        // Ignore and fall back below.
      }
    }
    for (let i = segments.length; i > 0; i--) {
      const candidate = segments.slice(0, i).join('/');
      if (names.has(candidate)) return { ref: candidate, path: segments.slice(i).join('/') };
    }
    return { ref: segments[0], path: segments.slice(1).join('/') };
  },

  async tree(o, r, ref) {
    const { data } = await this.get(`${this.repoPath(o, r)}/git/trees/${HT.encodePath(ref)}?recursive=1`);
    return data; // { sha, tree: [...], truncated }
  },

  async subtree(o, r, sha) {
    const { data } = await this.get(`${this.repoPath(o, r)}/git/trees/${sha}`);
    return data.tree;
  },

  async pull(o, r, n) {
    return (await this.get(`${this.repoPath(o, r)}/pulls/${n}`)).data;
  },

  // GitHub caps this endpoint at 3000 files (30 pages of 100).
  async pullFiles(o, r, n, expected = Infinity) {
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const { data, link } = await this.get(`${this.repoPath(o, r)}/pulls/${n}/files?per_page=100&page=${page}`);
      files.push(...data);
      if (data.length < 100 || files.length >= expected || !/rel="next"/.test(link || '')) break;
    }
    return files;
  },
};

// API transport. Requests are proxied through the background worker, which
// owns the token and the ETag cache. What to ask for lives in the provider
// adapters (github.js, gitlab.js).
HT.ApiError = class ApiError extends Error {
  constructor(res) {
    // GitHub: { message }; GitLab: { message | error }; Bitbucket: { error: { message, detail } }.
    const e = res.data?.error;
    super(
      res.data?.message ||
        res.data?.errors?.[0]?.message ||
        (typeof e === 'string' ? e : e?.detail || e?.message) ||
        res.error ||
        `API error (${res.status})`
    );
    this.status = res.status;
    this.rateLimited = (res.status === 403 || res.status === 429) && res.rateRemaining === '0';
    this.rateReset = res.rateReset ? Number(res.rateReset) * 1000 : null;
    this.hasToken = res.hasToken;
  }
};

HT.api = {
  onRate: null,
  provider: 'github', // set at boot from the page
  _memo: new Map(),

  // Firefox suspends idle background pages; the first message while it
  // restarts can fail, so retry a few times before giving up.
  async send(msg) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await chrome.runtime.sendMessage(msg);
      } catch (err) {
        if (!chrome.runtime?.id) {
          const e = new Error('Hector was updated or reloaded. Refresh this page to continue.');
          e.status = -1;
          throw e;
        }
        if (attempt >= 3) {
          const e = new Error(`Can't reach Hector's background: ${err.message}`);
          e.status = -2;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  },

  async request(path) {
    const res = await this.send({ type: 'api', host: location.host, provider: this.provider, path });
    if (res?.rateRemaining != null) this.onRate?.(Number(res.rateRemaining), Number(res.rateLimit));
    if (!res?.ok) throw new HT.ApiError(res || { status: 0 });
    return res;
  },

  // Plain-text endpoints (job logs). Never memoized. `web` fetches a page
  // path on the site itself (GitLab's raw job log) instead of the API.
  async text(path, { web = false } = {}) {
    const res = await this.send({ type: 'api', host: location.host, provider: this.provider, path, text: true, web });
    if (!res?.ok) throw new HT.ApiError(res || { status: 0 });
    return res.data;
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

  // Branch names may contain slashes, so /tree/feature/x/src is ambiguous.
  // `lookup(prefix)` lists refs starting with the first segment; pick the
  // longest one that matches.
  async resolveRef(segments, knownRefs, lookup) {
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
    const names = new Set(await lookup(segments[0]).catch(() => []));
    for (let i = segments.length; i > 0; i--) {
      const candidate = segments.slice(0, i).join('/');
      if (names.has(candidate)) return { ref: candidate, path: segments.slice(i).join('/') };
    }
    return { ref: segments[0], path: segments.slice(1).join('/') };
  },
};

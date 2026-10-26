// Which site this page is on, and the repository context of its URL.
HT.url = {
  // github.com and gitlab.com are known; a self-hosted server is GitLab when
  // its pages say so, otherwise GitHub Enterprise.
  detectProvider() {
    if (location.host === 'github.com') return HT.providers.github;
    if (location.host === 'bitbucket.org') return HT.providers.bitbucket;
    const gitlab =
      location.host === 'gitlab.com' ||
      document.querySelector('meta[property="og:site_name"][content="GitLab"]') ||
      (document.body?.dataset.page != null && document.body.dataset.namespaceId != null);
    return gitlab ? HT.providers.gitlab : HT.providers.github;
  },

  // A context ({ host, owner, repo, kind, pullNumber?, segments }) or null
  // when the page isn't a repository.
  parse(loc = location) {
    return HT.provider.parse(loc);
  },

  repoKey(ctx) {
    return `${ctx.host}/${ctx.owner}/${ctx.repo}`.toLowerCase();
  },
};

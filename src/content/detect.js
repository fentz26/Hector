// Does this page belong to a code host Hector supports? Reads only the page's
// own markup; nothing leaves the browser. Runs when the toolbar button is
// clicked on a site Hector doesn't know yet, and, if the user turned on
// "find servers on any site", on every page (then it tells the background,
// which starts Hector there). Evaluates to the kind, or null.
(() => {
  const has = (selector) => Boolean(document.querySelector(selector));
  let kind = null;
  if (has('meta[name="application-name"][content="Bitbucket"]') || document.body?.classList.contains('bitbucket-theme')) kind = 'bitbucket-server';
  else if (has('meta[property="og:site_name"][content="GitLab"]') || (document.body?.dataset.page != null && document.body.dataset.namespaceId != null)) kind = 'gitlab';
  else if (has('meta[name="github-keyboard-shortcuts"], meta[name="octolytics-url"], meta[property="og:site_name"][content="GitHub"]') && has('meta[name="expected-hostname"]')) kind = 'github';
  if (kind && !globalThis.__hectorLoaded) chrome.runtime.sendMessage({ type: 'site:found', kind }).catch(() => {});
  return kind;
})();

// The fallback is a normal, isolated anonymous WebView2, not a bypass or a
// character/login profile. Once selected, don't keep retrying the rejected client.
export function createPublicNewsReader(invoke) {
  let browser = false;
  return async args => {
    const usingBrowser = browser;
    let result = await invoke('fetch_promo_news_page', { ...args, browser: usingBrowser });
    if (!usingBrowser && result?.status === 403) {
      browser = true;
      result = await invoke('fetch_promo_news_page', { ...args, browser: true });
    }
    return result;
  };
}

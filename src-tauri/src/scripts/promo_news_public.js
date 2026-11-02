// Anonymous public news only. Never follows PINs, clicks buttons or solves a challenge.
(function () {
  function report(data, error) {
    history.replaceState(null, '', location.pathname + location.search + '#TF_PUBLIC_NEWS_V1_' + encodeURIComponent(JSON.stringify({data:data,error:error || null})));
  }
  try {
    if (document.readyState === 'loading') { report(null,'pending');return; }
    var text=(document.title+' '+(document.body.textContent || '').slice(0,500));
    if (window.__TF.isChallenge() || /checking your browser|just a moment|captcha/i.test(text)) {report(null,'news_challenge');return;}
    if (/\b403\b|access denied|forbidden|доступ запрещ/i.test(text)) {report(null,'news_http_403');return;}
    var article=!!(window.__TF_PUBLIC_PROMO_NEWS && window.__TF_PUBLIC_PROMO_NEWS.article);
    if (article && !document.querySelector('.js-mediator-article,#content_body,article,.news-text,.news_text,.news-content,#news-content')) {report(null,'news_markup');return;}
    if (!article && !document.querySelector('a[href*="article="]')) {report(null,'news_markup');return;}
    var clone=document.documentElement.cloneNode(true);
    clone.querySelectorAll('script,style,iframe,link,meta,base,noscript,img,svg,video,audio,source,object,embed').forEach(function(n){n.remove();});
    var html=clone.outerHTML;
    if (new TextEncoder().encode(html).length>128*1024) {report(null,'news_size');return;}
    report({html:html},null);
  } catch (_) {report(null,'news_markup');}
})();

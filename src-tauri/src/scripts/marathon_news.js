// Очищенный HTML новости о марафоне (разбор — в js/marathons/newsParser.js). Ответ: #TF_NEWS_V1_<json>
(function() {
    function report(data, error) {
        const payload = { data: data, error: error ? String(error) : null };
        window.location.hash = 'TF_NEWS_V1_' + encodeURIComponent(JSON.stringify(payload));
    }
    const TF = window.__TF; // селекторы, тексты и регулярные выражения: selectors.json (news.*, common.*)
    if (!TF) { report(null, 'config_missing'); return; }
    try {
        if (TF.isChallenge()) {
            report(null, 'challenge');
            return;
        }
        const art = TF.q('news.article');
        if (!art) { report(null, 'no_article'); return; }
        const clone = art.cloneNode(true);
        TF.qa('news.junk', clone).forEach(e => e.remove());
        clone.querySelectorAll('*').forEach(e => ['style', 'width', 'height', 'border', 'class'].forEach(a => {
            if (a !== 'class' || !e.classList.contains('click_spoiler')) e.removeAttribute(a);
        }));
        const h1 = TF.q('news.title');
        const text = document.body.innerText || '';
        const dm = TF.match('news.date', text);
        report({
            title: h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : document.title.split(' - ')[0],
            publishedAt: dm ? dm[1] : null,
            url: location.href.split('#')[0],
            html: clone.innerHTML
        }, null);
    } catch (e) {
        report(null, 'exception_' + e.message.substring(0, 30));
    }
})();

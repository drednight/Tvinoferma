// Очищенный HTML новости о марафоне (разбор — в js/marathons/newsParser.js). Ответ: #TF_NEWS_V1_<json>
(function() {
    function report(data, error) {
        const payload = { data: data, error: error ? String(error) : null };
        window.location.hash = 'TF_NEWS_V1_' + encodeURIComponent(JSON.stringify(payload));
    }
    try {
        if (document.readyState === 'loading' ||
            (document.title || '').includes('Проверка безопасности') ||
            document.querySelector('script[src*="bp_chl"]')) {
            report(null, 'challenge');
            return;
        }
        const art = document.querySelector('.js-mediator-article') || document.querySelector('#content_body');
        if (!art) { report(null, 'no_article'); return; }
        const clone = art.cloneNode(true);
        clone.querySelectorAll('img, script, style, iframe, .img_item_small_cont > span').forEach(e => e.remove());
        clone.querySelectorAll('*').forEach(e => ['style', 'width', 'height', 'border', 'class'].forEach(a => {
            if (a !== 'class' || !e.classList.contains('click_spoiler')) e.removeAttribute(a);
        }));
        const h1 = document.querySelector('#content_top h1') || document.querySelector('h1');
        const text = document.body.innerText || '';
        const dm = text.match(/Обсудить\s+(\d{2}\.\d{2}\.\d{4})/) || text.match(/(\d{2}\.\d{2}\.\d{4})/);
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

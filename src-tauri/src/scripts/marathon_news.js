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
            report(TF.waitKind(), 'challenge');
            return;
        }
        // A news URL can redirect to a check page. Preserve its task classes, not the account sidebar.
        const check = TF.q('marathon.container');
        if (check) {
            const root = document.createElement('div');
            root.id = 'media_tabs';
            for (const node of [TF.q('news.checkHeading'), TF.q('marathon.legend'), check]) {
                if (node) root.appendChild(node.cloneNode(true));
            }
            root.querySelectorAll('script, iframe, form, input, button').forEach(node => node.remove());
            report({ title: root.querySelector('h2')?.textContent || document.title, url: location.href.split('#')[0], html: root.outerHTML }, null);
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
            title: (h1?.textContent || '').replace(/\s+/g, ' ').trim() || document.title.split(' - ')[0].trim(),
            publishedAt: dm ? dm[1] : null,
            url: location.href.split('#')[0],
            html: clone.innerHTML
        }, null);
    } catch (e) {
        report(null, 'exception_' + e.message.substring(0, 30));
    }
})();

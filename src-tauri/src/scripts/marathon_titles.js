// Название марафона на странице supermarathon*.php. Ответ: #TF_TITLE_V4_<json>
(function() {
    function report(data, error) {
        const payload = { data: data, error: error ? String(error) : null };
        window.location.hash = 'TF_TITLE_V4_' + encodeURIComponent(JSON.stringify(payload));
    }
    try {
    // Сайт показывает «Проверку безопасности» (anti-bot) — просим Rust подождать и повторить
    if (document.readyState === 'loading' ||
        (document.title || '').includes('Проверка безопасности') ||
        document.querySelector('script[src*="bp_chl"]')) {
        report(null, 'challenge');
        return;
    }
        const bodyText = document.body.innerText || "";
        if (bodyText.includes("Вы не авторизованы")) {
             report(null, 'not_logged_in');
             return;
        }
        const headers = document.querySelectorAll('h2');
        let marathonName = null;
        for (let h of headers) {
            const text = h.innerText.trim();
            if (text && text.length > 3 && !text.includes('Новости')) {
                marathonName = text;
                break;
            }
        }
        if (!marathonName) {
            report(null, 'no_title_found');
            return;
        }
        report({ name: marathonName, url: window.location.href }, null);
    } catch (e) {
        report(null, 'exception_' + e.message.substring(0, 20));
    }
})();

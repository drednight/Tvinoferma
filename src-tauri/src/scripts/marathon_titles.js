// Название марафона на странице supermarathon*.php. Ответ: #TF_TITLE_V4_<json>
(function() {
    function report(data, error) {
        const payload = { data: data, error: error ? String(error) : null };
        window.location.hash = 'TF_TITLE_V4_' + encodeURIComponent(JSON.stringify(payload));
    }
    const TF = window.__TF; // селекторы и тексты: selectors.json (titles.*, common.*)
    if (!TF) { report(null, 'config_missing'); return; }
    try {
    // Сайт показывает «Проверку безопасности» (anti-bot) — просим Rust подождать и повторить
    if (TF.isChallenge()) {
        report(null, 'challenge');
        return;
    }
        const bodyText = document.body.innerText || "";
        if (TF.has(bodyText, 'common.notLoggedIn')) {
             report(null, 'not_logged_in');
             return;
        }
        const headers = TF.qa('titles.heading');
        let marathonName = null;
        for (let h of headers) {
            const text = h.innerText.trim();
            if (text && text.length > 3 && !TF.has(text, 'titles.skipHeading')) {
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

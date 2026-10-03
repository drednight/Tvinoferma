// Прогресс персонажа по заданиям страницы марафона. Ответ: #TF_MARATHON_DATA_<json>
(function() {
    console.log('[MARATHON-JS] Starting marathon parsing...');
    function reportResult(data, error) {
        const payload = { data: data, error: error ? String(error) : null };
        window.location.hash = 'TF_MARATHON_DATA_' + encodeURIComponent(JSON.stringify(payload));
    }
    const TF = window.__TF; // селекторы и тексты: selectors.json (marathon.*, common.*)
    if (!TF) { reportResult(null, 'config_missing'); return; }
    try {
        // Сайт показывает «Проверку безопасности» (anti-bot) — просим Rust подождать и повторить
        if (TF.isChallenge()) {
            reportResult(null, 'challenge');
            return;
        }
        const bodyText = document.body.innerText || "";
        if (TF.has(bodyText, ['common.notLoggedIn', 'marathon.noAccess'])) {
            reportResult(null, 'not_logged_in');
            return;
        }
        const marathonContainer = TF.q('marathon.container');
        if (!marathonContainer) {
            reportResult([], 'container_not_found');
            return;
        }
        const questBlocks = TF.qa('marathon.quest', marathonContainer);
        const results = [];
        questBlocks.forEach(block => {
            const titleEl = TF.q('marathon.questTitle', block);
            const title = titleEl ? titleEl.innerText.trim() : "Unknown Quest";
            const progressEl = TF.q('marathon.progressValue', block);
            // Описание задания: все абзацы блока (у некоторых заданий их два)
            const description = TF.qa('marathon.description', block)
                .map(p => String(p.innerText || p.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim())
                .filter(Boolean).join('\n');
            let completed = 0;
            let total = 0;
            if (progressEl) {
                const text = progressEl.innerText.trim();
                const parts = text.split('/');
                if (parts.length === 2) {
                    completed = parseInt(parts[0], 10) || 0;
                    total = parseInt(parts[1], 10) || 0;
                }
            }
            if (total > 0 || completed > 0) {
                results.push({ title: title, description: description, completed: completed, total: total, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 });
            }
        });
        // Блоки заданий есть, а ни одной полосы прогресса нет — скорее всего, сайт изменил вёрстку.
        // Ошибка надёжнее «пустого успеха»: данные в базе не затираются.
        if (questBlocks.length > 0 && results.length === 0) {
            reportResult([], 'no_progress_found');
            return;
        }
        reportResult(results, null);
    } catch (e) {
        reportResult(null, 'exception_' + e.message.substring(0, 20));
    }
})();

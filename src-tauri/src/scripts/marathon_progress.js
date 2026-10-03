// Прогресс персонажа по заданиям страницы марафона. Ответ: #TF_MARATHON_DATA_<json>
(function() {
    console.log('[MARATHON-JS] Starting marathon parsing...');
    function reportResult(data, error) {
        const payload = { data: data, error: error ? String(error) : null };
        window.location.hash = 'TF_MARATHON_DATA_' + encodeURIComponent(JSON.stringify(payload));
    }
    try {
        // Сайт показывает «Проверку безопасности» (anti-bot) — просим Rust подождать и повторить
        if (document.readyState === 'loading' ||
            (document.title || '').includes('Проверка безопасности') ||
            document.querySelector('script[src*="bp_chl"]')) {
            reportResult(null, 'challenge');
            return;
        }
        const bodyText = document.body.innerText || "";
        if (bodyText.includes("Вы не авторизованы") || bodyText.includes("не имеете доступа")) {
            reportResult(null, 'not_logged_in');
            return;
        }
        const marathonContainer = document.querySelector('.season_marathon');
        if (!marathonContainer) {
            reportResult([], 'container_not_found');
            return;
        }
        const questBlocks = marathonContainer.querySelectorAll(':scope > div');
        const results = [];
        questBlocks.forEach(block => {
            const titleEl = block.querySelector('b');
            const title = titleEl ? titleEl.innerText.trim() : "Unknown Quest";
            const progressEl = block.querySelector('.progress span');
            // Описание задания: все абзацы блока (у некоторых заданий их два)
            const description = Array.from(block.querySelectorAll('p'))
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

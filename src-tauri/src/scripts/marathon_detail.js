// Детальный разбор страницы марафона: этапы + задания. Ответ: #TF_DETAIL_V4_<json>
(function() {
    console.log('[DETAIL-PARSER-JS-v4] Starting deep parse with robust stages...');

    function reportResult(data, error) {
        const payload = { data: data, error: error ? String(error) : null };
        window.location.hash = 'TF_DETAIL_V4_' + encodeURIComponent(JSON.stringify(payload));
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
        if (bodyText.includes("Вы не авторизованы")) {
             reportResult(null, 'not_logged_in');
             return;
        }

        // 1. Название основного марафона
        const headerEl = document.querySelector('h2');
        const marathonName = headerEl ? headerEl.innerText.trim() : "Неизвестный Марафон";

        // 2. Парсинг этапов. Формат сайта:
        // «Сроки проведения первого этапа марафона (июнь): с 00:01 мск 30 мая до 23:59 мск 28 июня.»
        // Разбираем весь текст легенды (этапы могут быть в одном абзаце, через <br>),
        // время и «мск» — необязательны, «до»/«по» — оба варианта.
        const debug = [];
        const norm = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        const MONTH_GEN = { 'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
            'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12 };
        const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август',
            'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
        const stageKeyOf = (inner) => {
            const low = norm(inner).toLowerCase();
            return MONTH_NOM.find(m => low.includes(m)) || low;
        };
        const G = Object.keys(MONTH_GEN).join('|');
        const T = '(?:\\d{1,2}[:.]\\d{2}\\s*(?:мск|msk)?\\s*)?';
        const reStage = new RegExp(
            '\\(([^()]{2,40})\\)[^()]{0,160}?(?:^|[\\s:,.—-])с\\s+' + T + '(\\d{1,2})\\s+(' + G + ')(?:\\s+(\\d{4}))?' +
            '[^()]{0,80}?(?:до|по)\\s+' + T + '(\\d{1,2})\\s+(' + G + ')(?:\\s+(\\d{4}))?', 'gi');
        const now = new Date();
        const curMonth = now.getMonth() + 1;
        const yearFor = (mon) => {
            let y = now.getFullYear();
            if (mon < curMonth - 6) y += 1; else if (mon > curMonth + 6) y -= 1;
            return y;
        };
        const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        function parseStages(text) {
            const found = [];
            for (const mt of text.matchAll(reStage)) {
                const key = stageKeyOf(mt[1]);
                if (found.some(s => s.key === key)) continue;
                const sMon = MONTH_GEN[mt[3].toLowerCase()], eMon = MONTH_GEN[mt[6].toLowerCase()];
                const sYear = mt[4] ? parseInt(mt[4], 10) : yearFor(sMon);
                const eYear = mt[7] ? parseInt(mt[7], 10) : (eMon < sMon ? sYear + 1 : sYear);
                found.push({
                    name: key.charAt(0).toUpperCase() + key.slice(1),
                    key: key,
                    startDate: iso(sYear, sMon, parseInt(mt[2], 10)),
                    endDate: iso(eYear, eMon, parseInt(mt[5], 10))
                });
            }
            return found;
        }

        const legendBlock = document.querySelector('.status_legend');
        const legendText = norm(legendBlock ? legendBlock.innerText : '');
        let stages = parseStages(legendText);
        debug.push(legendBlock ? `Блок сроков найден (${legendText.length} симв.), этапов: ${stages.length}` : 'Блок сроков (.status_legend) не найден на странице');
        if (!stages.length) {
            stages = parseStages(norm(document.body.innerText));
            debug.push(`Поиск сроков по всей странице: этапов ${stages.length}`);
        }
        // Абзацы со скобками, из которых не удалось достать даты — в лог, для диагностики
        (legendText.match(/[^\n]*\([^()]{2,40}\)[^\n]*/g) || []).forEach(line => {
            const keyM = line.match(/\(([^()]{2,40})\)/);
            if (keyM && MONTH_NOM.some(m => keyM[1].toLowerCase().includes(m)) && !stages.some(s => s.key === stageKeyOf(keyM[1]))) {
                debug.push(`Не распознаны сроки этапа: «${line.slice(0, 200)}»`);
            }
        });

        // 3. Парсинг заданий
        const container = document.querySelector('.season_marathon');
        const quests = [];

        if (container) {
            const questBlocks = container.querySelectorAll(':scope > div');
            questBlocks.forEach(block => {
                const titleEl = block.querySelector('b');
                const descEl = block.querySelector('p'); 
                const progressSpan = block.querySelector('.progress span');

                let totalGoal = 0;
                if (progressSpan) {
                    const text = progressSpan.innerText.trim(); 
                    const parts = text.split('/');
                    if (parts.length === 2) {
                        totalGoal = parseInt(parts[1], 10) || 0;
                    }
                }

                if (titleEl && totalGoal > 0) {
                    const rawTitle = titleEl.innerText.trim();
                    // Извлекаем месяц из заголовка для привязки к этапу
                    // Пример: "Испытание снов (июль)" -> ключ "июль"
                    const monthInTitle = rawTitle.match(/\(([^()]*)\)\s*$/) || rawTitle.match(/\(([^()]*)\)/);
                    const associatedStageKey = monthInTitle ? stageKeyOf(monthInTitle[1]) : null;

                    // Чистое описание без префикса [месяц], если он был добавлен ранее
                    let cleanDescription = descEl ? descEl.innerText.trim() : "";

                    quests.push({
                        id: crypto.randomUUID(), 
                        title: rawTitle,
                        description: cleanDescription,
                        goal: totalGoal,
                        stageKey: associatedStageKey 
                    });
                }
            });
        }

        const resultData = {
            name: marathonName,
            sourceUrl: window.location.href,
            detectedAt: new Date().toISOString(),
            stages: stages,
            quests: quests,
            debug: debug
        };

        console.log('[DETAIL-PARSER-JS-v4] Success:', marathonName, 'Stages:', stages.length, 'Quests:', quests.length);
        reportResult(resultData, null);

    } catch (e) {
        console.error('[DETAIL-PARSER-JS-v4] Exception:', e);
        reportResult(null, 'exception_' + e.message.substring(0, 20));
    }
})();

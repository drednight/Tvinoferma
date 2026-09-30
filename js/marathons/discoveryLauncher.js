// js/marathons/discoveryLauncher.js

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast, showModal, closeModal } from '../ui.js';
import { state } from '../state.js';
import { persist } from '../storage.js';
import { renderMarathons } from '../marathon.js'; 
import { openMarathonForm } from './index.js'; 
import { ProgressBar } from '../components/ProgressBar.js'; // Используем существующий компонент

let isListeningTitles = false;
let isListeningDetails = false;
const scanProgress = new ProgressBar();

export async function startDiscovery() {
    scanProgress.show('🔍 Сканирование марафонов...');
    try {
        await invoke('get_available_marathon_titles');
    } catch (e) {
        console.error('[DISCOVERY] Failed to start scan:', e);
        scanProgress.hide();
        toast('Ошибка запуска сканирования', 'error');
    }
}

export async function initDiscoveryListener() {
    if (isListeningTitles) return;

    // Слушаем прогресс сканирования
    await listen('scan-progress-update', (event) => {
        const { percent, message } = event.payload;
        scanProgress.update(percent, 100, message);
    });

    // Слушаем результат сканирования названий
    await listen('marathon-titles-scanned-global', (event) => {
        const { titles, count } = event.payload;
        console.log('[TITLES SCAN RESULT]', titles);
        scanProgress.hide();

        if (!titles || titles.length === 0) {
            toast('Марафоны не найдены. Убедитесь, что вы залогинены хотя бы под одним персонажем.', 'warning');
            return;
        }

        if (count === 1) {
            requestDetails(titles[0].url);
        } else {
            showSelectionModal(titles);
        }
    });

    // Слушаем результат детального парсинга
    await listen('single-marathon-parsed-global', (event) => {
        const { marathon, error } = event.payload;
        console.log('[DETAIL PARSE RESULT]', marathon, error);

        if (error) {
            let msg = '';
            if (error === 'not_logged_in') {
                msg = '⚠️ Не удалось получить данные: Требуется вход. Сначала нажмите "Проверить авторизацию" во вкладке Персонажи.';
            } else {
                msg = `❌ Ошибка парсинга (${error}). Попробуйте еще раз.`;
            }
            toast(msg, 'error');
            return;
        }

        if (marathon) {
            handleParsedMarathon(marathon);
        } else {
            toast('Не удалось получить данные марафона.', 'warning');
        }
    });

    isListeningTitles = true;
    isListeningDetails = true;
}

/**
 * Логика обработки полученных данных марафона
 */
function handleParsedMarathon(rawMarathon) {
    const stages = rawMarathon.stages || [];
    
    // Если этапов больше одного - спрашиваем пользователя
    if (stages.length > 1) {
        showStageSelectionModal(rawMarathon);
    } 
    // Если 0 или 1 этап - импортируем автоматически (как "Весь марафон")
    else {
        prepareAndOpenForm(rawMarathon, 'all');
    }
}

async function requestDetails(url) {
    toast('Загружаю детали выбранного марафона...', 'info');
    try {
        await invoke('parse_specific_marathon_page', { url });
    } catch (e) {
        console.error(e);
        toast('Ошибка запроса деталей', 'error');
    }
}

function showSelectionModal(titlesList) {
    const optionsHtml = titlesList.map((t, index) => {
        let path = t.url;
        try {
            const urlObj = new URL(t.url);
            path = urlObj.pathname; 
        } catch (e) {}

        return `
        <div class="field" style="margin-bottom:15px; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2);">
            <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                <input type="radio" name="selected-title" value="${index}" ${index === 0 ? 'checked' : ''} />
                <div>
                    <strong>${escapeHtml(t.name)}</strong><br/>
                    <small class="muted" style="font-family: monospace; font-size: 0.8rem; color: #aaa;">
                        pwonline.ru${path}
                    </small>
                </div>
            </label>
        </div>
    `}).join('');

    showModal({
        title: 'Выберите марафон',
        content: `
            <p class="muted">Найдено ${titlesList.length} активных марафонов:</p>
            <div style="max-height:300px; overflow-y:auto;">
                ${optionsHtml}
            </div>
        `,
        submitText: 'Импортировать выбранный',
        cancelText: 'Отмена',
        onSubmit(formData, { setError }) {
            const selectedIndex = formData.get('selected-title');
            if (selectedIndex === null) {
                setError('Выберите марафон.');
                return false;
            }
            
            const selectedTitleObj = titlesList[parseInt(selectedIndex, 10)];
            closeModal(); 
            
            setTimeout(() => {
                requestDetails(selectedTitleObj.url);
            }, 100);
            
            return true;
        }
    });
}

/**
 * Модалка выбора этапа (только если этапов > 1)
 */
function showStageSelectionModal(fullMarathonData) {
    const stages = fullMarathonData.stages || [];
    
    // Опция "Весь марафон"
    let optionsHtml = `
        <div class="field" style="margin-bottom:15px; padding:10px; border:1px solid var(--accent); border-radius:6px; background:rgba(255, 158, 100, 0.1);">
            <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                <input type="radio" name="selected-stage" value="all" checked />
                <div>
                    <strong>📦 Весь марафон (${fullMarathonData.name})</strong><br/>
                    <small class="muted">Все этапы и задания будут включены.</small>
                </div>
            </label>
        </div>
    `;

    // Опции по этапам
    stages.forEach((stage, index) => {
        optionsHtml += `
        <div class="field" style="margin-bottom:15px; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2);">
            <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
                <input type="radio" name="selected-stage" value="${index}" />
                <div>
                    <strong>📅 Этап: ${escapeHtml(stage.name)}</strong><br/>
                    <small class="muted">
                        Период: ${stage.startDate} — ${stage.endDate}<br/>
                        Заданий: ${fullMarathonData.quests.filter(q => q.stageKey === stage.key).length}
                    </small>
                </div>
            </label>
        </div>
        `;
    });

    showModal({
        title: 'Выбор диапазона импорта',
        content: `
            <p class="muted">Этот марафон разделен на несколько этапов. Что вы хотите импортировать?</p>
            <div style="max-height:400px; overflow-y:auto;">
                ${optionsHtml}
            </div>
        `,
        submitText: 'Продолжить',
        cancelText: 'Отмена',
        onSubmit(formData, { setError }) {
            const selection = formData.get('selected-stage');
            if (selection === null) {
                setError('Выберите вариант.');
                return false;
            }
            
            closeModal();
            
            setTimeout(() => {
                if (selection === 'all') {
                    prepareAndOpenForm(fullMarathonData, 'all');
                } else {
                    const stageIndex = parseInt(selection, 10);
                    const selectedStage = fullMarathonData.stages[stageIndex];
                    prepareAndOpenForm(fullMarathonData, selectedStage.key); 
                }
            }, 100);
            
            return true;
        }
    });
}

/**
 * Готовит данные и открывает форму создания марафона
 */
function prepareAndOpenForm(rawMarathon, filterMode = 'all') {
    console.log(`[DISCOVERY] Preparing form. Filter mode: ${filterMode}`, rawMarathon);

    // 1. Фильтрация заданий
    let filteredQuests = rawMarathon.quests;
    let filteredStages = rawMarathon.stages;
    let marathonTitleSuffix = "";

    if (filterMode !== 'all') {
        filteredQuests = rawMarathon.quests.filter(q => q.stageKey === filterMode);
        
        const currentStage = rawMarathon.stages.find(s => s.key === filterMode);
        
        if (currentStage) {
            filteredStages = [currentStage]; 
            marathonTitleSuffix = ` (${currentStage.name})`;
        } else {
            toast('Не найдено заданий для выбранного этапа.', 'warning');
            return;
        }
    }

    // 2. Преобразование заданий в формат tasks
    const convertedTasks = filteredQuests.map(q => {
        // Очищаем описание от возможных артефактов парсинга, если они есть
        // Но так как мы убрали добавление [месяц] в Rust, здесь просто берем чистый текст
        let cleanDesc = q.description || "";
        
        // Дополнительная защита: если вдруг в описании остался префикс "[июнь]", удаляем его
        cleanDesc = cleanDesc.replace(/^\[\w+\]\s*/, ''); 

        return {
            id: q.id || crypto.randomUUID(),
            title: q.title,                  
            description: cleanDesc,      
            targetChecks: q.goal,            
            
            schedule: {
                mode: 'everyDay', 
                dates: [], 
                weekStartDay: 1 
            },
            
            baseRewardText: '',
            baseRewardCoins: 0,
            stages: []
        };
    });

    // 3. Расчет общих дат марафона (или этапа)
    let globalStartDate = rawMarathon.startDate;
    let globalEndDate = rawMarathon.endDate;

    if (filteredStages && filteredStages.length > 0) {
        const sortedStages = [...filteredStages].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        globalStartDate = sortedStages[0].startDate;
        globalEndDate = sortedStages[sortedStages.length - 1].endDate;
    }

    // 4. Формирование объекта для формы
    const prefillData = {
        id: null, // Новый марафон
        title: rawMarathon.name + marathonTitleSuffix,         
        description: `Авто-импорт от ${new Date().toLocaleDateString()}.\nИсточник: ${rawMarathon.sourceUrl}`,
        
        startDate: globalStartDate || new Date().toISOString().split('T')[0],
        endDate: globalEndDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], 
        
        status: 'active',
        type: 'auto-detected',
        
        participantIds: [],              
        tasks: convertedTasks,           
        
        comboRewards: [],                
        records: [],                     
        awards: [],                      
        participantAssignments: {},      
        
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null
    };

    console.log('[DISCOVERY] Opening form with formatted data:', prefillData);
    openMarathonForm(prefillData);
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
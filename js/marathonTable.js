// js/marathonTable.js

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { getAllDatesInRange, isTaskActiveOnDate, getAvailableCheckCount, getPastActiveDaysCount } from './marathonUtils.js';

/**
 * Рассчитывает общую сумму заработанных монет по всем участникам марафона
 */
export function calculateTotalEarnedCoins(marathon) {
  if (!marathon || !marathon.participantIds) return 0;

  let total = 0;

  marathon.participantIds.forEach(charId => {
    // Защита: проверяем, существует ли персонаж в глобальном стейте
    const charExists = state.characters.some(c => c.id === charId);
    if (!charExists) return; 

    const assignedTaskIds = marathon.participantAssignments[charId] || [];
    
    // Если назначений нет, считаем, что все задания активны
    const relevantTasks = assignedTaskIds.length > 0 
      ? marathon.tasks.filter(t => assignedTaskIds.includes(t.id))
      : marathon.tasks;

    relevantTasks.forEach(task => {
      // Защита: проверяем существование задания
      const taskExists = marathon.tasks.find(t => t.id === task.id);
      if (!taskExists) return;

      const completedCount = marathon.records.filter(r => 
        r.characterId === charId && 
        r.taskId === task.id && 
        r.completed
      ).length;

      const target = Number(task.targetChecks) || 0;
      const hasStages = task.stages && task.stages.length > 0;

      if (hasStages) {
        const sortedStages = [...task.stages].sort((a, b) => a.threshold - b.threshold);
        let highestReachedStage = null;
        
        for (let i = 0; i < sortedStages.length; i++) {
          if (completedCount >= sortedStages[i].threshold) {
            highestReachedStage = sortedStages[i];
          } else {
            break;
          }
        }

        if (highestReachedStage) {
          total += Number(highestReachedStage.rewardCoins) || 0;
        }
      } else {
        if (completedCount >= target && target > 0) {
           total += Number(task.baseRewardCoins) || 0;
        }
      }
    });
  });

  return total;
}

/**
 * Генерирует HTML таблицы активности
 */
export function generateMarathonTableHTML(marathon, filteredParty = 'all', filteredTaskId = null) {
  if (!marathon || !marathon.participantIds.length) {
    return '<div class="empty-state">Нет участников.</div>';
  }

  try {
    const allDates = getAllDatesInRange(marathon.startDate, marathon.endDate);
    const todayStr = new Date().toLocaleDateString('sv');

    // 1. Получаем список персонажей-участников марафона
    // Фильтруем только тех, кто реально существует в state.characters
    const participantCharsRaw = state.characters.filter(c => marathon.participantIds.includes(c.id));
    
    // Применяем фильтр по пати
    let characters = participantCharsRaw;
    if (filteredParty && filteredParty !== 'all') {
      if (filteredParty === '__none__') {
        characters = characters.filter(c => !c.party);
      } else {
        characters = characters.filter(c => c.party === filteredParty);
      }
    }

    if (characters.length === 0) {
      return '<div class="empty-state">Нет персонажей в этой категории или они были удалены.</div>';
    }

    // 2. Группируем записи для быстрого поиска
    const recordMap = new Map();
    marathon.records.forEach(rec => {
      if (rec.completed) {
        recordMap.set(`${rec.characterId}_${rec.taskId}_${rec.date}`, rec);
      }
    });

    // 3. Формируем строки таблицы
    const rowsData = [];
    characters.forEach(char => {
      // Получаем назначения заданий
      const assignedTaskIds = marathon.participantAssignments?.[char.id];
      
      let tasksToShow = [];
      if (assignedTaskIds && Array.isArray(assignedTaskIds)) {
         // Берем только те задания, которые есть в списке assignments И существуют в marathon.tasks
         tasksToShow = marathon.tasks.filter(t => assignedTaskIds.includes(t.id));
      } else {
         // По умолчанию показываем все задания марафона
         tasksToShow = [...marathon.tasks];
      }

      // Применяем фильтр по конкретному заданию, если выбран
      if (filteredTaskId) {
        tasksToShow = tasksToShow.filter(t => t.id === filteredTaskId);
      }

      tasksToShow.forEach(task => {
        // Дополнительная защита: убеждаемся, что задание действительно из этого марафона
        if (marathon.tasks.find(t => t.id === task.id)) {
           rowsData.push({ char, task });
        }
      });
    });

    if (rowsData.length === 0) {
       return '<div class="empty-state">Нет активных заданий для отображения с текущими фильтрами.</div>';
    }

    const uniqueParties = Array.from(new Set(participantCharsRaw.map(c => c.party).filter(Boolean)));
    const allTasksList = marathon.tasks.map(t => ({ id: t.id, title: t.title }));

    // Расчет общих монет
    const totalEarnedCoins = calculateTotalEarnedCoins(marathon);

    let html = `
      <style>
        .current-day-header {
          background-color: rgba(122, 162, 247, 0.2) !important;
          border-top: 2px solid var(--accent) !important;
          color: var(--accent) !important;
          font-weight: bold !important;
        }
        .current-day-cell {
          background-color: rgba(122, 162, 247, 0.1) !important;
          box-shadow: inset 0 0 0 1px rgba(122, 162, 247, 0.3);
        }
        .status-success { color: var(--success); }
        .status-warning { color: var(--warning); }
        .status-danger { color: var(--danger); }
        .status-neutral { color: var(--muted); }
      </style>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
         <div style="display: flex; gap: 10px; align-items: center;">
           <label>Фильтр по пати:</label>
           <select id="party-filter-select" class="select" style="width: 200px;">
             <option value="all" ${filteredParty === 'all' ? 'selected' : ''}>Все пати</option>
             <option value="__none__" ${filteredParty === '__none__' ? 'selected' : ''}>Без пати</option>
             ${uniqueParties.map(p => 
               `<option value="${escapeHtml(p)}" ${filteredParty === p ? 'selected' : ''}>${escapeHtml(p)}</option>`
             ).join('')}
           </select>
         </div>

         <div style="display: flex; gap: 10px; align-items: center;">
           <label>Фильтр по заданию:</label>
           <select id="task-filter-select" class="select" style="width: 200px;">
             <option value="">Все задания</option>
             ${allTasksList.map(t => 
               `<option value="${t.id}" ${filteredTaskId === t.id ? 'selected' : ''}>${escapeHtml(t.title)}</option>`
             ).join('')}
           </select>
         </div>

         <div style="background: var(--panel-2); padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border);">
            <span class="muted" style="font-size:0.8rem;">Заработано всего:</span>
            <strong id="total-coins-display" style="color: gold; font-size:1.1rem;">🪙 ${totalEarnedCoins}</strong>
         </div>
      </div>

      <div class="table-wrapper" style="overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); position: relative;">
        <table class="marathon-table" style="width: 100%; border-collapse: collapse; font-size: 0.85rem; table-layout: fixed;">
          <thead>
            <tr style="background: var(--panel-2); position: sticky; top: 0; z-index: 20;">
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid var(--border); width: 150px; position: sticky; left: 0; background: var(--panel-2); z-index: 21;">Участник</th>
              <th style="padding: 12px; text-align: left; border-bottom: 1px solid var(--border); width: 280px; position: sticky; left: 150px; background: var(--panel-2); z-index: 21;">Задание & Статус</th>
              
              ${allDates.map(date => {
                const dayName = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short' });
                const dayNum = date.slice(-2);
                const isToday = date === todayStr;
                
                return `
                  <th style="padding: 8px 4px; text-align: center; border-bottom: 1px solid var(--border); min-width: 40px;" title="${date}" class="${isToday ? 'current-day-header' : ''}">
                    <div style="font-weight: bold; color: ${isToday ? 'var(--accent)' : 'inherit'}; font-size: 0.8rem;">${dayName}</div>
                    <div class="muted" style="font-size: 0.75rem;">${dayNum}</div>
                  </th>
                `;
              }).join('')}
            </tr>
          </thead>
          
          <tbody>
            ${rowsData.map(({ char, task }, rowIndex) => {
              const isFirstForRowForChar = rowIndex === 0 || rowsData[rowIndex - 1].char.id !== char.id;
              const countOfAssignedTasksForThisChar = rowsData.filter(r => r.char.id === char.id).length;
              
              // --- ЛОГИКА РАСЧЕТА СТАТУСА ---
              const target = Number(task.targetChecks) || 0;
              const completedCount = marathon.records.filter(r => 
                r.characterId === char.id && 
                r.taskId === task.id && 
                r.completed
              ).length;

              const totalActiveDays = getAvailableCheckCount(task, allDates);
              const maxAllowedMisses = Math.max(0, totalActiveDays - target);
              const passedActiveDays = getPastActiveDaysCount(task, allDates, todayStr);
              const currentMisses = Math.max(0, passedActiveDays - completedCount);

              let statusText = '';
              let statusClass = 'status-neutral';
              let barColor = 'var(--accent)';

              if (completedCount >= target) {
                statusText = '✅ Задание завершено';
                statusClass = 'status-success';
                barColor = 'var(--success)';
              } else if (currentMisses > maxAllowedMisses) {
                statusText = `❌ Провалено (пропущено: ${currentMisses}, лимит: ${maxAllowedMisses})`;
                statusClass = 'status-danger';
                barColor = 'var(--danger)';
              } else {
                const remainingSpare = maxAllowedMisses - currentMisses;
                statusText = `⏳ Запасных дней: ${remainingSpare}`;
                statusClass = 'status-warning';
                barColor = 'var(--accent)';
              }

              const percentage = target > 0 
                ? Math.min(100, Math.round((completedCount / target) * 100)) 
                : 0;

              return `
                <tr style="border-bottom: 1px solid var(--border); height: 44px;">
                  
                  ${isFirstForRowForChar ? `
                    <td rowspan="${countOfAssignedTasksForThisChar}" style="padding: 12px; font-weight: 600; position: sticky; left: 0; background: var(--panel); z-index: 10; vertical-align: middle; border-right: 1px solid var(--border);">
                      ${escapeHtml(char.nick)}
                      <div class="muted" style="font-size: 0.75rem; font-weight: normal;">${escapeHtml(char.class)}</div>
                    </td>
                  ` : ''}

                  <td style="padding: 8px 12px; position: sticky; left: 150px; background: var(--panel); z-index: 10; vertical-align: middle; border-right: 1px solid var(--border);">
                     <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                       <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;" title="${escapeHtml(task.title)}">
                         ${escapeHtml(task.title)}
                       </span>
                       <span id="prog-${char.id}-${task.id}-pct" style="font-size: 0.75rem; color: ${barColor}; font-weight: bold;">${percentage}%</span>
                     </div>
                     
                     <div style="height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin-bottom: 4px;">
                       <div id="prog-${char.id}-${task.id}-bar" style="height: 100%; width: ${percentage}%; background: ${barColor}; transition: width 0.3s;"></div>
                     </div>
                     
                     <div style="font-size: 0.7rem; font-weight: 500;" class="${statusClass}" id="prog-${char.id}-${task.id}-status">
                        ${statusText}
                     </div>
                  </td>
                  
                  ${allDates.map(date => {
                    const isActive = isTaskActiveOnDate(task, date, allDates);
                    const isToday = date === todayStr;
                    
                    if (!isActive) {
                      return `<td style="text-align: center; background: rgba(0,0,0,0.1);" class="${isToday ? 'current-day-cell' : ''}"></td>`;
                    }
                    
                    const hasRecord = recordMap.has(`${char.id}_${task.id}_${date}`);
                    
                    return `
                      <td style="text-align: center; vertical-align: middle;" class="${isToday ? 'current-day-cell' : ''}">
                        <label style="cursor: pointer; display: block; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; position: relative; z-index: 5;">
                          <input type="checkbox" 
                                 class="record-checkbox"
                                 data-char-id="${char.id}" 
                                 data-task-id="${task.id}" 
                                 data-date="${date}"
                                 ${hasRecord ? 'checked' : ''}
                                 style="margin: 0; transform: scale(1.2); cursor: pointer; position: relative; z-index: 10;" />
                        </label>
                      </td>
                    `;
                  }).join('')}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    return html;

  } catch (err) {
    console.error('[MARATHON TABLE GENERATION ERROR]', err);
    return `<div class="empty-state" style="color: red; padding: 20px;">
      Критическая ошибка генерации таблицы.<br/>
      Сообщение: ${escapeHtml(err.message)}<br/>
      <small>Проверьте целостность данных марафона.</small>
    </div>`;
  }
}
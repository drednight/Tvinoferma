// js/marathonRewards.js

import { state } from './state.js';
import { persist } from './storage.js';
import { nowISO, uid } from './utils.js';
import { toast, confirmDialog } from './ui.js';
import { renderMarathons } from './marathon.js';
import { getAllDatesInRange, isTaskActiveOnDate } from './marathonUtils.js';

/**
 * Завершает марафон: считает награды, начисляет монеты и блокирует редактирование.
 */
export function completeMarathon(marathonId) {
  const marathon = state.marathons.find(m => m.id === marathonId);
  if (!marathon) {
    toast('Марафон не найден', 'error');
    return;
  }

  if (marathon.status === 'completed') {
    toast('Марафон уже завершен', 'info');
    return;
  }

  if (!confirmDialog('Вы уверены, что хотите завершить марафон?\nПосле этого таблица будет заблокирована, а монеты начислены.')) {
    return;
  }

  console.group('[COMPLETE MARATHON] Start processing...');
  
  let totalAwardsCount = 0;
  let totalCoinsAwarded = 0;
  const awardsLog = []; 

  // 1. Обрабатываем каждого участника
  marathon.participantIds.forEach(charId => {
    const character = state.characters.find(c => c.id === charId);
    if (!character) return;

    const assignedTaskIds = marathon.participantAssignments[charId] || [];
    const relevantTasks = assignedTaskIds.length > 0 
      ? marathon.tasks.filter(t => assignedTaskIds.includes(t.id))
      : marathon.tasks;

    relevantTasks.forEach(task => {
      const completedRecords = marathon.records.filter(r => 
        r.characterId === charId && 
        r.taskId === task.id && 
        r.completed
      );
      const completedCount = completedRecords.length;
      const target = Number(task.targetChecks) || 0;
      
      const hasStages = task.stages && task.stages.length > 0;
      let coinsToAward = 0;
      let awardDescription = "";
      let stageIdForHistory = null;

      // ЛОГИКА НАГРАДЫ
      if (hasStages) {
        // 1. Ищем максимальный пройденный этап
        const sortedStages = [...task.stages].sort((a, b) => a.threshold - b.threshold);
        let reachedStage = null;
        
        for (let i = 0; i < sortedStages.length; i++) {
          if (completedCount >= sortedStages[i].threshold) {
            reachedStage = sortedStages[i];
          } else {
            break;
          }
        }

        if (reachedStage) {
          coinsToAward = Number(reachedStage.rewardCoins) || 0;
          awardDescription = `Награда за этап "${reachedStage.rewardText}"`;
          stageIdForHistory = reachedStage.id;
        }
      } else {
        // 2. Если этапов нет, проверяем базовую цель
        if (completedCount >= target && target > 0) {
          coinsToAward = Number(task.baseRewardCoins) || 0;
          awardDescription = `Выполнение задания "${task.title}"`;
        }
      }

      // НАЧИСЛЕНИЕ МОНЕТ, ЕСЛИ ОНИ БОЛЬШЕ 0
      if (coinsToAward > 0) {
        character.ancientCoins += coinsToAward;
        
        const historyEntry = {
          id: uid(),
          delta: coinsToAward,
          balanceAfter: character.ancientCoins,
          note: `${awardDescription} в марафоне "${marathon.title}"`,
          source: 'marathon_completion',
          marathonId: marathon.id,
          taskId: task.id,
          stageId: stageIdForHistory,
          createdAt: nowISO()
        };
        
        character.coinHistory.push(historyEntry);
        character.updatedAt = nowISO();

        totalCoinsAwarded += coinsToAward;
        totalAwardsCount++;
        
        awardsLog.push({
          charNick: character.nick,
          taskTitle: task.title,
          description: awardDescription,
          coins: coinsToAward
        });
      }
    });
  });

  // 2. Обновляем статус марафона
  marathon.status = 'completed';
  marathon.completedAt = nowISO();
  marathon.updatedAt = nowISO();
  marathon.awards = awardsLog.map(a => ({ ...a, awardedAt: nowISO() }));

  console.log(`Total awards issued: ${totalAwardsCount}`);
  console.log(`Total coins added: ${totalCoinsAwarded}`);
  console.groupEnd();

  // 3. Сохраняем всё на диск
  persist().then(() => {
    renderMarathons();
    
    if (totalAwardsCount > 0) {
      toast(`Марафон завершен! Выдано ${totalAwardsCount} наград (${totalCoinsAwarded} монет).`, 'success');
    } else {
      toast('Марафон завершен. Наград не найдено (проверьте настройки этапов или цели).', 'warning');
    }
  }).catch(err => {
    console.error('[SAVE ERROR]', err);
    toast('Ошибка сохранения данных', 'error');
  });
}

/**
 * Открывает завершенный марафон для правки (откат наград)
 */
export function reopenMarathonForEditing(marathonId) {
  const marathon = state.marathons.find(m => m.id === marathonId);
  if (!marathon) return;

  if (!confirmDialog('Внимание!\nВы открываете завершенный марафон.\nВсе начисленные за него монеты будут ОТМЕНЕНЫ из баланса персонажей.')) {
    return;
  }

  // 1. Откат монет и удаление записей из истории
  state.characters.forEach(char => {
    const entriesToRemove = char.coinHistory.filter(h => h.marathonId === marathonId);
    
    let totalRemovedCoins = 0;
    entriesToRemove.forEach(entry => {
      totalRemovedCoins += entry.delta;
    });

    if (totalRemovedCoins !== 0) {
      char.ancientCoins -= totalRemovedCoins;
      if (char.ancientCoins < 0) char.ancientCoins = 0;
      
      char.coinHistory = char.coinHistory.filter(h => h.marathonId !== marathonId);
      char.updatedAt = nowISO();
      
      console.log(`Reverted ${totalRemovedCoins} coins for ${char.nick}`);
    }
  });

  // 2. Сбрасываем данные марафона
  marathon.awards = [];
  marathon.status = 'active';
  marathon.completedAt = null;
  marathon.updatedAt = nowISO();

  persist().then(() => {
    renderMarathons();
    toast('Марафон открыт для редактирования. Монеты отменены.', 'warning');
  });
}

/**
 * Пересчитывает награды для ЗАВЕРШЕННОГО марафона после изменения его конфигурации.
 * Вызывается из формы редактирования, если был сохранен завершенный марафон.
 */
export function recalculateMarathonAwards(marathonId) {
  const marathon = state.marathons.find(m => m.id === marathonId);
  if (!marathon || marathon.status !== 'completed') {
    console.warn('[RECALC] Marathon not found or not completed.');
    return false;
  }

  console.group(`[RECALC] Recalculating awards for ${marathon.title}`);

  // 1. ОТКАТ СТАРЫХ НАЧИСЛЕНИЙ
  state.characters.forEach(char => {
    const transactionsToRemove = char.coinHistory.filter(h => h.marathonId === marathonId);
    
    let totalRemoved = 0;
    transactionsToRemove.forEach(tx => {
      totalRemoved += tx.delta;
    });

    if (totalRemoved > 0) {
      char.ancientCoins -= totalRemoved;
      if (char.ancientCoins < 0) char.ancientCoins = 0;
      
      char.coinHistory = char.coinHistory.filter(h => h.marathonId !== marathonId);
      char.updatedAt = nowISO();
      
      console.log(`Reverted ${totalRemoved} coins for ${char.nick}`);
    }
  });

  // 2. НОВЫЙ РАСЧЕТ И НАЧИСЛЕНИЕ
  let totalNewCoins = 0;
  const newAwardsLog = [];

  marathon.participantIds.forEach(charId => {
    const character = state.characters.find(c => c.id === charId);
    if (!character) return;

    const assignedTaskIds = marathon.participantAssignments[charId] || [];
    const relevantTasks = assignedTaskIds.length > 0 
      ? marathon.tasks.filter(t => assignedTaskIds.includes(t.id))
      : marathon.tasks;

    relevantTasks.forEach(task => {
      const completedRecords = marathon.records.filter(r => 
        r.characterId === charId && 
        r.taskId === task.id && 
        r.completed
      );
      const completedCount = completedRecords.length;
      const target = Number(task.targetChecks) || 0;
      
      const hasStages = task.stages && task.stages.length > 0;
      let coinsToAward = 0;
      let awardDescription = "";
      let stageIdForHistory = null;

      if (hasStages) {
        const sortedStages = [...task.stages].sort((a, b) => a.threshold - b.threshold);
        let reachedStage = null;
        
        for (let i = 0; i < sortedStages.length; i++) {
          if (completedCount >= sortedStages[i].threshold) {
            reachedStage = sortedStages[i];
          } else {
            break;
          }
        }

        if (reachedStage) {
          coinsToAward = Number(reachedStage.rewardCoins) || 0;
          awardDescription = `Награда за этап "${reachedStage.rewardText}"`;
          stageIdForHistory = reachedStage.id;
        }
      } else {
        if (completedCount >= target && target > 0) {
          coinsToAward = Number(task.baseRewardCoins) || 0;
          awardDescription = `Выполнение задания "${task.title}"`;
        }
      }

      if (coinsToAward > 0) {
        character.ancientCoins += coinsToAward;
        
        const historyEntry = {
          id: uid(),
          delta: coinsToAward,
          balanceAfter: character.ancientCoins,
          note: `${awardDescription} (Пересчет) в марафоне "${marathon.title}"`,
          source: 'marathon_recalculation',
          marathonId: marathon.id,
          taskId: task.id,
          stageId: stageIdForHistory,
          createdAt: nowISO()
        };
        
        character.coinHistory.push(historyEntry);
        character.updatedAt = nowISO();

        totalNewCoins += coinsToAward;
        
        newAwardsLog.push({
          charNick: character.nick,
          taskTitle: task.title,
          description: awardDescription,
          coins: coinsToAward
        });
      }
    });
  });

  // 3. ОБНОВЛЯЕМ ЛОГ НАГРАД ВНУТРИ МАРАФОНА
  marathon.awards = newAwardsLog.map(a => ({ ...a, awardedAt: nowISO() }));
  marathon.updatedAt = nowISO();

  console.log(`Recalculation finished. Total new coins: ${totalNewCoins}`);
  console.groupEnd();

  return true;
}
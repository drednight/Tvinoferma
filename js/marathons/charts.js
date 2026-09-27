// js/marathons/charts.js
import { Chart, registerables } from 'chart.js';
import { showModal } from '../ui.js';
import { state } from '../state.js';
import { escapeHtml } from '../utils.js';

Chart.register(...registerables);

export function showMarathonInfographic(marathonId) {
  const marathon = state.marathons.find(m => m.id === marathonId);
  if (!marathon) return;

  // Подготовка данных
  const participants = marathon.participantIds.map(pid => {
    const char = state.characters.find(c => c.id === pid);
    return char ? char.nick : 'Unknown';
  });

  // Данные для столбчатой диаграммы (Выполнено заданий каждым участником)
  const taskCompletionData = participants.map(pNick => {
    const char = state.characters.find(c => c.nick === pNick);
    if (!char) return 0;
    
    // Считаем общее кол-во галочек у персонажа в этом марафоне
    const recordsCount = marathon.records.filter(r => r.characterId === char.id && r.completed).length;
    return recordsCount;
  });

  // Данные для круговой диаграммы (Распределение монет между участниками)
  const coinsPerParticipant = participants.map(pNick => {
     const char = state.characters.find(c => c.nick === pNick);
     if (!char) return 0;
     
     // Суммируем награды из awards массива марафона для этого персонажа
     const earned = marathon.awards
       .filter(a => a.charNick === pNick || a.characterId === char.id)
       .reduce((sum, a) => sum + (Number(a.coins) || Number(a.rewardCoins) || 0), 0);
     return earned;
  });

  const content = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; height: 400px;">
      <div>
        <h4 style="text-align:center; margin-bottom:10px;">Активность участников</h4>
        <canvas id="activity-chart"></canvas>
      </div>
      <div>
        <h4 style="text-align:center; margin-bottom:10px;">Распределение наград (монеты)</h4>
        <canvas id="rewards-chart"></canvas>
      </div>
    </div>
    <div style="margin-top: 20px; padding: 10px; background: var(--panel-2); border-radius: 8px;">
      <p><strong>Название:</strong> ${escapeHtml(marathon.title)}</p>
      <p><strong>Период:</strong> ${marathon.startDate} — ${marathon.endDate}</p>
      <p><strong>Статус:</strong> Завершен</p>
      <p><strong>Всего начислено монет:</strong> 🪙 ${coinsPerParticipant.reduce((a,b)=>a+b,0)}</p>
    </div>
  `;

  showModal({
    title: 'Инфографика марафона',
    content,
    submitText: 'Закрыть',
    onSubmit: () => true,
    onClose: () => {} // Ничего не делаем при закрытии
  });

  // Инициализация графиков после рендера модалки
  setTimeout(() => {
    const activityCtx = document.getElementById('activity-chart');
    const rewardsCtx = document.getElementById('rewards-chart');

    if (activityCtx) {
      new Chart(activityCtx, {
        type: 'bar',
        data: {
          labels: participants,
          datasets: [{
            label: 'Выполнено задач',
            data: taskCompletionData,
            backgroundColor: 'rgba(54, 162, 235, 0.6)',
            borderColor: 'rgb(54, 162, 235)',
            borderWidth: 1
          }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }

    if (rewardsCtx) {
      new Chart(rewardsCtx, {
        type: 'doughnut',
        data: {
          labels: participants,
          datasets: [{
            label: 'Монеты',
            data: coinsPerParticipant,
            backgroundColor: [
              '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40'
            ].slice(0, participants.length)
          }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }
  }, 100);
}
// js/modules/marathons/charts.js
import { Chart, registerables } from 'chart.js';
import { state } from '../../core/state.js';
import { escapeHtml } from '../../core/utils.js';
import { openOverlay } from './overlay.js';
import { marathonTotals } from './model.js';

Chart.register(...registerables);

export function showMarathonInfographic(marathonId) {
  const m = state.marathons.find(x => x.id === marathonId);
  if (!m) return;
  const t = marathonTotals(m);
  const ids = m.participantIds.filter(id => t.perChar[id]);
  const labels = ids.map(id => state.characters.find(c => c.id === id)?.nick || '—');
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8b93a7';

  const ov = openOverlay({ title: `📊 ${m.title}`, wide: true });
  ov.body.innerHTML = `
    <div class="mr-two">
      <div class="panel"><h4>Выполнено заданий</h4><div style="height:320px"><canvas id="mr-chart-done"></canvas></div></div>
      <div class="panel"><h4>Награды (ДМ)</h4><div style="height:320px"><canvas id="mr-chart-coins"></canvas></div></div>
    </div>
    <p class="muted">Период: ${escapeHtml(m.startDate)} — ${escapeHtml(m.endDate)} · Всего: 🪙 ${t.coins} из ${t.maxCoins} возможных</p>`;

  const common = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: muted } } } };
  new Chart(document.getElementById('mr-chart-done'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Выполнено', data: ids.map(id => t.perChar[id].done), backgroundColor: '#9ece6a' },
      { label: 'Назначено', data: ids.map(id => t.perChar[id].assigned - t.perChar[id].done), backgroundColor: '#252c3b' }
    ] },
    options: { ...common, scales: { x: { stacked: true, ticks: { color: muted } }, y: { stacked: true, ticks: { color: muted, precision: 0 } } } }
  });
  new Chart(document.getElementById('mr-chart-coins'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'ДМ', data: ids.map(id => t.perChar[id].coins), backgroundColor: '#e0af68' }] },
    options: { ...common, indexAxis: 'y', scales: { x: { ticks: { color: muted } }, y: { ticks: { color: muted } } } }
  });
}

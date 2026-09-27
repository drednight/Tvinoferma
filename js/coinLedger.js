import { state } from './state.js';
import { persist } from './storage.js';
import { escapeHtml, formatNumber, nowISO, toInt, uid } from './utils.js';
import { showModal, toast } from './ui.js';
import { renderCharacters } from './characters.js';

function findCharacter(id) {
  return state.characters.find((c) => c.id === id);
}

export function openCoinModal(characterId, direction) {
  const character = findCharacter(characterId);
  if (!character) return;

  const isAdd = direction === 'add';
  const title = isAdd ? 'Добавить древние монеты' : 'Списать древние монеты';

  const content = `
    <div class="form-grid">
      <div class="field">
        <label>Количество</label>
        <input class="input" name="amount" type="number" min="1" step="1" value="1" required />
      </div>

      <div class="field">
        <label>Примечание</label>
        <textarea class="textarea" name="note" rows="3" placeholder="Откуда / куда" required></textarea>
      </div>
    </div>
  `;

  showModal({
    title,
    content,
    submitText: isAdd ? 'Добавить' : 'Списать',
    onSubmit(formData, { setError }) {
      const amount = toInt(formData.get('amount'), 0);
      const note = String(formData.get('note') || '').trim();

      if (amount <= 0) {
        setError('Количество должно быть больше нуля.');
        return false;
      }

      if (!note) {
        setError('Примечание обязательно.');
        return false;
      }

      if (!isAdd && amount > character.ancientCoins) {
        setError('Недостаточно древних монет.');
        return false;
      }

      const delta = isAdd ? amount : -amount;

      character.ancientCoins = Math.max(0, Number(character.ancientCoins || 0) + delta);
      character.coinHistory.push({
        id: uid(),
        delta,
        note,
        source: 'manual',
        marathonId: null,
        taskId: null,
        stageId: null,
        createdAt: nowISO()
      });
      character.updatedAt = nowISO();

      persist();
      renderCharacters();
      toast(isAdd ? 'Монеты добавлены' : 'Монеты списаны', 'success');
    }
  });
}

export function showCoinHistory(characterId) {
  const character = findCharacter(characterId);
  if (!character) return;

  const items = [...(character.coinHistory || [])]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((entry) => {
      const positive = entry.delta >= 0;
      return `
        <div class="history-item">
          <div>
            <span class="delta ${positive ? 'positive' : 'negative'}">
              ${positive ? '+' : ''}${formatNumber(entry.delta)}
            </span>
            <strong style="margin-left:8px">${escapeHtml(entry.note)}</strong>
          </div>
          <div class="muted" style="margin-top:6px">
            ${new Date(entry.createdAt).toLocaleString('ru-RU')} · ${escapeHtml(entry.source)}
          </div>
        </div>
      `;
    })
    .join('');

  showModal({
    title: `История монет: ${character.nick}`,
    content: `<div class="history-list">${items || '<div class="empty-state">История пуста</div>'}</div>`
  });
}
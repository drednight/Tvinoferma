// js/importExport.js

import { normalizeState, serializeState, state } from './state.js';
import { persist, saveNow } from './storage.js';
import { escapeHtml, nowISO } from './utils.js';
import { showModal, toast, confirmDialog } from './ui.js';
import { renderCharacters } from './characters.js';
import { renderParties } from './parties.js';
import { renderMarathons } from './marathon.js';

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderAll() {
  renderCharacters();
  renderParties();
  renderMarathons();
}

function applyImport(incoming, mode) {
  const parsed = normalizeState(incoming);

  if (mode === 'replace') {
    state.parties = parsed.parties;
    state.characters = parsed.characters;
    state.marathons = parsed.marathons;
    state.settings = parsed.settings;
  }

  if (mode === 'addOnly') {
    const existingPartyNames = new Set(state.parties.map((p) => p.name));
    parsed.parties.forEach((party) => {
      if (!existingPartyNames.has(party.name)) {
        state.parties.push(party);
        existingPartyNames.add(party.name);
      }
    });

    const existingCharacterIds = new Set(state.characters.map((c) => c.id));
    parsed.characters.forEach((character) => {
      if (!existingCharacterIds.has(character.id)) {
        state.characters.push(character);
        existingCharacterIds.add(character.id);
      }
    });

    const existingMarathonIds = new Set(state.marathons.map((m) => m.id));
    parsed.marathons.forEach((marathon) => {
      if (!existingMarathonIds.has(marathon.id)) {
        state.marathons.push(marathon);
        existingMarathonIds.add(marathon.id);
      }
    });
  }

  if (mode === 'mergeLWW') {
    const partyMap = new Map(state.parties.map((p) => [p.name, p]));
    parsed.parties.forEach((party) => {
      const local = partyMap.get(party.name);
      if (!local || new Date(party.updatedAt) > new Date(local.updatedAt)) {
        partyMap.set(party.name, party);
      }
    });
    state.parties = Array.from(partyMap.values());

    const characterMap = new Map(state.characters.map((c) => [c.id, c]));
    parsed.characters.forEach((character) => {
      const local = characterMap.get(character.id);
      if (!local) {
        characterMap.set(character.id, character);
        return;
      }

      if (new Date(character.updatedAt) > new Date(local.updatedAt)) {
        characterMap.set(character.id, {
          ...character,
          coinHistory: []
        });
      }
    });
    state.characters = Array.from(characterMap.values());

    const marathonMap = new Map(state.marathons.map((m) => [m.id, m]));
    parsed.marathons.forEach((marathon) => {
      const local = marathonMap.get(marathon.id);
      if (!local || new Date(marathon.updatedAt) > new Date(local.updatedAt)) {
        marathonMap.set(marathon.id, marathon);
      }
    });
    state.marathons = Array.from(marathonMap.values());
  }

  persist();
  renderAll();
  toast('Импорт завершён', 'success');
}

export function bindData() {
  document.getElementById('export-all-btn').addEventListener('click', async () => {
    await saveNow();
    const data = serializeState();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJson(data, `tvinoferma-export-${stamp}.json`);
    toast('Экспорт выполнен', 'success');
  });

  document.getElementById('import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      showModal({
        title: 'Режим импорта',
        content: `
          <div class="form-grid">
            <label class="field">
              <input type="radio" name="mode" value="replace" checked />
              <span>Заменить всё</span>
            </label>

            <label class="field">
              <input type="radio" name="mode" value="addOnly" />
              <span>Добавить только новое</span>
            </label>

            <label class="field">
              <input type="radio" name="mode" value="mergeLWW" />
              <span>Слить: last write wins</span>
            </label>

            <p class="muted">
              При слиянии, если импортируемая версия персонажа новее, локальная история монет будет очищена.
            </p>
          </div>
        `,
        submitText: 'Импортировать',
        onSubmit(formData) {
          const mode = String(formData.get('mode'));
          applyImport(json, mode);
        }
      });
    } catch (error) {
      toast(`Ошибка импорта: ${error.message}`, 'error');
    }
  });

  // НОВЫЙ ОБРАБОТЧИК ДЛЯ КНОПКИ В РАЗДЕЛЕ ДАННЫЕ
  const clearAllBtn = document.getElementById('clear-all-characters-btn');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      if (!state.characters.length) {
        toast('Список уже пуст', 'info');
        return;
      }

      if (!confirmDialog('Вы уверены, что хотите удалить ВСЕХ персонажей?\nЭто действие нельзя отменить.')) {
        return;
      }

      state.characters = [];
      state.ui.expandedCharacterId = null; // Сбрасываем раскрытие
      
      persist();
      renderCharacters(); // Перерисовываем только персонажей, так как мы на другой вкладке, но данные изменятся
      toast('Все персонажи удалены', 'success');
    });
  }
}
// js/modules/characters/formEditor.js

import { state, normalizeTags } from '../../core/state.js';
import { persist, isTauri } from '../../core/storage.js';
import { escapeHtml, nowISO } from '../../core/utils.js';
import { roundCoins, applyCoinBalance } from '../../core/coins.js';
import { showModal, toast } from '../../core/ui.js';
import { renderCharacters, allTags } from './list.js';
import { renderParties } from '../parties/index.js';
import { CLASSES, SKIES, SKY_LEVELS } from '../../core/constants.js';
import { createEmptyCharacter, DEFAULT_STATS } from './stateManager.js';
import { newCharacterId, syncIdWithNick } from './identity.js';
import { vaultStatus } from '../../core/secrets.js';
import { normalizePartyIds } from '../parties/membership.js';

export function openCharacterForm(char = null) {
  const isEdit = !!char;
  
  // Используем хелпер из stateManager для получения базы данных
  const currentChar = char || createEmptyCharacter();
  
  const stats = { ...DEFAULT_STATS, ...(currentChar.stats || {}) };
  const passes = currentChar.dungeonPasses || { weapon: 0, armor: 0, relic: 0 };
  const sky = currentChar.sky || { name: '', level: '' };
  const contacts = currentChar.contacts || { email: '', password: '', recoveryEmail: '', phone: '' };

  const classOptions = CLASSES.map(c => `<option value="${escapeHtml(c)}" ${currentChar.class === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
  const noneClassOption = `<option value="" ${!currentChar.class ? 'selected' : ''}>— Выберите класс —</option>`;

  // Основная пати (одна) + дополнительные (чипы). Монеты и выбор в марафон идут по основной.
  const mainId = currentChar.mainPartyId || null;
  const extraIdsSet = new Set((currentChar.partyIds || []).filter(id => id !== mainId));
  const mainOptions = `<option value="">— Без пати —</option>` + state.parties.map(p =>
    `<option value="${escapeHtml(p.id)}" ${mainId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  const partyChips = state.parties.length
    ? state.parties.map(p => `<label class="party-chip"><input type="checkbox" name="extraPartyIds" value="${escapeHtml(p.id)}" ${extraIdsSet.has(p.id) ? 'checked' : ''} ${mainId === p.id ? 'disabled' : ''} /><span>${escapeHtml(p.name)}</span></label>`).join('')
    : '<span class="muted">Пока нет пати. Создайте их во вкладке «Пати».</span>';

  const skyNameOptions = SKIES.map(s => `<option value="${escapeHtml(s)}" ${sky.name === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
  const noneSkyOption = `<option value="" ${!sky.name ? 'selected' : ''}>— Не выбрано —</option>`;

  const skyLevelOptions = SKY_LEVELS.map(l => `<option value="${l}" ${sky.level == l ? 'selected' : ''}>${l}</option>`).join('');
  const noneSkyLevelOption = `<option value="" ${!sky.level ? 'selected' : ''}>—</option>`;

  const statInput = (key, label) => `
    <div class="field">
      <label>${label}</label>
      <input class="input" type="number" name="stat-${key}" value="${stats[key]}" min="0" />
    </div>
  `;

  // Получаем текущий баланс и дату обновления для отображения подсказки
  const currentCoins = currentChar.ancientCoins || 0;
  const lastUpdateHint = currentChar.lastCoinUpdate 
    ? `(Последняя синхр.: ${new Date(currentChar.lastCoinUpdate).toLocaleDateString()})` 
    : '(Еще не синхронизировалось)';

  const content = `
    <div class="form-grid">
      <!-- Базовая информация -->
      <div class="two-cols">
        <div class="field"><label>Никнейм *</label><input class="input" name="nick" value="${escapeHtml(currentChar.nick)}" required autofocus /></div>
        <div class="field">
          <label>Класс</label>
          <select class="select" name="class">
            ${noneClassOption}
            ${classOptions}
          </select>
        </div>
      </div>
      <div class="two-cols">
        <div class="field"><label>Уровень</label><input class="input" type="number" name="level" value="${currentChar.level}" min="1" /></div>
        <div class="field"><label>Основная пати</label><select class="select" name="mainParty" id="char-main-party">${mainOptions}</select></div>
      </div>
      <div class="field"><label>Дополнительные пати <small class="muted">(если нужны; монеты и марафоны считаются по основной)</small></label><div class="party-chips" id="char-extra-parties">${partyChips}</div></div>

      <!-- Небо -->
      <div class="info-block" style="margin-top:16px;"><h4>Небо (Sky)</h4>
        <div class="two-cols">
          <div class="field">
            <label>Название неба</label>
            <select class="select" name="sky-name">
              ${noneSkyOption}
              ${skyNameOptions}
            </select>
          </div>
          <div class="field">
            <label>Уровень неба</label>
            <select class="select" name="sky-level">
              ${noneSkyLevelOption}
              ${skyLevelOptions}
            </select>
          </div>
        </div>
      </div>

      <!-- ТЕГИ -->
      <div class="field" style="margin-top:16px;">
        <label>Теги (через запятую: «основа, твин, крафт»)</label>
        <input class="input" type="text" name="tags" list="char-tag-list" autocomplete="off" value="${escapeHtml((currentChar.tags || []).join(', '))}" />
        <datalist id="char-tag-list">${allTags().map(t => `<option value="${escapeHtml(t)}"></option>`).join('')}</datalist>
      </div>

      <!-- КОНТАКТЫ (ТЕПЕРЬ ЗДЕСЬ, ПЕРЕД СТАТАМИ) -->
      <details style="margin-top:16px; border:1px solid var(--border); padding:8px; border-radius:4px;" open>
        <summary style="cursor:pointer; font-weight:bold; color:var(--muted);">Контактные данные (для входа)</summary>
        ${vaultStatus().ready ? '<p class="muted" style="font-size:0.75rem; margin:6px 0 0;">🔒 Хранятся в защищённом хранилище учётных данных ОС, а не в state.json</p>' : ''}
        <div class="form-grid" style="margin-top:12px;">
          <div class="field"><label>Email / Логин</label><input class="input" type="text" name="contact-email" value="${escapeHtml(contacts.email)}" /></div>
          <div class="field"><label>Пароль</label><input class="input" type="text" name="contact-password" value="${escapeHtml(contacts.password)}" /></div>
          <div class="field"><label>Recovery Email</label><input class="input" type="email" name="contact-recovery" value="${escapeHtml(contacts.recoveryEmail)}" /></div>
          <div class="field"><label>Телефон</label><input class="input" type="tel" name="contact-phone" value="${escapeHtml(contacts.phone)}" /></div>
        </div>
      </details>

      <!-- ХАРАКТЕРИСТИКИ: одним сворачиваемым блоком, чтобы форма не была простыней -->
      <details class="info-block stats-fold" style="margin-top:16px;" open>
        <summary>
          <span class="stats-fold-title">📊 Характеристики</span>
          <span class="stats-fold-note muted">Основные, бой и защита, показатели боя, PvE и пробивание</span>
        </summary>
        <div class="stats-fold-body">
          <div class="stat-head">
            <h4>Основные характеристики</h4>
          </div>
          <div class="four-cols">
            ${statInput('endurance', 'Выносливость')}
            ${statInput('intelligence', 'Интеллект')}
            ${statInput('strength', 'Сила')}
            ${statInput('agility', 'Ловкость')}
          </div>

          <h4 class="stats-sub">Бой и Защита</h4>
          <div class="four-cols">
            ${statInput('hp', 'Здоровье')}
            ${statInput('mp', 'Маг. энергия')}
            ${statInput('levelBonus', 'Бонус к уровню (%)')}
          </div>
          <div class="four-cols">
            ${statInput('physAttack', 'Физ. атака')}
            ${statInput('physDefense', 'Физ. защита')}
            ${statInput('magAttack', 'Маг. атака')}
            ${statInput('magDefense', 'Маг. защита')}
          </div>

          <h4 class="stats-sub">Показатели боя</h4>
          <div class="three-cols">
            ${statInput('critChance', 'Шанс крит. удара (%)')}
            ${statInput('critDamage', 'Крит. урон (%)')}
            ${statInput('atkSpeed', 'Скорость атаки')}
          </div>
          <div class="three-cols">
            ${statInput('evasion', 'Уклонение')}
            ${statInput('accuracy', 'Меткость')}
            ${statInput('pa', 'Показатель атаки (ПА)')}
          </div>
          <div class="two-cols">
            ${statInput('pz', 'Показатель защиты (ПЗ)')}
            ${statInput('morale', 'Боевой дух')}
          </div>

          <h4 class="stats-sub">PvE и Пробивание</h4>
          <div class="two-cols">
            ${statInput('pvePa', 'Урон по монстрам (PvE PA)')}
            ${statInput('pvePz', 'Защита от монстров (PvE PZ)')}
          </div>
          <div class="two-cols">
            ${statInput('physPenetration', 'Физ. пробивание')}
            ${statInput('magPenetration', 'Маг. пробивание')}
          </div>
        </div>
      </details>

      <!-- Проходки в данжи -->
      <div class="info-block" style="margin-top:16px;"><h4>Проходки в данжи</h4>
        <div class="three-cols">
          <div class="field"><label>Оружие</label><input class="input" type="number" name="pass-weapon" value="${passes.weapon}" min="0" /></div>
          <div class="field"><label>Броня</label><input class="input" type="number" name="pass-armor" value="${passes.armor}" min="0" /></div>
          <div class="field"><label>Реликвии</label><input class="input" type="number" name="pass-relic" value="${passes.relic}" min="0" /></div>
        </div>
      </div>

      <!-- БЛОК ДРЕВНИХ МОНЕТ (В САМОМ НИЗУ) -->
      <div class="info-block" style="margin-top:16px; background:rgba(255,215,0,0.05); padding:12px; border-radius:4px; border:1px solid rgba(255,215,0,0.2);">
        <h4 style="color:gold; margin-top:0;">💰 Древние монеты</h4>
        <div class="field">
          <label>Текущий баланс (можно изменить вручную)</label>
          <input class="input" type="number" name="coins" value="${currentCoins}" min="0" step="0.1" style="font-size:1.2rem; font-weight:bold; color:gold;" />
          <small class="help-text" style="display:block; margin-top:4px; color:#888;">
             ${lastUpdateHint}
          </small>
        </div>
      </div>
    </div>
  `;

  // Выбранная основная пати не может быть и дополнительной
  setTimeout(() => {
    const sel = document.getElementById('char-main-party');
    const box = document.getElementById('char-extra-parties');
    if (!sel || !box) return;
    const sync = () => box.querySelectorAll('input').forEach(cb => {
      const isMain = cb.value === sel.value;
      cb.disabled = isMain;
      if (isMain) cb.checked = false;
    });
    sel.addEventListener('change', sync);
  }, 0);

  // Разбор скриншота окна характеристик. Разметка формы появляется только внутри showModal
  // (ниже), поэтому обработчик вешается после её вызова — иначе кнопки в документе ещё нет.
  // Значения подставляем в поля по имени (stat-<ключ>); чего нет в ответе, то не трогаем.
  // Перенесённое окрашивается: зелёный — распознанное выше текущего, красный — ниже,
  // без цвета — совпадает (is-up/is-down снимаются, когда пользователь правит поле руками).
  const bindStatsOcr = () => {
    const btn = document.getElementById('btn-stats-ocr');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', () => {
      import('./statsImport.js').then(({ openStatsImport }) => openStatsImport({
        current: stats,
        onApply: (values) => {
          let applied = 0;
          for (const [key, value] of Object.entries(values)) {
            // Ищем поле в пределах формы. Ключи статов — простые латинские имена,
            // поэтому обходимся без CSS.escape (его нет в старых движках и в jsdom).
            const input = /** @type {HTMLInputElement | null} */ (
              document.querySelector(`#modal-root input[name="stat-${key}"]`)
            );
            if (!input) continue;
            const before = Number(input.value) || 0;
            input.value = String(value);
            applied++;
            // Подсвечиваем направление изменения: видно, что OCR завысил или занизил
            input.classList.remove('is-filled', 'is-up', 'is-down');
            if (value > before) input.classList.add('is-up');
            else if (value < before) input.classList.add('is-down');
            else input.classList.add('is-filled');
            input.addEventListener('input', () => {
              input.classList.remove('is-filled', 'is-up', 'is-down');
            }, { once: true });
          }
          toast(applied ? `Характеристик перенесено: ${applied}` : 'Нечего переносить', applied ? 'success' : 'warning');
        }
      })).catch(err => {
        console.error('[STATS OCR]', err);
        // Причина чаще всего одна: разбор скриншотов есть только в приложении
        toast(isTauri() ? 'Не удалось открыть разбор скриншота' : 'Разбор скриншота работает только в приложении', 'error');
      });
    });
  };

  showModal({
    title: isEdit ? `Редактировать: ${currentChar.nick}` : 'Новый персонаж',
    content,
    submitText: isEdit ? 'Сохранить изменения' : 'Создать персонажа',
    cancelText: 'Отмена',
    async onSubmit(formData, { setError }) {
      try {
        const getSafeStr = (name) => String(formData.get(name) || '').trim();
        
        const nick = getSafeStr('nick');
        if (!nick) { 
          setError('Никнейм обязателен.'); 
          return false; 
        }

        // Основная + дополнительные пати
        const mainPartyNext = String(formData.get('mainParty') || '') || null;
        const extras = normalizePartyIds(formData.getAll('extraPartyIds')).filter(id => id !== mainPartyNext);
        if (!mainPartyNext && extras.length) {
          setError('Выберите основную пати, чтобы добавить дополнительные.');
          return false;
        }
        const partyIdsNext = mainPartyNext ? [mainPartyNext, ...extras] : [];

        const newStats = {};
        Object.keys(DEFAULT_STATS).forEach(key => {
          const val = formData.get(`stat-${key}`);
          newStats[key] = val !== null && val !== undefined ? (parseInt(val, 10) || 0) : 0;
        });

        // Парсим новый баланс монет
        const rawCoins = formData.get('coins');
        // (число из <input type="number"> всегда с точкой; допускаем и запятую; округление до 0,1)
        const newCoinsVal = Number(String(rawCoins ?? '').replace(',', '.'));
        const finalCoins = isFinite(newCoinsVal) ? Math.max(0, roundCoins(newCoinsVal)) : 0;

        // Логика обработки изменения монет: запись в историю и дата — только если баланс изменился
        const coinState = {
          ancientCoins: currentChar.ancientCoins || 0,
          lastCoinUpdate: currentChar.lastCoinUpdate,
          coinHistory: currentChar.coinHistory || []
        };
        if (isEdit) {
          if (roundCoins(coinState.ancientCoins) !== finalCoins) {
            applyCoinBalance(coinState, finalCoins, { note: 'Ручное изменение в редакторе' });
          }
        } else {
          coinState.ancientCoins = finalCoins;
        }

        const newCharData = {
          ...currentChar,
          nick: nick,
          class: getSafeStr('class'),
          partyIds: partyIdsNext,
          mainPartyId: mainPartyNext,
          level: parseInt(formData.get('level'), 10) || 1,
          sky: { 
            name: getSafeStr('sky-name') || null, 
            level: formData.get('sky-level') ? parseInt(formData.get('sky-level'), 10) : null 
          },
          contacts: {
            email: getSafeStr('contact-email'),
            password: getSafeStr('contact-password'),
            recoveryEmail: getSafeStr('contact-recovery'),
            phone: getSafeStr('contact-phone')
          },
          dungeonPasses: {
            weapon: parseInt(formData.get('pass-weapon'), 10) || 0,
            armor: parseInt(formData.get('pass-armor'), 10) || 0,
            relic: parseInt(formData.get('pass-relic'), 10) || 0
          },
          stats: newStats,
          tags: normalizeTags(formData.get('tags')),
          
          // ОБНОВЛЯЕМ БАЛАНС И ДАТУ
          ancientCoins: coinState.ancientCoins,
          lastCoinUpdate: coinState.lastCoinUpdate,
          // история: запись добавляется только при изменении баланса
          coinHistory: coinState.coinHistory,
            
          updatedAt: nowISO()
        };

        let idNote = '';
        if (isEdit) {
          const idx = state.characters.findIndex(c => c.id === currentChar.id);
          if (idx !== -1) {
             state.characters[idx] = newCharData;
          } else {
             throw new Error("Персонаж не найден для обновления");
          }
          // Ник изменился → id тоже (читаемый id = ник)
          if (nick !== currentChar.nick) {
            const res = await syncIdWithNick(newCharData);
            if (res.changed) idNote = ` (id: ${res.id})`;
            else if (res.error) idNote = '. id не изменён: закройте окно браузера персонажа и сохраните ещё раз';
          }
        } else {
          newCharData.id = newCharacterId(nick);
          state.characters.push(newCharData);
        }

        persist().then(() => {
          renderCharacters();
          renderParties();
          toast((isEdit ? 'Персонаж обновлен' : `Персонаж создан (id: ${newCharData.id})`) + idNote, 'success');
        });
        return true;
      } catch (err) {
        console.error('[FORM SAVE ERROR]', err);
        setError(`Ошибка сохранения: ${err.message}`);
        return false;
      }
    }
  });

  // Распознавание — действие формы целиком, поэтому кнопка находится в футере, а не среди полей.
  const footer = document.querySelector('#modal-root .modal-footer');
  footer?.insertAdjacentHTML('afterbegin',
    '<button type="button" class="btn secondary" id="btn-stats-ocr" title="Выбрать скриншот окна с характеристиками: значения подставятся в поля">📷 Заполнить со скриншота</button>');
  bindStatsOcr();
}
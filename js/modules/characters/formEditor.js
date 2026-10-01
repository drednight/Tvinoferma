// js/modules/characters/formEditor.js

import { state, normalizeTags } from '../../core/state.js';
import { persist } from '../../core/storage.js';
import { escapeHtml, nowISO } from '../../core/utils.js';
import { showModal, toast } from '../../core/ui.js';
import { renderCharacters, allTags } from './list.js';
import { renderParties } from '../parties/index.js';
import { CLASSES, SKIES, SKY_LEVELS } from '../../core/constants.js';
import { createEmptyCharacter, DEFAULT_STATS } from './stateManager.js';
import { newCharacterId, syncIdWithNick } from './identity.js';
import { vaultStatus } from '../../core/secrets.js';

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

  const partyOptions = state.parties.map(p => `<option value="${escapeHtml(p.name)}" ${currentChar.party === p.name ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  const nonePartyOption = `<option value="" ${!currentChar.party ? 'selected' : ''}>— Без пати —</option>`;

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
        <div class="field"><label>Пати</label><select class="select" name="party">${nonePartyOption}${partyOptions}</select></div>
      </div>

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

      <!-- Основные характеристики -->
      <div class="info-block" style="margin-top:16px;"><h4>Основные характеристики</h4>
        <div class="four-cols">
          ${statInput('endurance', 'Выносливость')}
          ${statInput('intelligence', 'Интеллект')}
          ${statInput('strength', 'Сила')}
          ${statInput('agility', 'Ловкость')}
        </div>
      </div>

      <!-- Бой и Защита -->
      <div class="info-block" style="margin-top:16px;"><h4>Бой и Защита</h4>
        <div class="four-cols">
          ${statInput('hp', 'Здоровье (текущее)')}
          ${statInput('hpMax', 'Здоровье (макс)')}
          ${statInput('mp', 'Маг. энергия (текущее)')}
          ${statInput('mpMax', 'Маг. энергия (макс)')}
        </div>
        <div class="four-cols" style="margin-top:8px;">
          ${statInput('physAttack', 'Физ. атака')}
          ${statInput('physDefense', 'Физ. защита')}
          ${statInput('magAttack', 'Маг. атака')}
          ${statInput('magDefense', 'Маг. защита')}
        </div>
      </div>

      <!-- Показатели боя -->
      <div class="info-block" style="margin-top:16px;"><h4>Показатели боя</h4>
        <div class="three-cols">
          ${statInput('critChance', 'Шанс крит. удара (%)')}
          ${statInput('critDamage', 'Крит. урон (%)')}
          ${statInput('atkSpeed', 'Скорость атаки')}
        </div>
        <div class="three-cols" style="margin-top:8px;">
          ${statInput('evasion', 'Уклонение')}
          ${statInput('accuracy', 'Меткость')}
          ${statInput('pa', 'Показатель атаки (ПА)')}
        </div>
        <div class="three-cols" style="margin-top:8px;">
          ${statInput('pz', 'Показатель защиты (ПЗ)')}
          ${statInput('morale', 'Боевой дух')}
          ${statInput('power', 'Сила')}
        </div>
        <div class="two-cols" style="margin-top:8px;">
          ${statInput('stealth', 'Скрытность')}
          ${statInput('detection', 'Обнаружение')}
        </div>
      </div>

      <!-- PvE и Пробивание -->
      <div class="info-block" style="margin-top:16px;"><h4>PvE и Пробивание</h4>
        <div class="two-cols">
          ${statInput('pvePa', 'Урон по монстрам (PvE PA)')}
          ${statInput('pvePz', 'Защита от монстров (PvE PZ)')}
        </div>
        <div class="two-cols" style="margin-top:8px;">
          ${statInput('physPenetration', 'Физ. пробивание')}
          ${statInput('magPenetration', 'Маг. пробивание')}
        </div>
      </div>

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
          <input class="input" type="number" name="coins" value="${currentCoins}" min="0" style="font-size:1.2rem; font-weight:bold; color:gold;" />
          <small class="help-text" style="display:block; margin-top:4px; color:#888;">
             ${lastUpdateHint}
          </small>
        </div>
      </div>
    </div>
  `;

  showModal({
    title: isEdit ? `Редактировать: ${currentChar.nick}` : 'Новый персонаж',
    content,
    submitText: isEdit ? 'Сохранить изменения' : 'Создать персонажа',
    async onSubmit(formData, { setError }) {
      try {
        const getSafeStr = (name) => String(formData.get(name) || '').trim();
        
        const nick = getSafeStr('nick');
        if (!nick) { 
          setError('Никнейм обязателен.'); 
          return false; 
        }

        const newStats = {};
        Object.keys(DEFAULT_STATS).forEach(key => {
          const val = formData.get(`stat-${key}`);
          newStats[key] = val !== null && val !== undefined ? (parseInt(val, 10) || 0) : 0;
        });

        // Парсим новый баланс монет
        const rawCoins = formData.get('coins');
        const newCoinsVal = parseInt(rawCoins, 10);
        const finalCoins = isNaN(newCoinsVal) ? 0 : Math.max(0, newCoinsVal);

        // Логика обработки изменения монет
        let updatedLastCoinDate = currentChar.lastCoinUpdate;
        let newHistoryEntry = null;
        const oldCoins = currentChar.ancientCoins || 0;

        // Если это редактирование И баланс изменился
        if (isEdit && oldCoins !== finalCoins) {
           updatedLastCoinDate = nowISO();
           
           // Создаем запись в истории
           newHistoryEntry = {
             id: crypto.randomUUID(),
             date: updatedLastCoinDate,
             delta: finalCoins - oldCoins,
             note: 'Ручное изменение в редакторе',
             balanceAfter: finalCoins
           };
        }

        const newCharData = {
          ...currentChar,
          nick: nick,
          class: getSafeStr('class'),
          party: formData.get('party') || null,
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
          ancientCoins: finalCoins,
          lastCoinUpdate: updatedLastCoinDate,
          
          // ДОБАВЛЯЕМ ЗАПИСЬ В ИСТОРИЮ, ЕСЛИ БЫЛО ИЗМЕНЕНИЕ
          coinHistory: newHistoryEntry 
            ? [newHistoryEntry, ...(currentChar.coinHistory || [])] 
            : (currentChar.coinHistory || []),
            
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
}
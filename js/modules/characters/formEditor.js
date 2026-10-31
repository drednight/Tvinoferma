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
import { rememberStatsBefore, statChange } from './statsHistory.js';
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

  const classOptions = CLASSES.map(
    c => `<option value="${escapeHtml(c)}" ${currentChar.class === c ? 'selected' : ''}>${escapeHtml(c)}</option>`
  ).join('');
  const noneClassOption = `<option value="" ${!currentChar.class ? 'selected' : ''}>— Выберите класс —</option>`;

  // Основная пати (одна) + дополнительные (чипы). Монеты и выбор в марафон идут по основной.
  const mainId = currentChar.mainPartyId || null;
  const extraIdsSet = new Set((currentChar.partyIds || []).filter(id => id !== mainId));
  const mainOptions =
    `<option value="">— Без пати —</option>` +
    state.parties
      .map(
        p => `<option value="${escapeHtml(p.id)}" ${mainId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
      )
      .join('');
  const partyChips = state.parties.length
    ? state.parties
        .map(
          p =>
            `<label class="party-chip"><input type="checkbox" name="extraPartyIds" value="${escapeHtml(p.id)}" ${extraIdsSet.has(p.id) ? 'checked' : ''} ${mainId === p.id ? 'disabled' : ''} /><span>${escapeHtml(p.name)}</span></label>`
        )
        .join('')
    : '<span class="muted">Пока нет пати. Создайте их во вкладке «Пати».</span>';

  const skyNameOptions = SKIES.map(
    s => `<option value="${escapeHtml(s)}" ${sky.name === s ? 'selected' : ''}>${escapeHtml(s)}</option>`
  ).join('');
  const noneSkyOption = `<option value="" ${!sky.name ? 'selected' : ''}>— Не выбрано —</option>`;

  const skyLevelOptions = SKY_LEVELS.map(
    l => `<option value="${l}" ${sky.level == l ? 'selected' : ''}>${l}</option>`
  ).join('');
  const noneSkyLevelOption = `<option value="" ${!sky.level ? 'selected' : ''}>—</option>`;

  const statInput = (key, label) => {
    // Под полем — прошлое значение и разница с ним. Показываем, только если история есть:
    // пустая строка «было —» только занимала бы место и путала.
    const change = statChange(currentChar, key);
    const prev = change
      ? `<small class="cf-prev" data-prev="${key}" data-prev-value="${change.previous}">
           было ${change.previous.toLocaleString('ru-RU')}<span class="cf-prev-delta"></span>
         </small>`
      : '';
    return `
    <div class="field cf-stat">
      <label>${label}</label>
      <input class="input" type="number" name="stat-${key}" value="${stats[key]}" min="0" />
      ${prev}
    </div>
  `;
  };

  // Группа характеристик: подзаголовок и сетка плиток. Раньше каждая группа была
  // отдельной рамкой внутри свёрнутого блока — четыре коробки в коробке, и глаз цеплялся
  // за вложенность, а не за значения.
  const statGroup = (title, keys, extraClass = '') => `
    <section class="cf-stat-group">
      <h4 class="cf-stat-group-title">${title}</h4>
      <div class="cf-stat-grid ${extraClass}">
        ${keys.map(([key, label]) => statInput(key, label)).join('')}
      </div>
    </section>`;

  // Получаем текущий баланс и дату обновления для отображения подсказки
  const currentCoins = currentChar.ancientCoins || 0;
  const lastUpdateHint = currentChar.lastCoinUpdate
    ? `(Последняя синхр.: ${new Date(currentChar.lastCoinUpdate).toLocaleDateString()})`
    : '(Ещё не синхронизировалось)';

  // Разметка повторяет вид раскрытой карточки (profileView.js): две колонки, слева —
  // «кто это» и контакты, справа — характеристики, проходки и монеты. Имена полей и
  // details.stats-fold сохранены: на них завязаны сохранение и разбор скриншота.
  const content = `
    <div class="form-grid cf-grid">
      <div class="pf-cols">
        <div class="pf-col">
          <div class="pf-panel">
            <h4 class="pf-panel-title">Персонаж</h4>
            <div class="two-cols">
              <div class="field cf-field"><label>Никнейм *</label><input class="input" name="nick" value="${escapeHtml(currentChar.nick)}" required autofocus /></div>
              <div class="field cf-field">
                <label>Класс</label>
                <select class="select" name="class">
                  ${noneClassOption}
                  ${classOptions}
                </select>
              </div>
            </div>
            <div class="two-cols">
              <div class="field cf-field"><label>Уровень</label><input class="input" type="number" name="level" value="${currentChar.level}" min="1" /></div>
              <div class="field cf-field"><label>Основная пати</label><select class="select" name="mainParty" id="char-main-party">${mainOptions}</select></div>
            </div>
          </div>

          <div class="pf-panel">
            <h4 class="pf-panel-title">Пати</h4>
            <div class="field cf-field">
              <label class="cf-hint-label">Дополнительные <small class="muted">(монеты и марафоны считаются по основной)</small></label>
              <div class="party-chips" id="char-extra-parties">${partyChips}</div>
            </div>
          </div>

          <div class="pf-panel">
            <h4 class="pf-panel-title">Небо и теги</h4>
            <div class="two-cols">
              <div class="field cf-field">
                <label>Название неба</label>
                <select class="select" name="sky-name">
                  ${noneSkyOption}
                  ${skyNameOptions}
                </select>
              </div>
              <div class="field cf-field">
                <label>Уровень неба</label>
                <select class="select" name="sky-level">
                  ${noneSkyLevelOption}
                  ${skyLevelOptions}
                </select>
              </div>
            </div>
            <div class="field cf-field">
              <label class="cf-hint-label">Теги <small class="muted">(через запятую: «основа, твин, крафт»)</small></label>
              <input class="input" type="text" name="tags" list="char-tag-list" autocomplete="off" value="${escapeHtml((currentChar.tags || []).join(', '))}" />
              <datalist id="char-tag-list">${allTags()
                .map(t => `<option value="${escapeHtml(t)}"></option>`)
                .join('')}</datalist>
            </div>
          </div>

          <details class="pf-panel cf-fold" open>
            <summary class="pf-panel-title">Контактные данные <span class="muted cf-fold-note">для входа</span></summary>
            ${vaultStatus().ready ? '<p class="cf-vault-note">🔒 Хранятся в защищённом хранилище учётных данных ОС, а не в state.json</p>' : ''}
            <div class="two-cols">
              <div class="field cf-field"><label>Email / Логин</label><input class="input" type="text" name="contact-email" value="${escapeHtml(contacts.email)}" /></div>
              <div class="field cf-field"><label>Пароль</label><input class="input" type="text" name="contact-password" value="${escapeHtml(contacts.password)}" /></div>
              <div class="field cf-field"><label>Recovery Email</label><input class="input" type="email" name="contact-recovery" value="${escapeHtml(contacts.recoveryEmail)}" /></div>
              <div class="field cf-field"><label>Телефон</label><input class="input" type="tel" name="contact-phone" value="${escapeHtml(contacts.phone)}" /></div>
            </div>
          </details>

          <!-- Проходки — в левую колонку, под контакты: их всего три числа, а справа
               характеристик и так много, и третья колонка им только мешала -->
          <div class="pf-panel">
            <h4 class="pf-panel-title">Проходки в данжи</h4>
            <div class="three-cols">
              <div class="field cf-field"><label>Оружие</label><input class="input" type="number" name="pass-weapon" value="${passes.weapon}" min="0" /></div>
              <div class="field cf-field"><label>Броня</label><input class="input" type="number" name="pass-armor" value="${passes.armor}" min="0" /></div>
              <div class="field cf-field"><label>Реликвии</label><input class="input" type="number" name="pass-relic" value="${passes.relic}" min="0" /></div>
            </div>
          </div>
        </div>

        <div class="pf-col">
          <details class="pf-panel cf-fold stats-fold" open>
            <summary class="pf-panel-title">📊 Характеристики <span class="muted cf-fold-note">основные, бой, показатели, PvE</span></summary>
            <div class="cf-stat-groups">
              ${statGroup(
                'Основные характеристики',
                [
                  ['endurance', 'Выносливость'],
                  ['intelligence', 'Интеллект'],
                  ['strength', 'Сила'],
                  ['agility', 'Ловкость']
                ],
                'cf-stat-grid-2x2'
              )}
              ${statGroup('Бой и защита', [
                ['hp', 'Здоровье'],
                ['mp', 'Маг. энергия'],
                ['physAttack', 'Физ. атака'],
                ['physDefense', 'Физ. защита'],
                ['magAttack', 'Маг. атака'],
                ['magDefense', 'Маг. защита']
              ])}
              ${statGroup('Показатели боя', [
                ['critChance', 'Шанс крит. удара (%)'],
                ['critDamage', 'Крит. урон (%)'],
                ['atkSpeed', 'Скорость атаки'],
                ['evasion', 'Уклонение'],
                ['accuracy', 'Меткость'],
                ['pa', 'Показатель атаки (ПА)'],
                ['pz', 'Показатель защиты (ПЗ)'],
                ['morale', 'Боевой дух'],
                ['levelBonus', 'Бонус к уровню (%)'],
                ['physPenetration', 'Физ. пробивание'],
                ['magPenetration', 'Маг. пробивание']
              ])}
              ${statGroup('PvE', [
                ['pvePa', 'Урон по монстрам'],
                ['pvePz', 'Защита от монстров']
              ])}
            </div>
          </details>

          <div class="pf-panel cf-coins">
            <h4 class="pf-panel-title cf-coins-title"><svg class="ic" aria-hidden="true"><use href="#i-coin"/></svg> Древние монеты</h4>
            <div class="field cf-field">
              <label>Текущий баланс <small class="muted">(можно изменить вручную)</small></label>
              <input class="input cf-coins-input" type="number" name="coins" value="${currentCoins}" min="0" step="0.1" />
              <small class="help-text cf-coins-hint">${lastUpdateHint}</small>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Выбранная основная пати не может быть и дополнительной
  setTimeout(() => {
    const sel = document.getElementById('char-main-party');
    const box = document.getElementById('char-extra-parties');
    if (!sel || !box) return;
    const sync = () =>
      box.querySelectorAll('input').forEach(cb => {
        const isMain = cb.value === sel.value;
        cb.disabled = isMain;
        if (isMain) cb.checked = false;
      });
    sel.addEventListener('change', sync);
  }, 0);

  // Разница с прошлым значением — прямо в форме, при вводе.
  // Пока пользователь печатает, под полем видно, насколько новое значение отличается от
  // прошлого: «+120» зелёным вверх, «−30» красным вниз. Само прошлое значение не меняется —
  // оно подписано один раз при открытии формы.
  setTimeout(() => {
    document.querySelectorAll('#modal-root .cf-prev').forEach(hint => {
      const previous = Number(hint.dataset.prevValue) || 0;
      const input = hint.parentElement?.querySelector(`input[name="stat-${hint.dataset.prev}"]`);
      const out = hint.querySelector('.cf-prev-delta');
      if (!input || !out) return;
      const update = () => {
        const delta = (Number(input.value) || 0) - previous;
        out.textContent = delta === 0 ? '' : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString('ru-RU')}`;
        out.classList.toggle('is-up', delta > 0);
        out.classList.toggle('is-down', delta < 0);
      };
      input.addEventListener('input', update);
      update();
    });
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
      import('./statsImport.js')
        .then(({ openStatsImport }) =>
          openStatsImport({
            current: stats,
            onApply: values => {
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
                input.addEventListener(
                  'input',
                  () => {
                    input.classList.remove('is-filled', 'is-up', 'is-down');
                  },
                  { once: true }
                );
              }
              toast(
                applied ? `Характеристик перенесено: ${applied}` : 'Нечего переносить',
                applied ? 'success' : 'warning'
              );
            }
          })
        )
        .catch(err => {
          console.error('[STATS OCR]', err);
          // Причина чаще всего одна: разбор скриншотов есть только в приложении
          toast(
            isTauri() ? 'Не удалось открыть разбор скриншота' : 'Разбор скриншота работает только в приложении',
            'error'
          );
        });
    });
  };

  showModal({
    title: isEdit ? `Редактировать: ${currentChar.nick}` : 'Новый персонаж',
    content,
    // Две колонки, как у раскрытой карточки: обычная ширина окна режет поля характеристик
    wide: true,
    submitText: isEdit ? 'Сохранить изменения' : 'Создать персонажа',
    cancelText: 'Отмена',
    async onSubmit(formData, { setError }) {
      try {
        const getSafeStr = name => String(formData.get(name) || '').trim();

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

        // Редактор меняет только видимые поля. Старые/неизвестные показатели
        // сохраняем локально, а не стираем при обычном редактировании карточки.
        // Облачный exporter отдельно проверяет свой явный allowlist.
        const newStats = { ...(currentChar.stats || {}) };
        Object.keys(DEFAULT_STATS).forEach(key => {
          const val = formData.get(`stat-${key}`);
          newStats[key] = val !== null && val !== undefined ? parseInt(val, 10) || 0 : 0;
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

        // Помним значения, которые были до сохранения: в профиле рядом с текущим числом
        // показывается разница («было 96 467, стало 96 587») и когда это было.
        // Новому персонажу история не нужна — сравнивать не с чем
        if (isEdit) rememberStatsBefore(newCharData, currentChar.stats, newCharData.updatedAt);

        let idNote = '';
        if (isEdit) {
          const archived = state.archivedCharacters.some(c => c.id === currentChar.id);
          const targetCharacters = archived ? state.archivedCharacters : state.characters;
          const idx = targetCharacters.findIndex(c => c.id === currentChar.id);
          if (idx !== -1) {
            targetCharacters[idx] = newCharData;
          } else {
            throw new Error('Персонаж не найден для обновления');
          }
          // Ник изменился → id тоже (читаемый id = ник)
          if (nick !== currentChar.nick) {
            const res = await syncIdWithNick(newCharData);
            if (res.changed) idNote = ` (id: ${res.id})`;
            else if (res.error === 'references_conflict')
              idNote = '. id не изменён: обнаружен конфликт ссылок персонажа; проверьте марафоны';
            else if (res.error === 'profile_rename_unconfirmed')
              idNote =
                '. id не изменён: состояние поменялось во время переноса профиля; проверьте профиль перед повтором';
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
  footer?.insertAdjacentHTML(
    'afterbegin',
    '<button type="button" class="btn secondary" id="btn-stats-ocr" title="Выбрать скриншот окна с характеристиками: значения подставятся в поля">📷 Заполнить со скриншота</button>'
  );
  bindStatsOcr();
}

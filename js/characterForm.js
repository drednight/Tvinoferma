import { CLASSES, PASS_TYPES, SKIES, SKY_LEVELS } from './constants.js';
import { state } from './state.js';
import { persist } from './storage.js';
import { escapeHtml, isValidEmail, isValidNick, nowISO, toInt, uid } from './utils.js';
import { showModal, toast } from './ui.js';
import { renderCharacters } from './characters.js';

function options(list, selected, emptyLabel = '') {
  return [
    emptyLabel ? `<option value="">${escapeHtml(emptyLabel)}</option>` : '',
    ...list.map((item) => {
      const value = typeof item === 'object' ? item.value : item;
      const label = typeof item === 'object' ? item.label : item;
      return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    })
  ].join('');
}

export function openCharacterForm(character = null) {
  const isEdit = !!character;
  const c = character || {
    nick: '',
    class: CLASSES[0],
    party: null,
    level: 1,
    sky: { name: null, level: null },
    contacts: { email: '', password: '', recoveryEmail: '', phone: '' },
    dungeonPasses: { weapon: 0, armor: 0, relic: 0 }
  };

  const partyOptions = [
    '<option value="">Без пати</option>',
    ...state.parties.map((p) => `<option value="${escapeHtml(p.name)}" ${p.name === c.party ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
  ].join('');

  const content = `
    <div class="form-grid">
      <div class="two-cols">
        <div class="field">
          <label>Ник</label>
          <input class="input" name="nick" value="${escapeHtml(c.nick)}" required />
        </div>

        <div class="field">
          <label>Класс</label>
          <select class="select" name="class">${options(CLASSES, c.class)}</select>
        </div>
      </div>

      <div class="three-cols">
        <div class="field">
          <label>Пати</label>
          <select class="select" name="party">${partyOptions}</select>
        </div>

        <div class="field">
          <label>Уровень</label>
          <input class="input" name="level" type="number" min="1" max="105" value="${c.level}" required />
        </div>

        <div class="field">
          <label>Небо</label>
          <select class="select" name="skyName">${options(SKIES, c.sky?.name || '', 'Не выбрано')}</select>
        </div>
      </div>

      <div class="three-cols">
        <div class="field">
          <label>Уровень неба</label>
          <select class="select" name="skyLevel">${options(SKY_LEVELS, c.sky?.level || '', '—')}</select>
        </div>

        <div class="field">
          <label>E-mail</label>
          <input class="input" name="email" value="${escapeHtml(c.contacts.email)}" />
        </div>

        <div class="field">
          <label>Пароль</label>
          <input class="input" name="password" value="${escapeHtml(c.contacts.password)}" />
        </div>
      </div>

      <div class="two-cols">
        <div class="field">
          <label>Доп. почта</label>
          <input class="input" name="recoveryEmail" value="${escapeHtml(c.contacts.recoveryEmail)}" />
        </div>

        <div class="field">
          <label>Телефон</label>
          <input class="input" name="phone" value="${escapeHtml(c.contacts.phone)}" />
        </div>
      </div>

      <div class="info-block">
        <h4>Проходки в данжи</h4>
        <div class="three-cols">
          ${PASS_TYPES.map((pass) => `
            <div class="field">
              <label>${pass.icon} ${pass.label}</label>
              <input class="input" name="pass-${pass.key}" type="number" min="0" step="1" value="${c.dungeonPasses?.[pass.key] || 0}" />
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  showModal({
    title: isEdit ? 'Редактировать персонажа' : 'Новый персонаж',
    content,
    submitText: isEdit ? 'Сохранить' : 'Добавить',
    onSubmit(formData, { setError }) {
      const nick = String(formData.get('nick') || '').trim();
      const cls = String(formData.get('class') || '');
      const partyRaw = String(formData.get('party') || '');
      const level = toInt(formData.get('level'), 0);

      const skyName = String(formData.get('skyName') || '');
      const skyLevelRaw = String(formData.get('skyLevel') || '');
      const skyLevel = skyLevelRaw ? toInt(skyLevelRaw, 0) : null;

      const email = String(formData.get('email') || '').trim();
      const password = String(formData.get('password') || '');
      const recoveryEmail = String(formData.get('recoveryEmail') || '').trim();
      const phone = String(formData.get('phone') || '').trim();

      const weapon = Math.max(0, toInt(formData.get('pass-weapon'), 0));
      const armor = Math.max(0, toInt(formData.get('pass-armor'), 0));
      const relic = Math.max(0, toInt(formData.get('pass-relic'), 0));

      if (!isValidNick(nick)) {
        setError('Ник обязателен и не должен содержать переносы строк или управляющие символы.');
        return false;
      }

      if (!CLASSES.includes(cls)) {
        setError('Выберите корректный класс.');
        return false;
      }

      if (level < 1 || level > 105) {
        setError('Уровень должен быть от 1 до 105.');
        return false;
      }

      if (skyLevel && !skyName) {
        setError('Если указан уровень неба, выберите название неба.');
        return false;
      }

      if (skyName && !SKIES.includes(skyName)) {
        setError('Некорректное название неба.');
        return false;
      }

      if (skyLevel && (skyLevel < 1 || skyLevel > 10)) {
        setError('Уровень неба должен быть от 1 до 10.');
        return false;
      }

      if (!isValidEmail(email)) {
        setError('Некорректный e-mail.');
        return false;
      }

      let party = partyRaw || null;
      if (party && !state.parties.some((p) => p.name === party)) {
        party = null;
      }

      const payload = {
        nick,
        class: cls,
        party,
        level,
        sky: {
          name: skyName || null,
          level: skyLevel || null
        },
        contacts: {
          email,
          password,
          recoveryEmail,
          phone
        },
        dungeonPasses: {
          weapon,
          armor,
          relic
        },
        updatedAt: nowISO()
      };

      if (isEdit) {
        Object.assign(character, payload);
        toast('Персонаж обновлён', 'success');
      } else {
        state.characters.push({
          id: uid(),
          ...payload,
          ancientCoins: 0,
          coinHistory: [],
          createdAt: nowISO()
        });
        toast('Персонаж добавлен', 'success');
      }

      persist();
      renderCharacters();
    }
  });
}
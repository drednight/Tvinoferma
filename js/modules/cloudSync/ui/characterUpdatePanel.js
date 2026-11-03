import { sameJsonValue } from '../valueEquality.js';
import { characterFieldText } from './characterFieldText.js';
import { CHARACTER_UPDATE_FIELDS } from '../characterUpdates.js';

const controllers = new WeakMap();
export function setCharacterUpdateBusy(host, value) {
  if (host) controllers.get(host)?.(value);
}

// Safe DOM text only. A nickname suggestion is never an identity decision.
export function renderCharacterUpdatePanel(host, view, onApply) {
  controllers.delete(host);
  host.replaceChildren();
  host.hidden = !view;
  if (!view) return;
  const doc = host.ownerDocument;
  const node = (tag, text, parent = host) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    parent.append(el);
    return el;
  };
  node('h4', 'Обновить существующих персонажей — без удаления');
  node(
    'p',
    'Выберите местного персонажа для каждой нужной записи и отметьте поля. Сопоставление запоминается только на этом ПК и для этого облачного аккаунта. Ник — лишь подсказка. Местные ID, архивность, контакты, группы, пути и привязки запуска сохраняются. Новые персонажи, задачи и настройки здесь не импортируются.'
  );
  const searchLabel = node('label', 'Найти персонажа '),
    search = node('input', undefined, searchLabel);
  search.type = 'search';
  search.className = 'input';
  search.placeholder = 'Ник';
  const list = node('div');
  list.className = 'cloud-character-list';
  const entries = [];
  let busy = false,
    parentBusy = false;
  const feedback = node('p');
  feedback.setAttribute('role', 'status');
  const acknowledgement = node('label');
  acknowledgement.className = 'cloud-option-toggle';
  const ack = node('input', undefined, acknowledgement);
  ack.type = 'checkbox';
  ack.dataset.characterUpdateAck = '';
  acknowledgement.append(
    doc.createTextNode('Проверил соответствия и выбранные поля. Перед изменением будет создана резервная копия.')
  );
  const button = node('button', 'Обновить выбранные поля');
  button.type = 'button';
  button.className = 'btn';
  button.dataset.characterUpdateApply = '';
  button.disabled = true;
  function selections() {
    return entries
      .filter(e => e.select.value)
      .map(e => ({
        cloudId: e.remote.id,
        localId: e.select.value,
        fields: [...e.fields.querySelectorAll('input:checked')].map(c => c.value)
      }));
  }
  function update() {
    const chosen = selections(),
      targets = chosen.map(c => c.localId),
      duplicate = new Set(targets).size !== targets.length;
    const count = chosen.reduce((sum, c) => sum + c.fields.length, 0);
    feedback.textContent = duplicate
      ? 'Один местный персонаж выбран для нескольких облачных записей. Исправьте соответствия.'
      : `Сопоставлено: ${chosen.length}. Полей для обновления: ${count}. Удалений: 0.`;
    button.disabled = busy || parentBusy || duplicate || !chosen.length || !ack.checked;
  }
  controllers.set(host, value => {
    parentBusy = value;
    update();
  });
  const equal = view.records.filter(r => r.identical);
  if (equal.length)
    node(
      'p',
      `Совпадают автоматически: ${equal.length}. Публичные и предоставленные приватные поля проверены; ручная сверка и запись не требуются.`
    );
  for (const remote of view.records.filter(r => !r.identical)) {
    const row = node('details', undefined, list);
    row.className = 'cloud-character-row';
    const summary = node('summary', `${remote.nick}${remote.archived ? ' (в архиве облака)' : ''}`, row);
    const label = node('label', 'Местный персонаж ', row),
      select = node('select', undefined, label);
    select.className = 'input';
    select.dataset.cloudCharacter = remote.id;
    const option = (value, text) => {
      const o = node('option', text, select);
      o.value = value;
    };
    option('', 'Не обновлять');
    for (const local of view.locals)
      option(
        local.id,
        `${local.nick} · ${local.id}${local.archived ? ' (архив этого ПК)' : ''}${remote.suggestedLocalIds.includes(local.id) ? ' — совпадает ник, проверьте' : ''}`
      );
    select.value = remote.matchedLocalId;
    if (remote.matchReason === 'contacts')
      node(
        'p',
        'Сопоставлено по нику, классу и связанным контактам из файла; предоставленный пароль тоже проверен, если присутствует. Значения скрыты. Соответствие не разрешает перезапись контактов.',
        row
      );
    if (remote.otherPublicDifferences?.length)
      node(
        'p',
        `Другие отличия: ${remote.otherPublicDifferences.join(', ')}. Эти данные видны в общем сравнении файла; здесь они не перезаписываются.`,
        row
      );
    if (remote.privateFields?.length)
      node(
        'p',
        `Контакты / пароль: ${remote.privateEqual ? 'совпадают' : 'есть отличия; перенос выбирается отдельно'}. Привязка взята из characterId файла, а не порядка строк.`,
        row
      );
    const content = node('div', undefined, row);
    content.className = 'cloud-character-fields';
    const entry = { remote, select, fields: content };
    entries.push(entry);
    function renderFields() {
      content.replaceChildren();
      ack.checked = false;
      const local = view.locals.find(c => c.id === select.value);
      summary.textContent = `${remote.nick}${local ? ' → ' + local.nick : ' — не выбрано'}`;
      if (local) {
        let count = 0;
        for (const [key, title] of Object.entries(CHARACTER_UPDATE_FIELDS)) {
          const before = local.fields[key],
            after = remote.fields[key];
          if (sameJsonValue(before, after)) continue;
          count++;
          const field = node('label', undefined, content);
          field.className = 'cloud-character-field';
          const check = node('input', undefined, field);
          check.type = 'checkbox';
          check.value = key;
          node('strong', title, field);
          node('span', 'На этом ПК: ' + characterFieldText(key, before), field);
          node('span', 'В облаке: ' + characterFieldText(key, after), field);
        }
        if (!count)
          node(
            'p',
            'Доступные публичные поля совпадают. Можно запомнить соответствие без изменения персонажа.',
            content
          );
      }
      update();
    }
    select.addEventListener('change', renderFields);
    content.addEventListener('change', () => {
      ack.checked = false;
      update();
    });
    renderFields();
  }
  search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase('ru');
    for (const e of entries)
      e.select.closest('details').hidden = ![e.remote.nick, view.locals.find(c => c.id === e.select.value)?.nick]
        .join(' ')
        .toLocaleLowerCase('ru')
        .includes(query);
  });
  ack.addEventListener('change', update);
  button.onclick = async () => {
    update();
    if (button.disabled) return;
    const chosen = selections();
    busy = true;
    update();
    host.querySelectorAll('input,select').forEach(el => (el.disabled = true));
    try {
      await onApply(chosen);
    } finally {
      busy = false;
      host.querySelectorAll('input,select').forEach(el => (el.disabled = false));
      ack.checked = false;
      update();
    }
  };
  update();
}

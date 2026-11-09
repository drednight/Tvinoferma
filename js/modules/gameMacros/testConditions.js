import { escapeHtml as esc } from '../../core/utils.js';
export const CONDITION_OPTIONS = {
  purpose: { unknown: 'Не указано', game: 'Игровое действие', chat: 'Ввод в чат' },
  chat: { unknown: 'Не проверено', closed: 'Чат закрыт / поле не активно', open: 'Поле чата активно' },
  physical: {
    unknown: 'Не проверено',
    worked: 'Физическая клавиша работает',
    failed: 'Физическая клавиша не работает'
  },
  windowMode: { unknown: 'Не указан', windowed: 'Оконный', borderless: 'Безрамочный', fullscreen: 'Полноэкранный' }
};
export function normalizeConditions(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  return {
    ...Object.fromEntries(
      Object.entries(CONDITION_OPTIONS).map(([field, options]) => [
        field,
        Object.hasOwn(options, value[field]) ? value[field] : 'unknown'
      ])
    ),
    binding: String(value.binding || '').slice(0, 160)
  };
}
export function conditionsFields() {
  return `<fieldset data-test-conditions><legend>Условия у получателя — укажите вручную</legend><p>Программа не читает состояние чата и назначение клавиши. Не вводите текст чата, пароли или секреты.</p>${Object.entries(
    {
      purpose: 'Что проверяем',
      chat: 'Состояние чата',
      physical: 'Проверка физической клавишей',
      windowMode: 'Режим окна'
    }
  )
    .map(
      ([field, label]) =>
        `<label>${label}<select data-condition="${field}">${Object.entries(CONDITION_OPTIONS[field])
          .map(([value, text]) => `<option value="${value}">${text}</option>`)
          .join('')}</select></label>`
    )
    .join(
      ''
    )}<label>Назначение клавиши / ожидаемое действие<input data-condition="binding" maxlength="160" placeholder="Например: открыть инвентарь"></label></fieldset>`;
}
export function readConditions(root) {
  return normalizeConditions(
    Object.fromEntries([...root.querySelectorAll('[data-condition]')].map(node => [node.dataset.condition, node.value]))
  );
}
export function conditionsSummary(value) {
  const c = normalizeConditions(value);
  return (
    Object.entries(CONDITION_OPTIONS)
      .map(([field, options]) => options[c[field]])
      .join(' · ') + (c.binding ? ` · ${c.binding}` : '')
  );
}
export function conditionsHtml(value) {
  return esc(conditionsSummary(value));
}

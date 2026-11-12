import { readDuplicateContactBackup, CONTACT_FIELDS } from '../core/secrets.js';
import { openOverlay } from '../modules/marathons/overlay.js';

export function duplicateBackupToken(name) {
  return /^state\.backup-[0-9]+-dup-([0-9a-f]{24})-[0-9]+-[0-9]+\.json$/.exec(name)?.[1] || '';
}

/** Never inserts contact values as HTML; viewing is explicit and read-only. */
export async function openDuplicateContactBackup(name) {
  const token = duplicateBackupToken(name);
  if (!token) throw new Error('Неверная копия');
  const rows = await readDuplicateContactBackup(token);
  const ov = openOverlay({ title: 'Исходные контакты до слияния', onClose: () => ov.body.replaceChildren() });
  const note = document.createElement('p');
  note.textContent =
    'Это защищённые копии контактов до слияния. Значения скрыты. Восстановление файла состояния не восстанавливает их автоматически: при необходимости сравните и вручную перенесите нужные поля в карточки. Эти отдельные защищённые записи могут остаться после удаления копии файла или сброса приложения. Закройте другие копии приложения.';
  const label = document.createElement('label');
  const show = document.createElement('input');
  show.type = 'checkbox';
  label.append(show, ' Показать контакты, включая пароли, только на этом экране');
  const table = document.createElement('div');
  const names = { email: 'Почта', password: 'Пароль', recoveryEmail: 'Резервная почта', phone: 'Телефон' };
  const render = () => {
    table.replaceChildren();
    for (const row of rows) {
      const section = document.createElement('section');
      const title = document.createElement('h4');
      title.textContent = `Персонаж: ${row.id}`;
      section.append(title);
      if (!row.contacts) {
        const empty = document.createElement('p');
        empty.textContent = 'Защищённой записи не было.';
        section.append(empty);
      } else {
        for (const field of CONTACT_FIELDS) {
          const line = document.createElement('p');
          const value = row.contacts[field] || '';
          line.textContent = `${names[field]}: ${show.checked ? value || 'пусто' : value ? 'заполнено' : 'пусто'}`;
          section.append(line);
        }
      }
      table.append(section);
    }
  };
  show.onchange = render;
  render();
  ov.body.append(note, label, table);
  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = 'Закрыть';
  close.onclick = () => ov.close();
  ov.foot.append(close);
  return ov;
}

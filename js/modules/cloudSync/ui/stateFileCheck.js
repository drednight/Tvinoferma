// @ts-check
// Обработчик автономной страницы: читает выбранный файл в браузере, без upload.
import { inspectStateFile } from '../inspectStateFile.js';
import { MAX_SNAPSHOT_BYTES } from '../envelope.js';

export function bindStateFileCheck(doc = document) {
  const input = /** @type {HTMLInputElement} */ (doc.getElementById('state-file'));
  const output = /** @type {HTMLTextAreaElement} */ (doc.getElementById('report'));
  const status = doc.getElementById('check-status');
  let generation = 0;
  input.addEventListener('change', async () => {
    const mine = ++generation;
    output.value = '';
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_SNAPSHOT_BYTES) {
      output.value = 'file/size';
      status.textContent = 'Файл больше допустимых 32 МиБ. Ничего не проверено.';
      input.value = '';
      return;
    }
    status.textContent = 'Проверка в памяти браузера…';
    try {
      const text = await file.text();
      if (mine !== generation) return;
      const result = inspectStateFile(text);
      output.value = result.codes.join('\n');
      status.textContent =
        result.codes[0] === 'file/structure_ok'
          ? 'Структура сохранённого файла прошла проверку. Это не проверка Google, vault или несохранённых правок.'
          : 'Проверка остановлена. Передайте только коды ниже — не сам файл.';
    } catch {
      if (mine === generation) {
        output.value = 'file/read';
        status.textContent = 'Файл не удалось проверить. Содержимое и ошибки файловой системы не выводятся.';
      }
    } finally {
      if (mine === generation) input.value = '';
    }
  });
  doc.getElementById('select-report').addEventListener('click', () => {
    output.focus();
    output.select();
  });
  doc.getElementById('clear-file').addEventListener('click', () => {
    generation++;
    input.value = '';
    output.value = '';
    status.textContent = 'Выбор очищен. Файл на компьютере не изменялся.';
  });
}

import { openBundlePreview } from './evidenceBundle.js';
import { trialTrace } from './trialRecords.js';
import { openExecutionDiagnostics } from './commandTools.js';
import { showModal } from '../../core/ui.js';
import { escapeHtml as esc } from '../../core/utils.js';
import { partyMembers } from './model.js';
import { BACKGROUND_METHODS, EXPERIMENT_METHODS } from './background.js';
import { LAB_VERDICTS } from './labResults.js';
import { buildTrial, summarizeExecution } from './trialEvidence.js';
export function outcomeHtml(summary) {
  const labels = {
    'activate-app': 'Уведомление активности приложения',
    'activate-window': 'Уведомление активности окна',
    'key-down': 'Нажатие клавиши',
    'key-up': 'Отпускание клавиши',
    'modifier-down': 'Нажатие модификатора',
    'modifier-up': 'Отпускание модификатора',
    'restore-window': 'Обратное уведомление окна',
    'restore-app': 'Обратное уведомление приложения',
    'command-failure': 'Остановка исполнителя',
    'command-rejected': 'Отказ перед выполнением',
    'execution-complete': 'Выполнение завершено',
    'background-preflight': 'Проверка состояния получателя'
  };
  const stage = labels[summary.stage] ? `${labels[summary.stage]} (${summary.stage})` : summary.stage;
  return `<section class="gm-outcome"><h4>Технический итог</h4><dl><dt>Где</dt><dd>${esc(stage)}</dd><dt>Что известно</dt><dd>${esc(summary.known)}</dd><dt>Что неизвестно</dt><dd>${esc(summary.unknown)}</dd><dt>Следующий шаг</dt><dd>${esc(summary.next)}</dd></dl></section>`;
}
export function openTrialWizard({ getConfig, state, diagnose, runTrial, save, stop }) {
  const c = getConfig(),
    members = partyMembers(state, c.partyId).filter(char => char.id !== c.leaders[c.partyId]);
  let pending = false,
    selection = null,
    evidence = null,
    record = null;
  const modal = showModal({
    title: 'Одиночная проверка фонового ввода',
    wide: true,
    submitText: null,
    cancelText: 'Закрыть',
    beforeClose: () => !pending,
    content: `<div class="gm-trial-wizard gm-dialog"><p>1. Выберите одного твина и безопасную клавишу. 2. Проверьте окно без ввода. 3. Отдельно разрешите одно нажатие. 4. Отметьте реакцию в игре. Автоматического перебора нет.</p><fieldset data-trial-fields><label>Получатель<select data-trial-char><option value="">Выберите твина</option>${members.map(char => `<option value="${esc(char.id)}">${esc(char.nick)}</option>`).join('')}</select></label><label>Клавиша / сочетание<input data-trial-key maxlength="60" placeholder="Например B"></label><label>Способ<select data-trial-method>${EXPERIMENT_METHODS.map(method => `<option value="${method}">${esc(BACKGROUND_METHODS[method])}</option>`).join('')}</select></label></fieldset><p>Не используйте расходные действия. Получатель должен оставаться неактивным; сама игра может изменить фокус. Проверка не гарантирует готовность игры. Повтор должен быть выключен.</p><button class="btn" data-trial-check>Проверить окно — без нажатия</button><pre data-trial-probe></pre><label><input type="checkbox" data-trial-consent disabled> Разрешаю одно нажатие выбранным способом одному твину</label><button class="btn primary" data-trial-run disabled>Отправить один раз</button><button class="btn danger" data-trial-stop hidden>Стоп</button><p role="status" data-trial-status></p><div data-trial-outcome></div><section data-trial-observation hidden><label>Реакция в игре<select data-trial-verdict>${Object.entries(
      LAB_VERDICTS
    )
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join(
        ''
      )}</select></label><label><input type="checkbox" data-trial-observed> Проверил непосредственно в игре</label><label>Заметка без секретов<textarea data-trial-notes maxlength="600" rows="3"></textarea></label><button class="btn" data-trial-save>Сохранить наблюдение</button></section></div>`
  });
  if (!modal) return;
  const q = selector => modal.querySelector(`[data-trial-${selector}]`),
    status = q('status');
  const read = () => ({
    partyId: getConfig().partyId,
    charId: q('char').value,
    key: q('key').value,
    method: q('method').value
  });
  const invalidate = () => {
    selection = null;
    evidence = null;
    q('consent').checked = false;
    q('consent').disabled = true;
    q('run').disabled = true;
    q('probe').textContent = '';
  };
  q('fields').onchange = invalidate;
  q('key').oninput = invalidate;
  q('consent').onchange = () => {
    q('run').disabled = !selection || !q('consent').checked;
  };
  q('stop').onclick = () => {
    stop();
    status.textContent = 'Запрошена остановка. Ожидаем завершения; отправленный ввод не отменяется.';
  };
  q('check').onclick = async () => {
    if (pending) return;
    invalidate();
    pending = true;
    q('fields').disabled = true;
    q('check').disabled = true;
    status.textContent = 'Проверка Windows без нажатий…';
    q('stop').hidden = false;
    try {
      const proposed = read();
      buildTrial(proposed, getConfig(), state);
      const report = await diagnose(proposed.charId, proposed.key);
      if (JSON.stringify(proposed) !== JSON.stringify(read()))
        throw new Error('Выбор пати изменился. Проверьте заново.');
      selection = proposed;
      evidence = report;
      q('probe').textContent = report;
      q('consent').disabled = false;
      status.textContent =
        'Проверка завершена. Прочитайте отчёт: она не является разрешением ввода. Для одного нажатия нужно отдельное согласие.';
    } catch (error) {
      status.textContent = error.message || 'Проверка не выполнена.';
    } finally {
      pending = false;
      q('fields').disabled = false;
      q('check').disabled = false;
      q('stop').hidden = true;
    }
  };
  q('run').onclick = async () => {
    if (pending || !selection || !q('consent').checked || !evidence) return;
    pending = true;
    q('fields').disabled = true;
    q('check').disabled = true;
    q('consent').disabled = true;
    q('run').disabled = true;
    q('stop').hidden = false;
    status.textContent = 'Один тест выполняется. Не переключайте окна и не запускайте другие команды.';
    try {
      if (JSON.stringify(read()) !== JSON.stringify(selection))
        throw new Error('Выбор изменился. Откройте новый тест.');
      const command = buildTrial(selection, getConfig(), state),
        run = await runTrial(selection),
        summary = summarizeExecution(run);
      record = {
        id: crypto.randomUUID(),
        partyId: selection.partyId,
        charId: selection.charId,
        key: command.sequence,
        method: selection.method,
        verdict: 'unverified',
        notes: '',
        at: new Date().toISOString(),
        technical: { ...summary, trace: trialTrace(run), runId: run?.runId || '', state: run?.state || 'unknown' }
      };
      q('outcome').innerHTML = outcomeHtml(summary);
      q('observation').hidden = false;
      try {
        await save({ backgroundTrials: [...getConfig().backgroundTrials, record].slice(-40) });
        status.textContent = 'Технический итог сохранён. Отметьте реакцию в игре.';
      } catch {
        status.textContent = 'Не удалось сохранить итог. Сохраните наблюдение ниже — повторный ввод не нужен.';
      }
    } catch (error) {
      status.textContent = error.message || 'Тест не выполнен. Повтор автоматически не запускается.';
    } finally {
      pending = false;
      q('stop').hidden = true;
      selection = null;
    }
  };
  q('save').onclick = async () => {
    if (pending || !record) return;
    const verdict = q('verdict').value;
    if (verdict !== 'unverified' && !q('observed').checked) {
      status.textContent = 'Подтвердите наблюдение в игре.';
      return;
    }
    pending = true;
    q('save').disabled = true;
    try {
      record = { ...record, verdict, notes: q('notes').value };
      await save({
        backgroundTrials: [...getConfig().backgroundTrials.filter(row => row.id !== record.id), record].slice(-40)
      });
      status.textContent = 'Наблюдение сохранено. Для другого способа откройте новый одиночный тест.';
    } catch {
      status.textContent = 'Не удалось сохранить. Заметка остаётся здесь; попробуйте сохранить ещё раз без ввода.';
    } finally {
      pending = false;
      q('save').disabled = false;
    }
  };
}
export function openTrialComparison(c, state) {
  const modal = showModal({
    title: 'Сравнение одиночных тестов',
    wide: true,
    submitText: null,
    cancelText: 'Закрыть',
    content: `<div class="gm-dialog"><p>Последние 40 тестов. Каждая строка — отдельное наблюдение, не доказательство поддержки PW. Сравнивайте одинаковые условия. История сохраняется на этом устройстве.</p><label><input type="checkbox" data-bundle-notes> Включить заметки</label><label><input type="checkbox" data-bundle-identifiers> Включить локальные ID и PID/HWND</label><button class="btn" data-bundle-preview>Предпросмотр выбранного пакета</button><p data-bundle-error role="status"></p><div class="gm-trial-table"><table><thead><tr><th>Выбор</th><th>Время / получатель</th><th>Клавиша / способ</th><th>Технический итог</th><th>Наблюдение в игре</th></tr></thead><tbody>${
      [...c.backgroundTrials]
        .reverse()
        .map(
          row =>
            `<tr><td><input type="checkbox" data-bundle-select="${esc(row.id)}" aria-label="Выбрать тест ${esc(row.key)} ${esc(row.at)}"></td><td>${esc(row.at)}<br>${esc(state.characters.find(char => char.id === row.charId)?.nick || row.charId)}</td><td>${esc(row.key)}<br>${esc(BACKGROUND_METHODS[row.method])}</td><td>${esc(row.technical.state)} · ${esc(row.technical.stage)}<br>${esc(row.technical.known)}<br><small>runId: ${esc(row.technical.runId || 'нет')}</small>${row.technical.trace ? `<button class="btn ghost" data-trial-details="${esc(row.id)}">Диагностика теста</button>` : ''}</td><td>${esc(LAB_VERDICTS[row.verdict])}<br>${esc(row.notes)}</td></tr>`
        )
        .join('') || '<tr><td colspan="5">Тестов пока нет. Откройте мастер одиночной проверки.</td></tr>'
    }</tbody></table></div></div>`
  });
  modal?.querySelector('[data-bundle-preview]').addEventListener('click', () => {
    try {
      openBundlePreview(
        c.backgroundTrials,
        [...modal.querySelectorAll('[data-bundle-select]:checked')].map(node => node.dataset.bundleSelect),
        {
          includeNotes: modal.querySelector('[data-bundle-notes]').checked,
          includeIdentifiers: modal.querySelector('[data-bundle-identifiers]').checked
        }
      );
    } catch (error) {
      modal.querySelector('[data-bundle-error]').textContent = error.message;
    }
  });
  modal?.querySelectorAll('[data-trial-details]').forEach(button => {
    button.onclick = () => {
      const row = c.backgroundTrials.find(row => row.id === button.dataset.trialDetails);
      if (row?.technical.trace) openExecutionDiagnostics([row.technical.trace]);
    };
  });
}

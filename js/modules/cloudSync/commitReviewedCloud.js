// @ts-check
// Подготовка подтверждённой записи выбранного кандидата из проверенной истории.
// Вызывается вручную экспериментальной панелью, но не автосинхронизацией. Не журналировать снимки или контакты.
// Guard ограничен одним JS-контекстом, не защищает от согласованного отката vault
// и не образует атомарной транзакции между vault и state.json.
import { assertStateWriteAvailable } from '../../core/storage.js';
import { array, object } from './exportSchema.js';
import { isVerifiedCloudReview } from './cloudReview.js';
import { currentCloudStateSnapshot, stageGuardedCloudStateWrite } from './guardedStateWrite.js';
import { appendPendingSelectiveApply } from './pendingSelectiveApply.js';
import { requireNoPendingConservativeMerge } from './pendingConservativeMerge.js';
import { beginCloudDataOperation } from './credentialResetCoordination.js';

function invalid() {
  return new Error('Не удалось подготовить применение облачных данных');
}

/**
 * Выбор записи означает выбор всех её публичных полей; личные данные остаются
 * на текущем ПК. Ничего не записывается до отдельного подтверждения commit.
 * Частичное применение не является слиянием или принятием всей облачной ветки.
 * @param {{review:any, pin:{versionId:string,sha256:string}, selectedRecords:{section:string,id:string}[],
 * selectedSettings?:string[],includeFinanceSettings?:boolean,selectedPlannerDeletions?:string[],cryptoSource?:Crypto}} options
 */
export function stageReviewedCloudApply(options) {
  const input = object(
    options,
    ['review', 'pin', 'selectedRecords'],
    ['selectedSettings', 'includeFinanceSettings', 'selectedPlannerDeletions', 'cryptoSource']
  );
  if (!isVerifiedCloudReview(input.review)) throw invalid();
  const selected = array(input.selectedRecords, item => object(item, ['section', 'id']));
  const settings = array(input.selectedSettings || [], value => value);
  const deletions = array(input.selectedPlannerDeletions || [], value => value);
  if (input.includeFinanceSettings !== undefined && typeof input.includeFinanceSettings !== 'boolean') throw invalid();
  if (!selected.length && !settings.length && !deletions.length && input.includeFinanceSettings !== true)
    throw invalid();
  assertStateWriteAvailable();
  const original = currentCloudStateSnapshot();
  requireNoPendingConservativeMerge(original.settings);
  const prepared = input.review.prepareApply(input.pin, {
    localState: original,
    selectedRecords: selected,
    selectedSettings: settings,
    includeFinanceSettings: input.includeFinanceSettings === true,
    selectedPlannerDeletions: deletions,
    ...(input.cryptoSource ? { cryptoSource: input.cryptoSource } : {})
  });
  const candidate = prepared.candidateState();
  const version = input.review.compare(input.pin);
  // Не публиковать такой локальный снимок как полное принятие облачной ветки.
  // Отметка сохраняется в той же записи, что и выбранные данные; полноценное
  // объединение происхождения и её снятие — отдельный протокол.
  candidate.settings = appendPendingSelectiveApply(candidate.settings, {
    provider: input.review.provider,
    datasetId: input.review.datasetId,
    pin: version.pin,
    records: [...selected, ...deletions.map(id => ({ section: 'planner', id }))],
    settings,
    financeSettings: input.includeFinanceSettings === true
  });
  const staged = stageGuardedCloudStateWrite({
    original,
    candidate,
    backupLabel: 'pre-cloud-apply',
    selectedCount: prepared.selectedCount
  });
  // В этом окне запись частично принятой версии не должна идти параллельно
  // с публикацией снимка. Это не блокировка других процессов или прямого IPC.
  return Object.freeze({
    selectedCount: staged.selectedCount,
    cancel: () => staged.cancel(),
    async commit(answer) {
      let operation;
      try {
        operation = beginCloudDataOperation();
      } catch {
        return Object.freeze({ status: 'busy' });
      }
      try {
        return await staged.commit(answer);
      } finally {
        operation.finish(false);
      }
    }
  });
}

/** Never broaden a stale explicit selection to new/replacement processes. */
export function selectCloseTargets(rows, request, config, state) {
  const snapshots = request.closeTargets;
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 128)
    throw new Error('Обновите список окон.');
  const selected = snapshots.map(target =>
    rows.find(row => row.pid === target.pid && row.startedAt === target.startedAt && row.hwnd === target.hwnd)
  );
  if (selected.some(row => !row || !row.startedAt || !row.hwnd))
    throw new Error('Список окон изменился. Обновите его и подтвердите закрытие заново.');
  const unique = [...new Map(selected.map(row => [row.pid, row])).values()];
  if (request.closeMode === 'selected') return unique;
  if (request.closeMode !== 'except-leader') throw new Error('Недопустимый режим закрытия.');
  const partyId = request.partyId || config.partyId;
  const leaderId = config.leaders?.[partyId];
  if (!state.parties.some(p => p.id === partyId) || !leaderId)
    throw new Error('Выберите пати с назначенным ПЛ. Закрытие отменено.');
  const leaders = rows.filter(row => row.known && row.charId === leaderId);
  if (leaders.length !== 1 || !unique.some(row => row.pid === leaders[0].pid))
    throw new Error('Окно ПЛ не определено однозначно в подтверждённом списке. Закрытие отменено.');
  return unique.filter(row => row.pid !== leaders[0].pid);
}

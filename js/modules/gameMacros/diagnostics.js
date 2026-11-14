// Only selected-game metadata and explicit test key messages. No titles, paths, chat, or global key capture.
const number = value => (Number.isFinite(value) ? value : '?');
const flag = value => (value === true ? 'да' : value === false ? 'нет' : 'неизвестно');
const hex = value => (Number.isInteger(value) ? `0x${value.toString(16).toUpperCase()}` : '?');
const token = value => (typeof value === 'string' && /^0x[\dA-F]+$/i.test(value) ? value : '?');
export function backgroundReport(report) {
  if (!report || report.schema !== 1) return ['Диагностический отчёт недоступен: обновите приложение.'];
  const lines = [
    `Проверенная цель: PID ${number(report.pid)}, HWND ${token(report.hwnd)}, GUI thread ${number(report.threadId)}. Личность проверена: ${flag(report.identityChecked)}.`,
    `Класс окна: ${typeof report.class === 'string' && /^[\w .-]{1,128}$/.test(report.class) ? report.class : 'не определён'}. CapsLock — ${flag(report.capsLock)}; CapsLock не добавляет Shift в оконные сообщения.`,
    `Администратор: Твиноферма — ${flag(report.appElevated)}, игра — ${flag(report.targetElevated)}.`,
    `Окно: видимо — ${flag(report.visible)}, свёрнуто — ${flag(report.minimized)}, Windows считает зависшим — ${flag(report.hung)}; активно — ${flag(report.targetForeground)}.`,
    `GUI: сведения доступны — ${flag(report.guiAvailable)} (код ${number(report.guiError)}), фокус в целевом HWND — ${flag(report.focusIsTarget)}, фокус в другом HWND этой нити — ${flag(report.childFocus)}, захват мыши целью — ${flag(report.captureIsTarget)}.`,
    `Клавиша VK=${hex(report.vk)}; scan отправителя=${hex(report.scanSender)}, scan раскладки игры=${hex(report.scanTarget)}. Раскладки: ${token(report.senderLayout)} → ${token(report.targetLayout)}.`,
    `Состояние перед отправкой: тестовая клавиша физически зажата — ${flag(report.selectedKeyHeld)}, Ctrl/Shift/Alt/Win зажат — ${flag(report.modifierHeld)}. Модификаторов в команде: ${Array.isArray(report.modifiers) ? report.modifiers.length : '?'}.`
  ];
  if (report.guiFocusHwnd || report.guiActiveHwnd)
    lines.push(
      `GUI HWND: active=${token(report.guiActiveHwnd)}, focus=${token(report.guiFocusHwnd)}, дочерний focus=${flag(report.guiFocusIsChild)}. Только диагностика — адресат ввода не подменяется.`
    );
  if (report.activityTest) {
    const baseKey =
      report.vk == null
        ? 'B'
        : report.vk >= 0x30 && report.vk <= 0x5a
          ? String.fromCharCode(report.vk)
          : report.vk >= 0x70 && report.vk <= 0x7b
            ? `F${report.vk - 0x6f}`
            : `VK=${hex(report.vk)}`;
    const modifiers = (Array.isArray(report.modifiers) ? report.modifiers : []).map(
      vk => ({ 16: 'SHIFT', 17: 'CTRL', 18: 'ALT' })[vk] || '?'
    );
    const key = [...modifiers, baseKey].join('+');
    lines.push(
      `Эксперимент: ${report.activityVariant === 'activity-window' ? 'только WM_ACTIVATE' : report.activityVariant === 'activity-notify' ? 'WM_ACTIVATEAPP + WM_ACTIVATE через SendNotifyMessage (асинхронно)' : 'WM_ACTIVATEAPP + WM_ACTIVATE'}, сочетание ${key} через SendMessageTimeout (25 мс); без SetFocus/SetForegroundWindow.`
    );
    if (report.notificationsSent === false)
      lines.push('Цель уже активна: клавиша отправляется без дополнительных уведомлений активности.');
    if (report.holdMs != null) lines.push(`Удержание клавиши: ${number(report.holdMs)} мс.`);
    if (report.refused)
      lines.push(
        'Тест отклонён до уведомлений: окно должно быть видимым, не свёрнутым, не зависшим, без удерживаемых клавиш/мыши. В диагностике B получатель должен быть в другом неактивном процессе.'
      );
    for (const step of (Array.isArray(report.steps) ? report.steps : []).slice(0, 12)) {
      const phase = [
        'activate-app',
        'activate-window',
        'modifier-down',
        'modifier-up',
        'key-down',
        'key-up',
        'restore-window',
        'restore-app'
      ].includes(step.phase)
        ? step.phase
        : '?';
      lines.push(
        `${phase}${phase.includes('modifier') ? ` VK=${hex(step.wparam)}` : ''}: ${step.skipped ? 'пропущено' : `${step.asynchronous ? 'API принял асинхронный запрос (не подтверждение обработки)' : 'Windows подтвердила'} — ${flag(step.ok)}, код ${number(step.error)}; foreground ${token(step.before)} → ${token(step.after)}`}.`
      );
    }
    lines.push(
      `Попытка ${key} — ${flag(report.inputSent)}. Изменение реального активного окна по замерам — ${flag(report.foregroundChanged)}.`
    );
    if (report.foregroundChanged)
      lines.push('Условие «без активации» нарушено. Дальнейшие нажатия отменены; фокус автоматически не возвращался.');
    lines.push(
      'Обратные уведомления — попытка восстановить состояние по Windows, не гарантия обработки игрой. Таймаут не доказывает недоставку. Реакцию PW проверьте вручную; краткие смены фокуса между замерами могут быть не замечены.'
    );
    return lines;
  }
  if (report.integrityAllowed === false)
    lines.push('Проверка прав не пройдена: отправка клавиш этому окну заблокирована.');
  if (report.foregroundChangedDuringProbe)
    lines.push(
      'Во время проверки изменилось активное окно. Сравните повторно без переключений; фокус не восстанавливался.'
    );
  if (report.minimized) lines.push('Для сравнения вручную разверните окно; диагностика не восстанавливает его.');
  if (report.scanSender !== report.scanTarget)
    lines.push('Раскладки дают разные scan-code. Автоматической подмены раскладки или клавиши нет.');
  const health = (Array.isArray(report.health) ? report.health : []).slice(0, 3);
  for (const probe of health)
    lines.push(
      `WM_NULL (без клавиши), лимит ${number(probe.timeoutMs)} мс: ответ — ${flag(probe.ok)}, код ${number(probe.error)}, ${number(probe.elapsedUs)} мкс.`
    );
  if (health.some(p => p.ok))
    lines.push('Оконная процедура ответила на WM_NULL. Это не доказывает, что она обрабатывает WM_KEY.');
  if (health[0]?.ok === false && health.slice(1).some(p => p.ok))
    lines.push(
      'Ответ получен только с увеличенным лимитом: 25 мс может быть недостаточно. Лимит клавиатурной команды не менялся.'
    );
  if (report.inputSent) {
    const method = ['post', 'send-timeout', 'notify', 'post-target-layout'].includes(report.method)
      ? report.method
      : '?';
    lines.push(
      `Выбранный способ ${method}, удержание ${number(report.holdMs)} мс. Изменение фокуса во время отправки — ${flag(report.foregroundChanged)}.`
    );
    for (const message of (Array.isArray(report.messages) ? report.messages : []).slice(0, 8)) {
      lines.push(
        `${message.phase === 'up' ? 'Отпускание' : 'Нажатие'}: VK=${hex(message.vk)}, scan=${hex(message.scan)}, msg=${token(message.message)}, lParam=${token(message.lparam)}; Windows приняла — ${flag(message.ok)}, код ${number(message.error)}, ${number(message.elapsedUs)} мкс.`
      );
    }
    lines.push(
      'Отчёт Windows не подтверждает действие в PW. Реакцию игры отметьте отдельно; отсутствие реакции не доказывает DirectInput/Raw Input.'
    );
  } else
    lines.push(
      'Клавиши не отправлялись. Проверка WM_NULL не переключает фокус и не меняет раскладку/состояние клавиатуры.'
    );
  return lines;
}

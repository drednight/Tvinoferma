/** Compact visible state, with full device/action details for tooltips and assistive technology. */
export function updateRepeatButton(button, device, data) {
  const enabled = !!data[device === 'keyboard' ? 'mirrorKeys' : 'mirrorMouse'];
  const pending = !!data.mirrorPending;
  const paused = enabled && !data.mirroring && !pending;
  const name = device === 'keyboard' ? 'клавиатуры' : 'мыши';
  const icon = device === 'keyboard' ? '⌨' : '🖱';
  button.textContent = `${icon} ${enabled ? 'ВКЛ' : 'ВЫКЛ'}${pending ? ' …' : paused ? ' Ⅱ' : ''}`;
  button.dataset.state = pending ? 'pending' : paused ? 'paused' : enabled ? 'on' : 'off';
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-busy', String(pending));
  const detail = pending ? ' · обновление подключения' : paused ? ' · приостановлен, сейчас не работает' : '';
  button.title = `${enabled ? 'Выключить' : 'Включить'} повтор ${name}${detail}`;
  button.setAttribute('aria-label', button.title);
}

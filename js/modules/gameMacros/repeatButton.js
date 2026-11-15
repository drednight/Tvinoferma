/** Compact visible state, with full device/action details for tooltips and assistive technology. */
export function updateRepeatButton(button, device, data) {
  const enabled = !!data[device === 'keyboard' ? 'mirrorKeys' : 'mirrorMouse'];
  const pending = !!data.mirrorPending;
  const paused = enabled && !data.mirroring && !pending;
  const name = device === 'keyboard' ? 'клавиатуры' : 'мыши';
  const icon = device === 'keyboard' ? '⌨' : '🖱';
  button.textContent = `${icon} ${enabled ? 'ВКЛ' : 'ВЫКЛ'}${pending ? ' …' : paused ? ' Ⅱ' : ''}`;
  if (device === 'keyboard') {
    const legacy = document.createElement('span');
    legacy.textContent = '⌨';
    legacy.hidden = true;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 48 22');
    svg.setAttribute('width', '38');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.verticalAlign = 'middle';
    svg.innerHTML =
      '<rect x="1" y="1" width="46" height="20" rx="2" fill="none" stroke="currentColor"/>' +
      [4, 8, 12]
        .map(y =>
          [4, 9, 14, 19, 24, 29, 36, 41]
            .map(x => `<rect x="${x}" y="${y}" width="3" height="2" fill="currentColor"/>`)
            .join('')
        )
        .join('') +
      '<rect x="10" y="16" width="18" height="2" fill="currentColor"/><path d="M34 3v16" stroke="currentColor"/>';
    button.replaceChildren(
      legacy,
      svg,
      document.createTextNode(` ${enabled ? 'ВКЛ' : 'ВЫКЛ'}${pending ? ' …' : paused ? ' Ⅱ' : ''}`)
    );
  }
  button.dataset.state = pending ? 'pending' : paused ? 'paused' : enabled ? 'on' : 'off';
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-busy', String(pending));
  const detail = pending ? ' · обновление подключения' : paused ? ' · приостановлен, сейчас не работает' : '';
  button.title = `${enabled ? 'Выключить' : 'Включить'} повтор ${name}${detail}`;
  button.setAttribute('aria-label', button.title);
}

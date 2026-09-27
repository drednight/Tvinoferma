// js/characterCard.js

import { PASS_TYPES, getClassIconSrc } from './constants.js';
import { state } from './state.js';
import { escapeHtml, formatNumber, maskValue } from './utils.js';

/**
 * Генерирует HTML строку для одной линии контакта (Email, Password, etc.)
 */
function contactLine(character, label, field) {
  const value = character.contacts?.[field] || '';
  const revealedKey = `${character.id}:${field}`;
  const isRevealed = !!state.ui.revealedContacts[revealedKey];

  if (!value) {
    return `
      <div class="contact-line">
        <span class="contact-label">${escapeHtml(label)}</span>
        <span class="contact-value empty">—</span>
      </div>
    `;
  }

  const displayText = isRevealed ? escapeHtml(value) : escapeHtml(maskValue(value));
  
  // Кнопка глазика только если значение есть
  const eyeBtn = `
    <button
      type="button"
      class="icon-btn"
      data-action="toggle-reveal"
      data-id="${character.id}"
      data-field="${field}"
      title="${isRevealed ? 'Скрыть' : 'Показать'}"
    >${isRevealed ? '🙈' : '👁'}</button>
  `;

  return `
    <div class="contact-line">
      <span class="contact-label">${escapeHtml(label)}</span>
      <div class="contact-value-wrapper">
        <span
          class="contact-value"
          data-action="copy-contact"
          data-id="${character.id}"
          data-field="${field}"
          title="Нажмите, чтобы скопировать"
        >${displayText}</span>
        ${eyeBtn}
      </div>
    </div>
  `;
}

/**
 * Генерирует HTML строку для одного блока проходки (Weapon, Armor, Relic)
 */
function passItem(passType, count) {
  const iconHtml = passType.img 
    ? `
      <img 
        src="${passType.img}" 
        alt="${passType.label}" 
        class="pass-icon-img" 
        onerror="this.style.display='none'; this.nextElementSibling.style.display='inline'"
      />
      <span class="pass-icon-fallback" style="display:none">${passType.icon}</span>
    `
    : `<span class="pass-icon-fallback">${passType.icon}</span>`;

  return `
    <span class="pass-item" title="${passType.label}: ${count}">
      ${iconHtml}
      <strong>${count}</strong>
    </span>
  `;
}

/**
 * Главная функция генерации карточки персонажа
 */
export function characterCard(character) {
  const expanded = state.ui.expandedCharacterId === character.id;
  const partyName = character.party || 'Без пати';
  
  // Небо
  let skyText = '';
  if (character.sky?.name) {
    skyText = escapeHtml(character.sky.name);
    if (character.sky.level) {
      skyText += ` ${character.sky.level}`;
    }
  }

  // Иконка класса
  const iconSrc = getClassIconSrc(character.class);
  let classVisualHtml;
  
  if (iconSrc) {
    classVisualHtml = `
      <div class="class-icon-container" title="${escapeHtml(character.class)}">
        <img 
          src="${iconSrc}" 
          alt="${escapeHtml(character.class)}" 
          class="class-icon-img" 
          onerror="this.style.display='none'; this.nextElementSibling.style.display='grid'"
        />
        <div class="class-icon-fallback" style="display:none">
          ${escapeHtml(character.class[0] || '?')}
        </div>
      </div>
    `;
  } else {
    classVisualHtml = `
      <div class="class-icon-container" title="${escapeHtml(character.class)}">
        <div class="class-icon-fallback">
          ${escapeHtml(character.class[0] || '?')}
        </div>
      </div>
    `;
  }

  // Проходки (Компактный вид)
  const passesHtml = PASS_TYPES.map((pass) => {
    const count = Number(character.dungeonPasses?.[pass.key]) || 0;
    return passItem(pass, count);
  }).join('');

  // Раскрытая часть (Детали)
  let expandedHtml = '';
  if (expanded) {
    // Контакты в деталях (Доп. почта, Телефон)
    const detailContacts = `
      ${contactLine(character, 'Доп. почта', 'recoveryEmail')}
      ${contactLine(character, 'Телефон', 'phone')}
    `;

    // Управление монетами
    const coinControls = `
      <div class="coin-controls">
        <button class="btn" data-action="coin-add" data-id="${character.id}">+ Монеты</button>
        <button class="btn" data-action="coin-sub" data-id="${character.id}">- Монеты</button>
        <button class="btn ghost" data-action="coin-history" data-id="${character.id}">История</button>
      </div>
    `;

    // Управление проходками (в деталях можно менять количество)
    const passControls = PASS_TYPES.map((pass) => {
      const count = Number(character.dungeonPasses?.[pass.key]) || 0;
      return `
        <div class="contact-line">
          <span>${pass.icon} ${pass.label}: <strong>${count}</strong></span>
          <div class="row gap">
            <button class="icon-btn" data-action="pass-sub" data-id="${character.id}" data-pass="${pass.key}">−</button>
            <button class="icon-btn" data-action="pass-add" data-id="${character.id}" data-pass="${pass.key}">+</button>
          </div>
        </div>
      `;
    }).join('');

    expandedHtml = `
      <div class="card-expanded">
        <div class="expanded-grid">
          
          <!-- Блок Детальных Контактов -->
          <div class="info-block">
            <h4>Контакты</h4>
            ${detailContacts || '<p class="muted">Нет дополнительных контактов</p>'}
          </div>

          <!-- Блок Древних Монет -->
          <div class="info-block">
            <h4>Древние монеты</h4>
            <p><strong style="font-size: 1.2rem;">${formatNumber(character.ancientCoins)}</strong></p>
            ${coinControls}
          </div>

          <!-- Блок Проходок (Редактирование) -->
          <div class="info-block">
            <h4>Проходки в данжи</h4>
            <div style="display: grid; gap: 8px;">
              ${passControls}
            </div>
          </div>

        </div>

        <!-- Действия -->
        <div class="actions-row">
          <button class="btn" data-action="edit" data-id="${character.id}">✏️ Редактировать</button>
          <button class="btn danger" data-action="delete" data-id="${character.id}">🗑 Удалить</button>
        </div>
      </div>
    `;
  }

  // Финальный HTML карточки
  // Обратите внимание на класс .expanded, он нужен для CSS сброса высоты
  return `
    <article class="character-card ${expanded ? 'expanded' : ''}" data-character-card="${character.id}">
      
      <!-- Компактная часть -->
      <div class="card-compact" data-action="toggle-expand" data-id="${character.id}">
        
        <!-- Шапка: Иконка класса + Пати/Монеты -->
        <div class="card-head">
          ${classVisualHtml}
          
          <div class="badge-group">
            <div class="badge party">${escapeHtml(partyName)}</div>
            <div class="badge coins">🪙 ${formatNumber(character.ancientCoins)}</div>
          </div>
        </div>

        <!-- Тело: Ник, Уровень, Небо -->
        <!-- flex-grow: 1 в CSS заставит этот блок растянуться, толкая контакты вниз -->
        <div class="card-title">
          <h3>${escapeHtml(character.nick)}</h3>
          <div class="muted-text">LVL ${character.level}</div>
          ${skyText ? `<div class="muted-text">${skyText}</div>` : ''}
        </div>

        <!-- Контакты (Email, Пароль) - Всегда видимы в компактном виде -->
        <div class="contact-lines">
          ${contactLine(character, 'E-mail', 'email')}
          ${contactLine(character, 'Пароль', 'password')}
        </div>

        <!-- Проходки (Низ карточки) -->
        <div class="passes-container">
          ${passesHtml}
        </div>

      </div>

      <!-- Раскрытая часть (если активна) -->
      ${expandedHtml}
      
    </article>
  `;
}
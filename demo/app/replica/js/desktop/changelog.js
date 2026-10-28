// js/desktop/changelog.js
// «История обновлений» для «Настройки → Обновления».
//
// CHANGELOG.md из корня проекта вшивается в сборку (?raw) и разбирается на выпуски:
// каждый выпуск — раскрывающаяся карточка с датой и изменениями по секциям.
// Формат файла — Keep a Changelog: «## [версия] — дата», секции «### Заголовок»,
// пункты «- текст». Вступление до первого «##» в историю не попадает.

import { escapeHtml } from '../core/utils.js';
import changelogMd from './changelog-data.js';

/**
 * @typedef {Object} Release
 * @property {string} version 'Unreleased' или номер версии
 * @property {string} date дата выпуска из заголовка, может быть пустой
 * @property {string} lead вступительный абзац выпуска
 * @property {{ title: string, items: string[] }[]} sections секции в порядке появления; одинаковые заголовки склеены
 */

/**
 * Разбирает текст CHANGELOG.md на выпуски — свежие сверху (порядок файла).
 * Секции с повторяющимся заголовком внутри выпуска склеиваются: длинные выпуски
 * собирались из нескольких партий, и «### Улучшения» там встречается дважды.
 * @param {string} [md]
 * @returns {Release[]}
 */
export function parseChangelog(md = changelogMd) {
  /** @type {Release[]} */
  const releases = [];
  /** @type {Release | null} */
  let release = null;
  /** @type {{ title: string, items: string[] } | null} */
  let section = null;
  let leadLines = [];

  const flushLead = () => {
    if (release && !release.lead && leadLines.length) release.lead = leadLines.join(' ');
    leadLines = [];
  };

  for (const raw of String(md).split('\n')) {
    const line = raw.trim();
    const h2 = line.match(/^## \[([^\]]+)\](?:\s*[—–-]\s*(.+))?$/);
    if (h2) {
      flushLead();
      release = { version: h2[1].trim(), date: (h2[2] || '').trim(), lead: '', sections: [] };
      releases.push(release);
      section = null;
      continue;
    }
    if (!release || !line) continue;
    const h3 = line.match(/^### (.+)$/);
    if (h3) {
      flushLead();
      const title = h3[1].trim();
      section = release.sections.find(s => s.title === title) || null;
      if (!section) {
        section = { title, items: [] };
        release.sections.push(section);
      }
      continue;
    }
    const bullet = line.match(/^[-*] (.+)$/);
    if (bullet) {
      flushLead();
      if (!section) {
        // Пункты до первой «###» — безымянная секция: показывается списком без заголовка
        section = { title: '', items: [] };
        release.sections.push(section);
      }
      section.items.push(bullet[1].trim());
      continue;
    }
    // Обычный текст до первой секции — вступление выпуска
    if (!section) leadLines.push(line);
  }
  flushLead();
  return releases;
}

/** «N записей» с правильным склонением. */
function pluralItems(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'запись'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'записи'
        : 'записей';
  return `${n} ${word}`;
}

/**
 * HTML аккордеона истории: карточка на выпуск, все свёрнуты —
 * в списке видно последние пять выпусков, остальные достижимы прокруткой.
 * @param {Release[]} releases
 * @returns {string}
 */
export function renderHistoryHtml(releases) {
  if (!releases.length) return '<p class="muted">История обновлений пуста.</p>';
  return releases
    .map(r => {
      const count = r.sections.reduce((acc, s) => acc + s.items.length, 0);
      const name = r.version.toLowerCase() === 'unreleased' ? '🚧 В разработке' : `Версия ${escapeHtml(r.version)}`;
      const sections = r.sections
        .map(
          s =>
            `${s.title ? `<h4 class="uh-h">${escapeHtml(s.title)}</h4>` : ''}<ul class="uh-ul">${s.items
              .map(item => `<li>${escapeHtml(item)}</li>`)
              .join('')}</ul>`
        )
        .join('');
      return `<details class="update-history-item">
        <summary><strong class="uh-ver">${name}</strong>${
          r.date ? `<span class="uh-date">${escapeHtml(r.date)}</span>` : ''
        }<span class="uh-count">${pluralItems(count)}</span></summary>
        <div class="update-history-body">${r.lead ? `<p class="uh-lead">${escapeHtml(r.lead)}</p>` : ''}${sections}</div>
      </details>`;
    })
    .join('');
}

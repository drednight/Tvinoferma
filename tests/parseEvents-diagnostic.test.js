// tests/parseEvents-diagnostic.test.js
// Подробная диагностика парсера ответов на ивенты.
//
// Цель — читать лог и видеть, что именно парсер «открыл» на странице и какие
// сигналы он получил, чтобы понимать, где он спотыкается:
//   * для каждого события: id, заголовок, радио yes/no (checked?), класс
//     user__event-active, блок .user__event-confirmation (наличие + display);
//   * вывод НОВОГО парсера (по блоку подтверждения) и «старого» (по radio
//     :checked), чтобы показать, на каких событиях они расходятся — это и
//     есть место спотыкания;
//   * прогон как по фикстуре, так и по настоящему дампу страницы профиля
//     клана, если файл есть в /tmp/arena-coding-uploads.
//
// Тест ведёт себя как обычный тест: логи печатаются, основные инварианты
// подтверждаются через expect.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseEvents, RESPONSE_YES, RESPONSE_NO, RESPONSE_NONE } from '../js/modules/guild/core.js';

const FIXTURE = 'tests/fixtures/site-guild-profile.html';
const REAL_DUMP = '/tmp/arena-coding-uploads/Мой профиль - Eternals Clan.htm';

function hr(title) {
  console.log('\n' + '═'.repeat(78));
  console.log(title);
  console.log('═'.repeat(78));
}

function yn(v) {
  return v ? 'да' : 'нет';
}

// Считать радио «checked» в DOM, как делает старый парсер.
function radioState(el, value) {
  const input = el.querySelector(`input[type="radio"][value="${value}"]`);
  return !!(input && input.checked);
}

// Вывод «старого» парсера: читали просто input:checked.
function oldRadioResponse(el) {
  const checked = el.querySelector('input[type="radio"]:checked');
  return checked?.value === 'yes' || checked?.value === 'no' ? checked.value : '';
}

// Подробная выгрузка сигналов одного события.
function dumpSignals(el, index) {
  const form = el.querySelector('form.event-response-form');
  const id = form?.dataset?.eventId ?? '(нет формы)';
  const title = el.querySelector('.user__event-title')?.textContent?.trim() ?? '(нет названия)';
  const when = el.querySelector('.user__event-date')?.textContent?.trim() ?? '';
  const yes = radioState(el, 'yes');
  const no = radioState(el, 'no');
  const active = el.classList.contains('user__event-active');
  const conf = el.querySelector('.user__event-confirmation');
  const confDisplay = conf ? (conf.style.display || '(стиль не задан)') : '(блока нет)';
  const oldResp = oldRadioResponse(el);
  const allChecked = [...el.querySelectorAll('input[type="radio"]:checked')].map(i => i.value);
  const snippet = (node, n = 180) => {
    if (!node) return '(нет)';
    const html = node.outerHTML.replace(/\s+/g, ' ').trim();
    return html.length > n ? html.slice(0, n) + '…' : html;
  };

  console.log(`\n[${index}] ивент #${id}  «${title}»`);
  if (when) console.log(`    дата: ${when}`);
  console.log(`    радио yes.checked = ${yn(yes)} | радио no.checked = ${yn(no)} | все checked = [${allChecked.join(', ')}]`);
  console.log(`    класс user__event-active = ${yn(active)}`);
  console.log(`    блок .user__event-confirmation: ${conf ? 'есть' : 'НЕТ'} | display = ${confDisplay}`);
  console.log(`    что парсер «открыл» (радио): ${snippet(el.querySelector('.user__event-radio--wrap'))}`);
  console.log(`    что парсер «открыл» (подтверждение): ${snippet(conf)}`);
  console.log(`    старый парсер (radio:checked)  → response = ${JSON.stringify(oldResp)}`);
}

// Считать документ из HTML-строки и выгрузить все события.
function analyzeHtml(label, html) {
  hr(label);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const events = doc.querySelectorAll('.user__event');
  console.log(`Найдено блоков .user__event: ${events.length}`);
  if (!events.length) {
    console.log('   (событий не найдено — проверьте выборку или корректность HTML)');
    return [];
  }
  const parsed = parseEvents(doc);
  console.log('\n— Сингалы по каждому событию и вывод парсера —');
  [...events].forEach((el, i) => dumpSignals(el, i));

  console.log('\n— Сводка вывода НОВОГО парсера parseEvents —');
  for (const e of parsed) {
    const sig = [...events].find(el => el.querySelector('form.event-response-form')?.dataset?.eventId === e.id);
    const old = sig ? oldRadioResponse(sig) : '';
    const flag = old !== e.response ? '  ⚠ РАСХОЖДЕНИЕ со старым парсером' : '';
    console.log(`  #${e.id.padEnd(4)} ${JSON.stringify(e.response).padEnd(5)} «${e.title}»${flag}`);
  }
  return parsed;
}

describe('диагностика парсера ответов на ивенты', () => {
  it('показывает сигналы и вывод парсера по фикстуре', () => {
    const html = readFileSync(FIXTURE, 'utf8');
    const parsed = analyzeHtml('ФИКСТУРА: tests/fixtures/site-guild-profile.html', html);

    // Ключевой инвариант: неподтверждённое событие (464) с default-checked
    // «Пойду» НЕ должно читаться как «yes».
    const e464 = parsed.find(e => e.id === '464');
    expect(e464).toBeDefined();
    expect(e464.response).toBe(RESPONSE_NONE);
    // Само событие в фикстуре действительно имеет checked-yes и скрытый блок.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el464 = [...doc.querySelectorAll('.user__event')].find(
      el => el.querySelector('form.event-response-form')?.dataset?.eventId === '464'
    );
    expect(radioState(el464, 'yes')).toBe(true);
    expect(el464.querySelector('.user__event-confirmation').style.display).toBe('none');

    // Подтверждённое «Пойду» (462) и «Не пойду» (466) читаются верно.
    expect(parsed.find(e => e.id === '462').response).toBe(RESPONSE_YES);
    expect(parsed.find(e => e.id === '466').response).toBe(RESPONSE_NO);
  });

  it('прогоняет настоящую страницу профиля и показывает, что парсер видит', () => {
    if (!existsSync(REAL_DUMP)) {
      console.log(`\n[пропущено] файл дампа не найден: ${REAL_DUMP}`);
      return;
    }
    const html = readFileSync(REAL_DUMP, 'utf8', { encoding: 'utf8' });
    const parsed = analyzeHtml(`РЕАЛЬНЫЙ ДАМП: ${REAL_DUMP}`, html);

    // На реальном сайте должен быть хотя бы один неподтверждённый ивент, и он
    // не должен читаться как «yes» только потому, что «Пойду» checked по умолчанию.
    const unconfirmed = parsed.filter(e => e.response === RESPONSE_NONE);
    const wronglyYes = parsed.filter(e => e.response === RESPONSE_YES);
    console.log(`\n— ИТОГ — неподтверждённых (NONE): ${unconfirmed.length}, «Пойду» (yes): ${wronglyYes.length}`);
    // Парсер не должен кидать исключение и должен вернуть список с id.
    expect(parsed.length).toBeGreaterThan(0);
    for (const e of parsed) expect(e.id).toMatch(/^\d+$/);
  });
});

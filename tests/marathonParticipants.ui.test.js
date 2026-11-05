import { describe, it, expect, beforeEach, vi } from 'vitest';

// Мастер, шаг «Участники»: прокрутка при выборе заданий и кнопки «убрать задание у пати».
vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/modules/sync/authStatus.js', () => ({
  getAuthView: () => ({ icon: '', text: '', color: '#0f0' }),
  getAuthState: () => 'online'
}));
vi.mock('../js/modules/marathons/siteSync.js', () => ({
  SITE_PAGES: [],
  customPages: () => [],
  rememberCustomPage: vi.fn(),
  scanTitles: vi.fn(async () => ({ titles: [], errors: [] })),
  pickScannerCharacter: () => null,
  isNewsUrl: () => false,
  loadNewsPage: vi.fn(),
  searchNewsList: vi.fn(),
  parseMarathonPage: vi.fn()
}));

const $ = sel => document.querySelector(sel);
const partyButton = (party, task) => document.querySelector(`[data-party-task="${party}"][data-task="${task}"]`);
const cell = (cid, tid) => document.querySelector(`[data-cell="${cid}|${tid}"]`);

let state, wizard, model, marathon;
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="modal-root"></div>';
  ({ state } = await import('../js/core/state.js'));
  model = await import('../js/modules/marathons/model.js');
  wizard = await import('../js/modules/marathons/wizard.js');

  state.parties = [
    { id: 'p1', name: 'Альфа', order: 0 },
    { id: 'p2', name: 'Бета', order: 1 }
  ];
  const char = (id, nick, partyId) => ({
    id,
    nick,
    class: '',
    partyIds: partyId ? [partyId] : [],
    mainPartyId: partyId || null,
    isLoggedIn: true
  });
  state.characters = [
    char('c1', 'Аня', 'p1'),
    char('c2', 'Борис', 'p1'),
    char('c3', 'Вика', 'p2'),
    char('c4', 'Гена', null)
  ];
  state.marathonTemplates = [];
  marathon = model.createMarathon({
    id: 'm',
    title: 'Июнь',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    participantIds: ['c1', 'c2', 'c3'],
    tasks: [
      model.createTask({ id: 't1', title: 'Задание 1', targetChecks: 2 }),
      model.createTask({ id: 't2', title: 'Задание 2', targetChecks: 2 })
    ],
    assignments: { c1: ['t1', 't2'], c2: ['t1', 't2'], c3: ['t1', 't2'] }
  });
  state.marathons = [marathon];
  wizard.openMarathonWizard({ marathon });
  $('[data-act="next"]').click(); // шаг «Участники»
  expect($('.tf-pick')).not.toBeNull();
});

describe('назначение заданий в мастере', () => {
  it('галочка не сбрасывает прокрутку таблицы и тела мастера, фокус остаётся на ячейке', () => {
    const body = $('.tf-dialog-body');
    const wrap = $('.tf-mx-wrap');
    body.scrollTop = 140;
    body.scrollLeft = 11;
    wrap.scrollTop = 26;
    wrap.scrollLeft = 90;
    const cb = cell('c1', 't2');
    cb.focus();
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));

    expect($('.tf-dialog-body').scrollTop).toBe(140);
    expect($('.tf-dialog-body').scrollLeft).toBe(11);
    expect($('.tf-mx-wrap').scrollTop).toBe(26);
    expect($('.tf-mx-wrap').scrollLeft).toBe(90);
    expect(document.activeElement?.getAttribute('data-cell')).toBe('c1|t2');
    expect(cell('c1', 't2').checked).toBe(false);
  });

  it('кнопка пати убирает только своё задание и только у своей пати', () => {
    const btn = partyButton('Альфа', 't1');
    expect(btn.textContent).toContain('✕');
    expect(btn.querySelector('.tf-party-task-count').textContent).toBe('2/2');
    btn.focus();
    btn.click();

    const after = partyButton('Альфа', 't1');
    expect(after.textContent).toContain('+');
    expect(after.querySelector('.tf-party-task-count').textContent).toBe('0/2');
    expect(cell('c1', 't1').checked).toBe(false);
    expect(cell('c2', 't1').checked).toBe(false);
    expect(cell('c1', 't2').checked).toBe(true); // второе задание пати не тронуто
    expect(cell('c3', 't1').checked).toBe(true); // другая пати не тронута
    expect(cell('c4', 't1').disabled).toBe(true); // неучастник остался неучастником
    expect($('.tf-mx-wrap').scrollTop).toBe(0);
    expect(document.activeElement?.getAttribute('data-focus-key')).toBe('party-task:Альфа:t1');
  });

  it('повторный клик возвращает задание, сохранение фиксирует назначения', async () => {
    partyButton('Альфа', 't1').click(); // убрали
    expect(partyButton('Альфа', 't1').textContent).toContain('+');
    partyButton('Альфа', 't1').click(); // вернули
    expect(partyButton('Альфа', 't1').textContent).toContain('✕');
    expect(cell('c1', 't1').checked).toBe(true);
    expect(cell('c2', 't1').checked).toBe(true);

    partyButton('Альфа', 't1').click(); // снова убираем и сохраняем
    $('[data-act="save"]').click();
    await vi.waitFor(() => expect(state.marathons[0].assignments.c1).not.toContain('t1'));
    expect(state.marathons[0].assignments.c2).toEqual(['t2']);
    expect(state.marathons[0].assignments.c3).toEqual(['t1', 't2']);
    expect(state.marathons[0].participantIds).toEqual(['c1', 'c2', 'c3']);
  });
});

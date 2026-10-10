// Правка записи календаря: форма должна заполняться текущими значениями и сохранять
// в тот же объект, а не создавать новую запись (plannerView.js).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/core/storage.js', () => ({ persist: vi.fn(async () => {}), saveNow: vi.fn(async () => {}) }));
vi.mock('../js/core/ui.js', async () => {
  const actual = await vi.importActual('../js/core/ui.js');
  return { ...actual, toast: vi.fn() };
});

const NOW = new Date('2026-10-05T12:00:00Z');
let state, openPlannerDay, normalizePlannerEntry, persist;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
  document.body.innerHTML = '<div id="modal-root"></div>';
  // showModal сообщает об ошибке через alert, а jsdom его не умеет
  vi.stubGlobal('alert', () => {});
  ({ state } = await import('../js/core/state.js'));
  ({ openPlannerDay } = await import('../js/modules/dashboard/plannerView.js'));
  ({ normalizePlannerEntry } = await import('../js/modules/dashboard/planner.js'));
  ({ persist } = await import('../js/core/storage.js'));
  state.settings = { freshness: {}, ui: { plannerView: 'month' } };
  state.plannerEntries = [];
  state.marathons = [];
});

const sample = () => normalizePlannerEntry({
  title: 'Собрать пати',
  date: '2026-10-05',
  time: '19:30',
  durationMinutes: 120,
  kind: 'task',
  priority: 'high',
  color: 'red',
  recurrence: 'weekly',
  status: 'todo'
});

/** Форма, открытая из окна дня. */
const openForm = () => document.querySelector('#modal-root form');
const submit = () => [...document.querySelectorAll('#modal-root .modal-footer button')]
  .find(b => /Сохранить|Добавить/.test(b.textContent));

const setField = (name, value) => {
  const el = openForm().querySelector(`[name="${name}"]`);
  el.value = value;
};

describe('правка записи календаря', () => {
  it('у своей записи есть кнопка правки, у марафона — нет', () => {
    state.plannerEntries = [sample()];
    state.marathons = [{ id: 'm1', kind: 'single', title: 'Марафон', status: 'active', startDate: '2026-10-05', endDate: '2026-10-05' }];
    openPlannerDay('2026-10-05', {});
    const doc = document.querySelector('#modal-root');
    expect(doc.querySelector('[data-planner-edit]')).toBeTruthy();
    expect(doc.querySelectorAll('[data-planner-edit]')).toHaveLength(1);   // только своя запись
  });

  it('форма правки заполнена текущими значениями записи', async () => {
    const e = sample();
    state.plannerEntries = [e];
    openPlannerDay('2026-10-05', {});
    document.querySelector('[data-planner-edit]').click();
    const form = openForm();
    expect(form.querySelector('[name="title"]').value).toBe('Собрать пати');
    expect(form.querySelector('[name="date"]').value).toBe('2026-10-05');
    expect(form.querySelector('[name="time"]').value).toBe('19:30');
    expect(form.querySelector('[name="durationMinutes"]').value).toBe('120');
    expect(form.querySelector('[name="priority"]').value).toBe('high');
    expect(form.querySelector('[name="color"]').value).toBe('red');
    expect(form.querySelector('[name="recurrence"]').value).toBe('weekly');
    expect(form.querySelector('[name="status"]').value).toBe('todo');
  });

  it('правка меняет ту же запись, а не создаёт новую: id, дата создания и порядок сохранены', async () => {
    const e = sample();
    state.plannerEntries = [e];
    const id = e.id;
    const createdAt = e.createdAt;
    openPlannerDay('2026-10-05', {});
    document.querySelector('[data-planner-edit]').click();
    setField('title', 'Собрать пати (перенесено)');
    setField('time', '20:15');
    submit().click();
    await vi.waitFor(() => expect(state.plannerEntries[0].title).toBe('Собрать пати (перенесено)'));

    expect(state.plannerEntries).toHaveLength(1);          // не добавилась вторая
    expect(state.plannerEntries[0].id).toBe(id);
    expect(state.plannerEntries[0].createdAt).toBe(createdAt);
    expect(state.plannerEntries[0].time).toBe('20:15');
    expect(persist).toHaveBeenCalled();
  });

  it('в форме правки можно сменить состояние и цвет', async () => {
    const e = sample();
    state.plannerEntries = [e];
    openPlannerDay('2026-10-05', {});
    document.querySelector('[data-planner-edit]').click();
    setField('status', 'done');
    setField('color', 'green');
    submit().click();
    await vi.waitFor(() => expect(state.plannerEntries[0].status).toBe('done'));
    expect(state.plannerEntries[0].color).toBe('green');
  });

  it('пустое название не сохраняется', async () => {
    const e = sample();
    state.plannerEntries = [e];
    openPlannerDay('2026-10-05', {});
    document.querySelector('[data-planner-edit]').click();
    setField('title', '   ');
    submit().click();
    await vi.waitFor(() => expect(openForm()).toBeTruthy());   // форма осталась открытой
    expect(state.plannerEntries[0].title).toBe('Собрать пати'); // и запись не тронута
  });

  it('повтор на другой день правится целиком, и об этом сказано в форме', () => {
    const e = sample();                       // повтор по понедельникам, начало 05.10
    state.plannerEntries = [e];
    // 12 октября — тоже понедельник, поэтому запись попадает в этот день
    openPlannerDay('2026-10-12', {});
    document.querySelector('[data-planner-edit]').click();
    expect(openForm().querySelector('.planner-form-note').textContent).toContain('повторяется');
    // И правим мы основную запись, а не этот день
    expect(openForm().querySelector('[name="date"]').value).toBe('2026-10-05');
  });

  it('создание записи по-прежнему работает: пустая форма и новая запись', async () => {
    openPlannerDay('2026-10-05', {});
    document.querySelector('[data-planner-add]').click();
    const form = openForm();
    expect(form.querySelector('[name="title"]').value).toBe('');
    expect(form.querySelector('[name="status"]')).toBeNull();   // состояния у новой записи нет
    setField('title', 'Новая задача');
    submit().click();
    await vi.waitFor(() => expect(state.plannerEntries).toHaveLength(1));
    expect(state.plannerEntries[0].title).toBe('Новая задача');
  });
});
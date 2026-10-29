// Только макет: все данные и действия ниже вымышлены, ничего не сохраняется на диск.
// Различия и журнал живут в памяти страницы и не связаны с состоянием приложения.
const EXAMPLE_DIFFERENCES = [
  {
    id: 'task-new',
    kind: 'added',
    section: 'Календарь',
    title: 'Задача дня · Подготовиться к походу',
    field: 'Срок и отметка',
    local: 'Нет на этом ПК',
    cloud: '28 октября · Не начато'
  },
  {
    id: 'event-new',
    kind: 'added',
    section: 'Календарь',
    title: 'Событие · Клановый поход',
    field: 'Дата и время',
    local: 'Нет на этом ПК',
    cloud: '29 октября · 20:00'
  },
  {
    id: 'task-status',
    kind: 'changed',
    section: 'Календарь',
    title: 'Повторяющаяся задача · Забрать награду',
    field: 'Отметка за 28 октября',
    local: 'Не начато',
    cloud: 'Выполнено'
  },
  {
    id: 'marathon-progress',
    kind: 'changed',
    section: 'Марафоны',
    title: 'Марафон · Пройти подземелье',
    field: 'Прогресс с сайта',
    local: '1 из 3',
    cloud: '2 из 3'
  },
  {
    id: 'coin-balance',
    kind: 'changed',
    section: 'Персонажи',
    title: 'Звеномир · Древние монеты',
    field: 'Баланс',
    local: '240',
    cloud: '315'
  },
  {
    id: 'party-deleted',
    kind: 'deleted',
    section: 'Пати',
    title: 'Пати · Старый состав',
    field: 'Подтверждённое удаление в примере',
    local: 'Существует',
    cloud: 'Удалено на диске'
  }
];

export const DEMO_PROVIDERS = Object.freeze({ google: 'Google Диск', yandex: 'Яндекс Диск' });
const clone = value => structuredClone(value);

function exampleTime(milliseconds) {
  try {
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  } catch {
    return null;
  }
}

/** Условная последовательность действий; не является синхронизацией или транспортом. */
export class DemoDiskWorkflow {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    const start = now();
    // Вымышленные даты относятся к входящим версиям, а не к реальным дискам.
    // Условная отправка создаёт отдельную версию и не изменяет эти даты.
    this.cloudModifiedAt = {
      google: exampleTime(start - 2 * 60 * 60 * 1000),
      yandex: exampleTime(start - 26 * 60 * 60 * 1000)
    };
    this.localSavedAt = exampleTime(start - 60 * 60 * 1000);
    this.reviewTimes = null;
    this.provider = 'google';
    this.differences = clone(EXAMPLE_DIFFERENCES);
    this.checked = false;
    this.selected = new Set();
    this.confirmingDeletion = false;
    this.logs = [];
  }

  snapshot() {
    return {
      provider: this.provider,
      differences: clone(this.differences),
      checked: this.checked,
      reviewTimes: this.reviewTimes ? clone(this.reviewTimes) : null,
      selected: [...this.selected],
      confirmingDeletion: this.confirmingDeletion,
      logs: clone(this.logs)
    };
  }

  chooseProvider(provider) {
    if (!Object.hasOwn(DEMO_PROVIDERS, provider)) throw new Error('Неизвестный диск в примере');
    if (this.provider === provider) return false;
    this.provider = provider;
    // Другой диск получает новый независимый вымышленный пример. Старый просмотр и
    // выбор недействительны: их нельзя применить к другой учётной записи.
    this.differences = clone(EXAMPLE_DIFFERENCES);
    this.checked = false;
    this.reviewTimes = null;
    this.selected.clear();
    this.confirmingDeletion = false;
    return true;
  }

  check() {
    this.checked = true;
    this.reviewTimes = {
      fileModifiedAt: this.cloudModifiedAt[this.provider],
      checkedAt: exampleTime(this.now()),
      localSavedAt: this.localSavedAt
    };
    this.selected.clear();
    this.confirmingDeletion = false;
    return this.snapshot();
  }

  select(id, selected) {
    if (!this.checked || !this.differences.some(row => row.id === id)) return false;
    if (selected) this.selected.add(id);
    else this.selected.delete(id);
    // Любое изменение выбора отменяет ранее выведенное подтверждение удаления.
    this.confirmingDeletion = false;
    return true;
  }

  selectVisible(ids) {
    if (!this.checked || !Array.isArray(ids)) return;
    const visible = new Set(ids);
    for (const row of this.differences) {
      if (visible.has(row.id)) this.selected.add(row.id);
    }
    // Подтверждение относится к прежнему выбору и не может пережить его изменение.
    this.confirmingDeletion = false;
  }

  clearSelection() {
    this.selected.clear();
    this.confirmingDeletion = false;
  }

  record(action, changes = []) {
    const at = exampleTime(this.now());
    if (!at) throw new Error('Недоступны часы для примера');
    const event = {
      action,
      provider: this.provider,
      at,
      changes: changes.map(({ section, title, field, kind }) => ({ section, title, field, kind }))
    };
    this.logs.unshift(event);
    if (this.logs.length > 100) this.logs.length = 100;
    return clone(event);
  }

  upload() {
    // В реальном механизме отдельная версия не заменяет незамеченные правки на диске.
    // Здесь это лишь запись в демонстрационный журнал, не сетевой запрос и не файл.
    const event = this.record('upload');
    this.localSavedAt = event.at;
    // Даже в примере старый предпросмотр больше не годится после изменения диска.
    this.checked = false;
    this.reviewTimes = null;
    this.selected.clear();
    this.confirmingDeletion = false;
    return event;
  }

  requestUpdate() {
    if (!this.checked || !this.selected.size) return { status: 'nothing-selected' };
    const chosen = this.differences.filter(row => this.selected.has(row.id));
    if (chosen.some(row => row.kind === 'deleted')) {
      this.confirmingDeletion = true;
      return { status: 'confirm-deletion', count: chosen.filter(row => row.kind === 'deleted').length };
    }
    return this.applySelected();
  }

  cancelDeletion() {
    this.confirmingDeletion = false;
  }

  confirmDeletion() {
    if (!this.confirmingDeletion) return { status: 'nothing-selected' };
    return this.applySelected(true);
  }

  applySelected(confirmedDeletion = false) {
    const chosen = this.differences.filter(row => this.selected.has(row.id));
    if (!this.checked || !chosen.length) return { status: 'nothing-selected' };
    if (chosen.some(row => row.kind === 'deleted') && (!confirmedDeletion || !this.confirmingDeletion)) {
      return { status: 'confirm-deletion' };
    }
    const event = this.record('update', chosen);
    this.differences = this.differences.filter(row => !this.selected.has(row.id));
    this.selected.clear();
    this.confirmingDeletion = false;
    // В сводке остаётся время локального состояния именно на момент проверки;
    // при следующей проверке будет показано время условного обновления.
    this.localSavedAt = event.at;
    return { status: 'updated', event };
  }
}

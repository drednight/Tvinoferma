// js/components/ProgressBar.js
// Совместимая обёртка над журналом задач (js/taskLog.js):
// show/update/hide как раньше, но прогресс показывается в доке задач
// с раскрывающимися подробностями и полным логом после завершения.

import { startTask } from '../taskLog.js';

export class ProgressBar {
    constructor() {
        this.task = null;
    }

    get isOpen() { return !!this.task && this.task.status === 'running'; }

    /** Начать задачу (если уже идёт — только сменить заголовок шага). */
    show(title, opts = {}) {
        if (this.isOpen) { this.task.setStep(title); return this.task; }
        this.task = startTask(title, opts);
        return this.task;
    }

    update(current, total, message = '') {
        if (!this.task) return;
        this.task.progress(current, total, message);
        if (message) this.task.log(`${current}/${total} · ${message}`);
    }

    log(message, level = 'info') { this.task?.log(message, level); }

    hide(summary = '', status) {
        if (this.task && this.task.status === 'running') this.task.finish(summary, status);
    }
}

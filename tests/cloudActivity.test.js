// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudActivity,
  cloudActivityPersisted,
  clearCloudActivity,
  describeCloudActivity,
  recordCloudActivity
} from '../js/modules/cloudSync/cloudEventLog.js';
import { bindCloudActivityPanel } from '../js/modules/cloudSync/ui/cloudActivityPanel.js';

const html = readFileSync('index.html', 'utf8');
const KEY = 'tf_cloud_activity_v1';
beforeEach(() => {
  localStorage.clear();
  clearCloudActivity();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.getElementById('cloud-activity-panel').outerHTML;
});
afterEach(() => {
  vi.restoreAllMocks();
  clearCloudActivity();
  document.body.innerHTML = '';
});

describe('местный журнал синхронизации', () => {
  it('записывает только разрешённые коды, без деталей данных или ошибок', () => {
    recordCloudActivity('google', 'send', 'uncertain');
    const events = cloudActivity();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ provider: 'google', action: 'send', outcome: 'uncertain' }));
    expect(Object.keys(events[0]).sort()).toEqual(['action', 'at', 'outcome', 'provider']);
    expect(describeCloudActivity(events[0])).toContain('Google Диск');
    expect(describeCloudActivity(events[0])).toContain('результат не подтверждён');
    expect(() => recordCloudActivity('google', 'secret <bad>', 'success')).toThrow();
    expect(() => recordCloudActivity('google', '__proto__', 'success')).toThrow();
    expect(() => recordCloudActivity('google', 'send', 'token')).toThrow();
    expect(localStorage.getItem(KEY)).not.toContain('token');
  });
  it('различает ручные операции контактов, сохраняя только разрешённые коды', () => {
    for (const action of ['private_prepare', 'private_check', 'private_apply'])
      expect(recordCloudActivity('yandex', action, 'success')).toBe(true);
    const entries = cloudActivity();
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['action', 'at', 'outcome', 'provider']);
      expect(describeCloudActivity(entry)).toContain('контактов');
    }
  });
  it('не называет снятие ожидания успешной отправкой', () => {
    recordCloudActivity('google', 'file_release', 'uncertain');
    recordCloudActivity('yandex', 'file_choice', 'success');
    const rows = cloudActivity();
    expect(describeCloudActivity(rows[0])).toContain('Выбор итогового полного файла');
    expect(describeCloudActivity(rows[1])).toContain('Снятие местного ожидания');
    expect(describeCloudActivity(rows[1])).not.toContain('Отправка');
  });
  it('не выводит чужие поля и HTML из повреждённого хранилища', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          provider: 'google',
          action: 'check',
          outcome: 'success',
          at: '2026-10-30T10:00:00.000Z',
          secret: '<img src=x>'
        },
        { provider: 'google', action: '<script>', outcome: 'success', at: '2026-10-30T10:00:00.000Z' }
      ])
    );
    bindCloudActivityPanel({ confirm: () => true });
    expect(document.querySelectorAll('#cloud-activity-list li')).toHaveLength(1);
    expect(document.querySelector('#cloud-activity-list img')).toBeNull();
    expect(document.getElementById('cloud-activity-list').textContent).not.toContain('<img');
    expect(JSON.stringify(cloudActivity())).not.toContain('secret');
  });
  it('ограничен 200 событиями и очистка требует подтверждения', async () => {
    for (let i = 0; i < 205; i++) recordCloudActivity('yandex', 'check', 'blocked');
    expect(cloudActivity()).toHaveLength(200);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    bindCloudActivityPanel({ confirm });
    expect(document.querySelectorAll('#cloud-activity-list li')).toHaveLength(200);
    document.getElementById('cloud-activity-clear').click();
    await vi.waitFor(() => expect(document.getElementById('cloud-activity-clear').disabled).toBe(false));
    expect(cloudActivity()).toHaveLength(200);
    document.getElementById('cloud-activity-clear').click();
    await vi.waitFor(() => expect(cloudActivity()).toHaveLength(0));
    expect(document.getElementById('cloud-activity-status').textContent).toContain('Записей пока нет');
  });
  it('при недоступном localStorage честно сообщает о временном журнале', () => {
    bindCloudActivityPanel({ confirm: () => true });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(recordCloudActivity('google', 'apply', 'uncertain')).toBe(false);
    expect(cloudActivityPersisted()).toBe(false);
    expect(cloudActivity()).toHaveLength(1);
    expect(document.getElementById('cloud-activity-status').textContent).toContain('только события текущего запуска');
    vi.restoreAllMocks();
    expect(recordCloudActivity('google', 'check', 'success')).toBe(true);
    expect(cloudActivity()).toHaveLength(2);
  });
});

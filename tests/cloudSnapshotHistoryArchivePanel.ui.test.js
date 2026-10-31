import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindSnapshotHistoryArchivePanel } from '../js/modules/cloudSync/ui/snapshotHistoryArchivePanel.js';
import { MAX_HISTORY_ARCHIVE_BYTES } from '../js/modules/cloudSync/snapshotHistoryArchive.js';
const html = readFileSync('index.html', 'utf8'),
  el = id => document.getElementById(`cloud-history-${id}`);
function setup(overrides = {}) {
  const view = {
    status: 'archive_ready',
    provider: 'google',
    heads: 2,
    bytes: 10000,
    capacity: { versions: 97, maxVersions: 128, protectedVersions: 97, deletableVersions: 0, nearLimit: true },
    cancel: vi.fn()
  };
  const prepare = vi.fn(async () => view),
    download = vi.fn(() => ({
      status: 'archive_download',
      text: 'ENCRYPTED_ARCHIVE_ONLY',
      fileName: 'test.tf-history.json'
    })),
    verify = vi.fn(async () => ({ status: 'archive_verified', versions: 97 })),
    saveFile = vi.fn(),
    confirm = vi.fn(() => true),
    loadNative = vi.fn(async () => ({ invoke: vi.fn() }));
  const options = { desktop: true, prepare, download, verify, saveFile, confirm, loadNative, ...overrides };
  bindSnapshotHistoryArchivePanel(options);
  return { ...options, view };
}
async function prepare() {
  el('prepare').click();
  await vi.waitFor(() => expect(el('download').disabled).toBe(false));
}
function select(size = 10) {
  Object.defineProperty(el('file'), 'files', {
    configurable: true,
    value: [{ size, text: vi.fn(async () => 'ENCRYPTED_ARCHIVE_ONLY') }]
  });
  el('file').dispatchEvent(new Event('change'));
}
beforeEach(() => {
  document.body.innerHTML = new DOMParser()
    .parseFromString(html, 'text/html')
    .getElementById('cloud-registration-panel').outerHTML;
  document.getElementById('cloud-registration-provider').value = 'google';
});
describe('архив облачной истории — интерфейс', () => {
  it('изначально свёрнут; запрещает скачивание и чтение до подготовки', () => {
    setup();
    expect(document.getElementById('cloud-history-archive').open).toBe(false);
    expect(el('download').disabled).toBe(true);
    expect(el('file').disabled).toBe(true);
    expect(el('verify').disabled).toBe(true);
  });
  it('показывает запас, несколько голов и отсутствие безопасной очистки', async () => {
    setup();
    await prepare();
    expect(el('status').textContent).toContain('97 из 128');
    expect(el('status').textContent).toContain('голов: 2');
    expect(el('status').textContent).toContain('безопасно удаляемых: 0');
    expect(el('status').textContent).toContain('не освободит лимит');
  });
  it('скачивание требует отдельное согласие и не называется подтверждённым сохранением', async () => {
    const f = setup();
    await prepare();
    el('download').click();
    await vi.waitFor(() => expect(f.saveFile).toHaveBeenCalledTimes(1));
    expect(f.confirm.mock.calls[0][0]).toContain('не разрешение удалять');
    expect(el('status').textContent).toContain('ещё не подтверждение записи');
    expect(f.verify).not.toHaveBeenCalled();
    expect(document.getElementById('cloud-history-archive').textContent).not.toContain('ENCRYPTED_ARCHIVE_ONLY');
  });
  it('перечитывает выбранный файл и только после успешной сверки показывает результат', async () => {
    const f = setup();
    await prepare();
    select();
    el('verify').click();
    await vi.waitFor(() => expect(el('status').textContent).toContain('Сохранённый архив сверен чтением'));
    expect(f.verify.mock.calls[0][0]).toMatchObject({
      review: f.view,
      text: 'ENCRYPTED_ARCHIVE_ONLY',
      provider: 'google'
    });
    expect(f.download).not.toHaveBeenCalled();
    expect(el('status').textContent).toContain('не удалялись');
  });
  it('слишком большой файл отклоняется до чтения и native вызова', async () => {
    const f = setup();
    await prepare();
    f.loadNative.mockClear();
    select(MAX_HISTORY_ARCHIVE_BYTES + 1);
    el('verify').click();
    await vi.waitFor(() => expect(el('status').textContent).toContain('слишком большой'));
    expect(el('file').files[0].text).not.toHaveBeenCalled();
    expect(f.loadNative).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });
  it('смена провайдера во время подтверждения отменяет скачивание', async () => {
    let approve;
    const f = setup({
      confirm: () =>
        new Promise(resolve => {
          approve = resolve;
        })
    });
    await prepare();
    el('download').click();
    await vi.waitFor(() => expect(approve).toBeTypeOf('function'));
    document.getElementById('cloud-registration-provider').dispatchEvent(new Event('change'));
    approve(true);
    await vi.waitFor(() => expect(el('prepare').disabled).toBe(false));
    expect(f.download).not.toHaveBeenCalled();
    expect(f.saveFile).not.toHaveBeenCalled();
    expect(f.view.cancel).toHaveBeenCalled();
  });
  it('не выдаёт устаревший архив или pending за успех', async () => {
    setup({ prepare: vi.fn(async () => ({ status: 'pending_upload' })) });
    el('prepare').click();
    await vi.waitFor(() => expect(el('status').textContent).toContain('не входит в облачный архив'));
    expect(el('download').disabled).toBe(true);
  });
  it('web отключён, сохранение сбрасывает старый просмотр в desktop', async () => {
    setup();
    await prepare();
    window.dispatchEvent(new Event('tf-persisted'));
    expect(el('download').disabled).toBe(true);
    const root = document.getElementById('cloud-history-archive'),
      copy = root.cloneNode(true);
    root.replaceWith(copy);
    delete copy.dataset.bound;
    setup({ desktop: false });
    expect(el('prepare').disabled).toBe(true);
    expect(el('status').textContent).toContain('настольном');
  });
  it('смена выбранного файла снимает прежнее сообщение об успешной сверке', async () => {
    setup();
    await prepare();
    select();
    el('verify').click();
    await vi.waitFor(() => expect(el('status').textContent).toContain('Сохранённый архив сверен чтением'));
    await vi.waitFor(() => expect(el('verify').disabled).toBe(false));
    select();
    expect(el('status').textContent).toContain('ещё не сверен');
  });
});

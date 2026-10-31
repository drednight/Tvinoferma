// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { normalizeState, state } from '../js/core/state.js';
import { saveNow } from '../js/core/storage.js';
import { stageSyncIdentities } from '../js/modules/cloudSync/commitSyncIdentities.js';
import { captureInitialCloudBaseline } from '../js/modules/cloudSync/initialCloudBaseline.js';
import { safeSiteUrl } from '../js/modules/cloudSync/marathonExport.js';
import { buildPublicSnapshot } from '../js/modules/cloudSync/publicSnapshot.js';
import { prepareFullPublicSnapshotReplace } from '../js/modules/cloudSync/applyPublicSnapshot.js';
import {
  encryptSnapshot,
  decryptSnapshot,
  generateSyncId,
  generateRecoveryKey
} from '../js/modules/cloudSync/envelope.js';
import { runPageScript, fixture } from './helpers/pageScript.js';

const BASE = 'https://pwonline.ru/supermarathon.php';
const REPORT = '#TF_DETAIL_V4_' + encodeURIComponent(JSON.stringify({ data: 'FAKE_PRIVATE_REPORT', error: null }));
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('служебный hash из native navigate_clean не становится данными марафона в облаке', () => {
  it.each(['loading', 'interactive', 'complete'])('отделяет точную TF_READY_%s, не меняя исходный URL', ready => {
    const raw = BASE + '#TF_READY_' + ready;
    expect(safeSiteUrl(raw)).toBe(BASE);
    expect(raw).toContain('#TF_READY_');
  });
  it.each(['TF_TITLE_V4_', 'TF_DETAIL_V4_', 'TF_MARATHON_DATA_', 'TF_NEWS_V1_'])(
    'никогда не переносит содержимое служебного %s',
    prefix => {
      expect(safeSiteUrl(BASE + '#' + prefix + 'FAKE_PRIVATE_REPORT')).toBe(BASE);
    }
  );
  it.each([
    BASE + '#secret',
    BASE + '#TF_READY_complete-extra',
    BASE + '#TF_READY_FAKE_PRIVATE',
    BASE + '?token=FAKE_PRIVATE' + REPORT,
    BASE.replace('https:', 'http:') + REPORT,
    BASE.replace('pwonline.ru', 'evil.invalid') + REPORT,
    BASE.replace('pwonline.ru', 'user:FAKE_PRIVATE@pwonline.ru') + REPORT,
    BASE.replace('pwonline.ru', 'pwonline.ru:8080') + REPORT
  ])('не использует служебную метку для обхода строгих проверок адреса', url => {
    expect(() => safeSiteUrl(url)).toThrow();
  });
  it.each([
    ['marathon_titles.js', 'site-supermarathon2.html', 'TF_TITLE_V4_', 'url'],
    ['marathon_detail.js', 'site-supermarathon2.html', 'TF_DETAIL_V4_', 'sourceUrl'],
    ['marathon_news.js', 'site-news-summer.html', 'TF_NEWS_V1_', 'url']
  ])('настоящий %s не сохраняет READY/предыдущий report в URL результата', (script, file, prefix, key) => {
    const result = runPageScript(script, fixture(file), prefix, undefined, 'TF_READY_complete');
    expect(result.error).toBe(null);
    expect(result.data[key]).toBe(window.location.href.split('#')[0]);
    expect(result.data[key]).not.toContain('#');
  });

  it('backup → ID commit → AES → другой localState → reload без служебного payload; локальный оригинал сохраняется', async () => {
    Object.assign(
      state,
      normalizeState({
        schemaVersion: 10,
        characters: [{ id: 'hero', nick: 'Герой', contacts: { password: 'FAKE_PRIVATE_PASSWORD' } }],
        marathonTemplates: [{ id: 'template', name: 'Шаблон', tasks: [], sourceUrl: BASE + REPORT }],
        marathons: [
          {
            id: 'folder',
            kind: 'series',
            schemaVersion: 2,
            title: 'Папка',
            childIds: ['m'],
            source: { url: BASE + '#TF_READY_complete' }
          },
          {
            id: 'm',
            kind: 'single',
            schemaVersion: 2,
            title: 'Марафон',
            seriesId: 'folder',
            participantIds: ['hero'],
            source: {
              url: BASE + REPORT,
              newsUrl: 'https://pwonline.ru/news.php?article=42#TF_READY_interactive',
              templateId: 'template'
            },
            tasks: [{ id: 't', title: 'Задание' }],
            assignments: { hero: ['t'] },
            progress: {
              hero: {
                t: {
                  site: 1,
                  siteTotal: 5,
                  adjust: 1,
                  syncedAt: '2026-10-31',
                  marks: ['2026-10-31'],
                  history: { '2026-10-31': 1 }
                }
              }
            },
            balance: { start: { hero: { coins: 3, at: '2026-10-31' } }, end: {} },
            awards: [
              {
                characterId: 'hero',
                charNick: 'Герой',
                taskId: 't',
                taskTitle: 'Задание',
                rewardText: 'Награда',
                coins: 5
              }
            ]
          }
        ],
        settings: { security: { useVault: false } }
      })
    );
    await saveNow();
    const original = localStorage.getItem('tvinoferma_state_v1');
    const localMarathon = state.marathons[1];
    const localSource = localMarathon.source;
    const staged = stageSyncIdentities();
    const result = await staged.operation.commit({ confirmed: true });
    expect(result.status).toBe('applied');
    expect(localStorage.getItem(result.backup)).toBe(original);
    expect(state.marathons[1]).toBe(localMarathon);
    expect(state.marathons[1].source).toBe(localSource);
    expect(state.marathons[1].source.url).toBe(BASE + REPORT);
    const baseline = await captureInitialCloudBaseline();
    expect(baseline.status).toBe('ready');
    const snapshot = baseline.getPublicSnapshot();
    expect(JSON.stringify(snapshot)).not.toMatch(/TF_READY|TF_DETAIL|FAKE_PRIVATE/);
    const key = generateRecoveryKey(webcrypto);
    const datasetId = generateSyncId(webcrypto);
    const sealed = await encryptSnapshot({
      snapshot,
      recoveryKey: key,
      datasetId,
      versionId: generateSyncId(webcrypto),
      cryptoSource: webcrypto
    });
    const received = await decryptSnapshot({
      envelope: sealed,
      recoveryKey: key,
      expectedDatasetId: datasetId,
      cryptoSource: webcrypto
    });
    const { ui: _ui, ...empty } = normalizeState({ schemaVersion: 10 });
    const other = prepareFullPublicSnapshotReplace({
      localState: empty,
      cloudSnapshot: received,
      cryptoSource: webcrypto
    }).candidateState();
    expect(other.marathons[1].source.url).toBe(BASE);
    const otherHero = other.characters[0].id;
    const otherTask = other.marathons[1].tasks[0].id;
    expect(other.marathons[1].participantIds).toEqual([otherHero]);
    expect(other.marathons[1].assignments[otherHero]).toEqual([otherTask]);
    expect(other.marathons[1].progress[otherHero][otherTask]).toEqual(localMarathon.progress.hero.t);
    expect(other.marathons[1].balance.start[otherHero]).toEqual(localMarathon.balance.start.hero);
    expect(other.marathons[1].awards[0]).toMatchObject({ characterId: otherHero, taskId: otherTask, coins: 5 });
    expect(other.marathons[0].childIds).toEqual([other.marathons[1].id]);
    expect(other.marathons[1].seriesId).toBe(other.marathons[0].id);
    expect(other.marathonTemplates[0].sourceUrl).toBe(BASE);
    expect(buildPublicSnapshot(other)).toEqual(snapshot);
    const { ui: _otherUi, ...reloaded } = normalizeState(JSON.parse(JSON.stringify(other)));
    expect(buildPublicSnapshot(reloaded)).toEqual(snapshot);
    const { ui: _localUi, ...local } = state;
    const updated = structuredClone(snapshot);
    updated.sections.marathons.records.find(row => row.type === 'marathon').fields.description = 'Из облака';
    const applied = prepareFullPublicSnapshotReplace({
      localState: local,
      cloudSnapshot: updated,
      cryptoSource: webcrypto
    }).candidateState();
    expect(applied.marathons[1].description).toBe('Из облака');
    expect(applied.marathons[1].source.url).toBe(BASE + REPORT);
    expect(applied.marathons[1].source.newsUrl).toContain('#TF_READY_interactive');
    expect(applied.marathonTemplates[0].sourceUrl).toBe(BASE + REPORT);
    expect(buildPublicSnapshot(applied)).toEqual(updated);
    expect(applied.characters[0].contacts.password).toBe('FAKE_PRIVATE_PASSWORD');
    const pollutedCloud = structuredClone(received);
    pollutedCloud.sections.marathons.records.find(row => row.type === 'marathon').fields.source.url += REPORT;
    expect(() =>
      prepareFullPublicSnapshotReplace({ localState: local, cloudSnapshot: pollutedCloud, cryptoSource: webcrypto })
    ).toThrow();
    updated.sections.marathons.records.find(row => row.type === 'marathon').fields.source.url =
      'https://pwonline.ru/supermarathon2.php';
    const changed = prepareFullPublicSnapshotReplace({
      localState: local,
      cloudSnapshot: updated,
      cryptoSource: webcrypto
    }).candidateState();
    expect(changed.marathons[1].source.url).toBe('https://pwonline.ru/supermarathon2.php');
    expect(await baseline.stillCurrentAndSaved()).toBe(true);
    baseline.close();
  });
});

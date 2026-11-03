import { runningWindows } from '../launcher/runningWindows.js';
import { todayData } from './today.js';
import { normalizeGuildData } from '../guild/core.js';
// Routes dashboard actions to the existing production modules, never to demo launchers.
import { state } from '../../core/state.js';
import { CLASS_ICON_MAP } from '../../core/constants.js';
import { mskDate, mskAddDays } from '../../core/msk.js';
import { normalizePlannerEntry } from './planner.js';
import { discoveredPromos, promoCoverage } from '../automation/promoDiscovery.js';
import { loadLog } from '../automation/promoLog.js';
import { promoDeadlineState } from '../automation/promoDeadlineLabel.js';
import { currentBalances } from '../finance/model.js';
export const nativeToday = () => !!globalThis.window?.__TAURI_INTERNALS__;
export function connectedTodayState(preview) {
  let s = preview;
  if (nativeToday() || preview.production) {
    const bank = currentBalances(state.finance);
    s = {
      ...preview,
      day: { ...preview.day, date: mskDate(), gold: bank.gold, bank: bank.coins },
      characters: state.characters.map(c => ({
        id: c.id,
        nick: c.nick,
        partyIds: c.partyIds,
        mainPartyId: c.mainPartyId,
        className: c.class,
        icon: (CLASS_ICON_MAP[c.class] || '').replace(/\.webp$/, ''),
        coins: c.ancientCoins,
        auth: c.isLoggedIn ? 'online' : 'offline',
        party: c.mainPartyId
      })),
      parties: state.parties.map(p => ({ ...p, label: p.name })),
      calendarEvents: state.plannerEntries,
      activeWindows: runningWindows(),
      plannerState: { plannerEntries: state.plannerEntries, marathons: state.marathons },
      scenarios: { ...preview.scenarios, clan: state.settings.guild?.enabled === true }
    };
    if (!s.parties.some(p => p.id === s.day.favoriteParty)) s.day.favoriteParty = s.parties[0]?.id || '';
    s.guild = normalizeGuildData(state.settings.guild);
    const marathons = todayData(state).marathons;
    const active =
      state.marathons.find(m => marathons.some(p => p.id === m.id)) ||
      state.marathons
        .filter(m => m.kind !== 'series' && m.startDate > s.day.date && m.startDate <= mskAddDays(s.day.date, 7))
        .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    const progress = marathons.find(p => p.id === active?.id);
    s.scenarios.marathon = !!active;
    if (active) {
      s.day.marathon = {
        id: active.id,
        title: active.title,
        percent: progress?.participants ? Math.round((progress.done / progress.participants) * 100) : 0,
        startDate: active.startDate,
        endDate: active.endDate
      };
      s.day.marathonTasks = active.tasks.map(t => ({
        ...t,
        maxReward: t.rewards.map(r => r.rewardText || `${r.rewardCoins} монет`).join(' / ')
      }));
    }
  }
  return {
    ...s,
    sitePromos: promoCoverage(
      discoveredPromos().filter(p => {
        const deadline = promoDeadlineState(p);
        return !deadline.expired && deadline.days !== null;
      }),
      s.characters,
      loadLog()
    )
  };
}
export async function runTodayAction(action, { partyId, eventId, response, date, title, time, kind } = {}) {
  if (!nativeToday())
    return {
      ok: false,
      message: 'Действие доступно в десктопном приложении: браузерный макет не имеет доступа к вашим аккаунтам и окнам.'
    };
  if (action?.startsWith('clan-') && state.settings.guild?.enabled !== true)
    return { ok: false, message: 'Клан не активирован.' };
  if (action === 'launch') {
    const party = state.parties.find(p => p.id === partyId);
    if (!party) return { ok: false, message: 'Выбранный отряд не найден в приложении.' };
    await (await import('../launcher/partyLaunch.js')).launchPartyByName(party.name);
  } else if (action === 'windows') await (await import('../launcher/windowPicker.js')).openWindowPicker();
  else if (action === 'promo') (await import('../automation/promo.js')).openPromoDialog();
  else if (action === 'clan-open') await (await import('../guild/window.js')).openGuild();
  else if (action === 'clan-refresh') {
    if (!(await (await import('../guild/page.js')).syncGuild()))
      return { ok: false, message: 'Сводка клана не обновлена.' };
  } else if (action === 'clan-vote') {
    if (!(await (await import('../guild/page.js')).respond(eventId, response)))
      return { ok: false, message: 'Отметка не подтверждена сайтом.' };
  } else if (action === 'todo') {
    const entry = state.plannerEntries.find(e => e.id === eventId);
    if (entry) {
      const { setEntryStatusForDate } = await import('./planner.js');
      setEntryStatusForDate(entry, date, response);
      await (await import('../../core/storage.js')).persist();
    }
  } else if (action === 'event-add') {
    state.plannerEntries.push(normalizePlannerEntry({ date, title, time, kind }));
    await (await import('../../core/storage.js')).persist();
  } else if (action === 'promo-refresh') {
    await (await import('../automation/promoDiscovery.js')).promoDiscovery().check({ force: true });
  } else if (action === 'news-refresh') {
    const { invoke } = await import('@tauri-apps/api/core');
    await (await import('./siteFeed.js')).refreshSiteFeed({ invokeFn: invoke });
  }
  return { ok: true };
}

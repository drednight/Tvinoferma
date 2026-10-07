// Только для ui-shots --guides: настоящие диалоги на вымышленных данных.
// Чтение магазина подменяется локальным ответом; покупки и передачи НЕ разрешены.
export async function openScriptPreview(kind) {
  const { state } = await import('/js/core/state.js');
  const ids = state.characters.filter(c => c.isLoggedIn === true).map(c => c.id);
  if (kind === 'promo-dialog') {
    const { openPromoDialog } = await import('/js/modules/automation/promo.js');
    openPromoDialog({ ids });
    const input = document.getElementById('promo-code');
    input.value = 'PW-DEMO-2026'; input.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (kind === 'transfer-dialog') {
    const { setRoster, savePrefs } = await import('/js/modules/automation/transferStore.js');
    const { setServerStatus } = await import('/js/modules/servers/serverStatus.js');
    const prefs = { servers: {}, picks: {} };
    for (const [i, c] of state.characters.entries()) {
      const key = `${100 + i}_3_1`;
      setRoster(c.id, { siteId: String(100 + i), accountName: `demo_${i + 1}`, shards: [{ id: '3', name: 'Фенрир', chars: [{ key, name: c.nick, cls: c.class || c.className || c.cls, level: c.level }] }], items: [{ id: '1', name: 'Метеорит', qty: 100, source: 'Демонстрационный подарок' }], chests: 0, locked: 0 });
      prefs.servers[c.id] = '3'; prefs.picks[c.id] = { '3': key };
    }
    savePrefs(prefs); setServerStatus({ recommended: 'Фенрир', servers: [{ name: 'Фенрир', online: true }, { name: 'Мицар', online: true }] });
    const { openTransferDialog } = await import('/js/modules/automation/transfer.js'); openTransferDialog({ ids });
  } else if (kind === 'shop-dialog') {
    const { SHOP_ITEMS } = await import('/js/modules/automation/shopCore.js');
    const previous = window.__TAURI_INTERNALS__;
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === 'read_shop') {
          const c = state.characters.find(c => c.id === args.charId);
          return { status: 'ok', account: `demo_${c.id}`, balance: c.ancientCoins, items: SHOP_ITEMS.map((d, i) => ({ want: d.name, found: !d.event, name: d.name, id: String(i + 1), kind: d.chest ? 'chest' : 'item', price: d.chest ? 10 : 40, available: d.chest ? null : 4, max: null, blocked: false, hasLink: true, label: d.chest ? 'Открыть' : 'Купить', desc: '' })) };
        }
        if (cmd === 'read_shop_history') return { status: 'ok', rows: [] };
        throw new Error(`Стенд скриншотов не выполняет команду ${cmd}`);
      }
    };
    window.__tfShotCleanup = () => { window.__TAURI_INTERNALS__ = previous; };
    const { openShopDialog } = await import('/js/modules/automation/shop.js'); openShopDialog({ ids });
    await new Promise(resolve => setTimeout(resolve, 350));
    document.querySelector('[data-item="light"]').click();
    const amount = document.querySelector('input.shop-qty');
    if (amount) { amount.value = '1'; amount.dispatchEvent(new Event('input', { bubbles: true })); }
  } else if (kind === 'sync-task') {
    const { startTask, openTaskLog } = await import('/js/core/taskLog.js');
    const task = startTask('Проверка авторизации', { total: state.characters.length, dock: false, cancelable: true });
    task.log('6 персонажей, по 3 одновременно, повторов до 2', 'step');
    task.log('Ауразак: сессия подтверждена', 'ok'); task.log('Ночной_Бард: сессия подтверждена', 'ok');
    task.log('Тихая_Сова: ожидание ответа сайта', 'step'); task.progress(2, state.characters.length);
    openTaskLog(task.id);
    window.__tfShotCleanup = () => task.finish('Демонстрация завершена');
  }
  const sub = document.querySelector('.tf-dialog-sub');
  if (sub) {
    const caption = 'Демонстрационные данные · операции на сайте не выполняются';
    if (kind === 'sync-task') { const p = document.createElement('p'); p.textContent = caption; sub.prepend(p); }
    else sub.textContent = caption;
  }
}

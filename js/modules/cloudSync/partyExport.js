// @ts-check
// Разрешённая схема одной пати; ничего не записывает и не отправляет в сеть.
import { isSyncId } from './envelope.js';
import { array, boolean, invalidExport, nullableNumber, number, object, text } from './exportSchema.js';

/** @param {{ syncId?: string, characterSyncIds?: Map<string,string>, archived?: boolean }} [options] */
export function exportParty(party, options = {}) {
  const opts = object(options, ['syncId', 'characterSyncIds'], ['archived']);
  if (!isSyncId(opts.syncId) || !(opts.characterSyncIds instanceof Map)) throw invalidExport();
  const archived = Object.hasOwn(opts, 'archived') ? boolean(opts.archived) : false;
  const data = object(party, ['id', 'syncId', 'name', 'order', 'createdAt', 'updatedAt'], ['color', 'memberLinks']);
  if (!text(data.id) || data.syncId !== opts.syncId) throw invalidExport();
  if (archived !== Object.hasOwn(data, 'memberLinks')) throw invalidExport();
  const seen = new Set();
  const memberLinks = archived
    ? array(data.memberLinks, link => {
        const row = object(link, ['characterId', 'isMain', 'order']);
        const localId = text(row.characterId);
        const charSyncId = opts.characterSyncIds.get(localId);
        if (!isSyncId(charSyncId) || seen.has(charSyncId))
          throw new Error('Не найдены стабильные идентификаторы участников; экспорт остановлен');
        seen.add(charSyncId);
        return { characterId: charSyncId, isMain: boolean(row.isMain), order: nullableNumber(row.order) };
      })
    : [];
  const color = Object.hasOwn(data, 'color') ? data.color : null;
  if (color !== null && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) throw invalidExport();
  return {
    id: opts.syncId,
    type: 'party',
    archived,
    fields: {
      name: text(data.name),
      order: number(data.order),
      color,
      createdAt: text(data.createdAt),
      updatedAt: text(data.updatedAt),
      memberLinks
    }
  };
}

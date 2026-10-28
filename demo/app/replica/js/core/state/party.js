// @ts-check
// js/core/state/party.js
// Приведение партий к схеме — чистые функции без доступа к общему состоянию.

/**
 * Цвет пати, выбранный пользователем: `#rrggbb` или null («считать по названию»).
 * Любое другое значение отбрасывается — иначе битый файл state.json покрасит карточку
 * в произвольный цвет (или вообще сломает разметку).
 */
export function normalizePartyColor(value) {
  const raw = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null;
}

export function normalizeParty(input = {}) {
  return {
    id: input.id || crypto.randomUUID?.() || String(Date.now()),
    name: String(input.name || '').trim(),
    order: Number(input.order) || null,
    // Свой цвет пати; null — взять оттенок по названию
    color: normalizePartyColor(input.color),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  };
}

/** Архивная пати: та же схема плюс связи с персонажами, которые уже неактивны. */
export function normalizeArchivedParty(input = {}) {
  const party = normalizeParty(input);
  return {
    ...party,
    memberLinks: Array.isArray(input.memberLinks)
      ? input.memberLinks
          .filter(link => link && link.characterId)
          .map(link => ({
            characterId: String(link.characterId),
            isMain: link.isMain === true,
            order:
              link.order !== null && link.order !== undefined && Number.isFinite(Number(link.order))
                ? Number(link.order)
                : null
          }))
      : []
  };
}

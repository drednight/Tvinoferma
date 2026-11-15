const prefix = 'tvinoferma.macro-draft.v1.';
export function readDraft(id = 'new') {
  try {
    const raw = localStorage.getItem(prefix + id);
    if (!raw || raw.length > 100000) return null;
    const draft = JSON.parse(raw);
    if (
      draft.schema !== 1 ||
      !draft.fields ||
      !Array.isArray(draft.fields) ||
      draft.fields.length > 200 ||
      !draft.fields.every(
        entry => Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string')
      ) ||
      !Array.isArray(draft.blocks) ||
      draft.blocks.length > 8 ||
      !draft.blocks.every(
        block =>
          block &&
          typeof block === 'object' &&
          Array.isArray(block.steps) &&
          block.steps.length <= 64 &&
          block.steps.every(step => step && typeof step.type === 'string')
      )
    )
      return null;
    return draft;
  } catch {
    return null;
  }
}
export function writeDraft(id, fields, blocks, baseFingerprint) {
  try {
    const payload = JSON.stringify({ schema: 1, savedAt: new Date().toISOString(), fields, blocks, baseFingerprint });
    if (payload.length > 100000) return false;
    localStorage.setItem(prefix + (id || 'new'), payload);
    return true;
  } catch {
    return false;
  }
}
export function clearDraft(id = 'new') {
  try {
    localStorage.removeItem(prefix + id);
  } catch {
    /* No destructive recovery if storage is unavailable. */
  }
}

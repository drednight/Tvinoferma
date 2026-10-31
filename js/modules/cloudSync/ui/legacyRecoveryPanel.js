// @ts-check
// Inert historical controls are mounted only for explicit recovery, never at login.
export function openLegacyCloudRecovery(doc = document) {
  let dialog = /** @type {HTMLDialogElement|null} */ (doc.getElementById('cloud-legacy-dialog'));
  if (!dialog) {
    const template = /** @type {HTMLTemplateElement|null} */ (doc.getElementById('cloud-legacy-template'));
    if (!template) return null;
    dialog = doc.createElement('dialog');
    dialog.id = 'cloud-legacy-dialog';
    dialog.className = 'modal cloud-legacy-dialog';
    dialog.setAttribute('aria-label', 'Восстановление старого облачного набора');
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'btn ghost';
    close.textContent = 'Закрыть восстановление';
    close.addEventListener('click', () => dialog.close());
    dialog.append(close, template.content.cloneNode(true));
    doc.body.append(dialog);
    const fold = /** @type {HTMLDetailsElement|null} */ (doc.getElementById('cloud-standalone-legacy'));
    if (fold) fold.open = true;
  }
  if (!dialog.open) dialog.showModal();
  return dialog;
}

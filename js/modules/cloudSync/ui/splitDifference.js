import { cloudChangePath, cloudChangeValue } from './cloudFilePresentation.js';
import { characterFieldDifferences } from './characterFieldText.js';
// Read-only presentation. No consent, identity, snapshot or witness mutation.
export function appendSplitDifference(parent, change) {
  const doc = parent.ownerDocument,
    path = change.path,
    key = path.at(-1);
  if (key === 'lastCoinUpdate') {
    const p = doc.createElement('p');
    p.textContent = 'Дата проверки монет — автоматически последняя по времени.';
    parent.append(p);
    return;
  }
  const title = doc.createElement('strong');
  title.textContent = cloudChangePath(path);
  parent.append(title);
  const grid = doc.createElement('div');
  grid.className = 'cloud-split';
  parent.append(grid);
  const row = (values, heading = false) => {
    const line = doc.createElement('div');
    line.className = 'cloud-split-row' + (heading ? ' cloud-split-head' : '');
    for (const text of values) {
      const cell = doc.createElement('span');
      cell.textContent = text;
      line.append(cell);
    }
    grid.append(line);
  };
  row(['Показатель', 'На этом ПК', 'В облаке'], true);
  for (const diff of characterFieldDifferences(key, change.local?.value, change.cloud?.value))
    row([
      diff.label || cloudChangePath(path),
      cloudChangeValue({ ...change.local, value: diff.before }, diff.label ? [] : path),
      cloudChangeValue({ ...change.cloud, value: diff.after }, diff.label ? [] : path)
    ]);
}

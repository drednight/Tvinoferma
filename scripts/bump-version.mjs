// Поднимает версию приложения во всех местах сразу:
//   npm run version:bump 0.2.0
// package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock
import fs from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Укажите версию в формате X.Y.Z, например: npm run version:bump 0.2.0');
  process.exit(1);
}

const edit = (file, fn) => {
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) console.warn(`! ${file}: версия не найдена или уже ${version}`);
  fs.writeFileSync(file, after);
  console.log(`✓ ${file}`);
};

edit('package.json', s => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit('src-tauri/tauri.conf.json', s => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit('src-tauri/Cargo.toml', s => s.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${version}$2`));
if (fs.existsSync('src-tauri/Cargo.lock')) {
  edit('src-tauri/Cargo.lock', s => s.replace(/(\[\[package\]\]\nname = "tvinoferma"\nversion = ")[^"]+(")/, `$1${version}$2`));
}
console.log(`\nДальше:\n  git commit -am "Версия ${version}"\n  git tag v${version}\n  git push && git push origin v${version}`);

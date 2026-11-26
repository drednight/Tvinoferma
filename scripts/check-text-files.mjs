// Проверка текстовых файлов репозитория: ловит порчу, при которой исходник внезапно становится
// «бинарным» для Git (нулевые байты, UTF-16). Ничего не меняет и не восстанавливает.
//   node scripts/check-text-files.mjs            — все отслеживаемые файлы рабочей копии
//   node scripts/check-text-files.mjs --staged   — только подготовленные к коммиту (содержимое индекса)
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.json',
  '.md',
  '.css',
  '.html',
  '.rs',
  '.toml',
  '.yml',
  '.yaml',
  '.txt',
  '.svg',
  '.ps1',
  '.sh'
]);
const TEXT_NAMES = new Set(['.gitignore', '.gitattributes', '.npmrc', '.prettierignore', 'pre-commit', 'LICENSE']);

/** Относится ли путь к файлам, которые должны быть чистым текстом. */
export function isTextPath(file) {
  const name = file.split('/').pop() || '';
  return TEXT_NAMES.has(name) || TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * Разбирает байты одного файла.
 * `error` — файл испорчен (блокирует коммит и CI); `warning` — подозрительная кодировка, не блокирует.
 * @param {Uint8Array} bytes
 * @returns {{ level: 'error' | 'warning', kind: string, message: string } | null}
 */
export function inspectBytes(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 2) {
    const head = (buffer[0] << 8) | buffer[1];
    if (head === 0xfffe || head === 0xfeff) {
      return {
        level: 'error',
        kind: 'utf16',
        message: 'файл в UTF-16 (признак: перезапись через `>`, `Out-File` или `Set-Content` в Windows PowerShell 5.1)'
      };
    }
  }
  const first = buffer.indexOf(0);
  if (first !== -1) {
    let count = 0;
    let oddNuls = 0;
    let evenNuls = 0;
    for (let i = first; i < buffer.length; i += 1) {
      if (buffer[i] !== 0) continue;
      count += 1;
      if (i % 2) oddNuls += 1;
      else evenNuls += 1;
    }
    // UTF-16 без BOM: латиница даёт нулевой байт через один.
    if (buffer.length >= 4 && count * 4 >= buffer.length && (oddNuls === 0 || evenNuls === 0)) {
      return { level: 'error', kind: 'utf16', message: 'похоже на UTF-16 без BOM (нулевые байты через один)' };
    }
    const tailZero = buffer.subarray(first).every(byte => byte === 0);
    return {
      level: 'error',
      kind: tailZero ? 'zero-tail' : 'nul-bytes',
      message: tailZero
        ? `с позиции ${first} файл заполнен нулями до конца (${buffer.length - first} байт): обычно сбой диска, синхронизации или записи`
        : `в файле ${count} нулевых байт, первый в позиции ${first}`
    };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return {
      level: 'warning',
      kind: 'invalid-utf8',
      message:
        'не UTF-8 (возможно, ANSI/cp1251 после `Set-Content` в Windows PowerShell 5.1): кириллица может быть испорчена'
    };
  }
  return null;
}

/**
 * @param {string} [cwd]
 * @param {{ staged?: boolean }} [options]
 * @returns {{ file: string, level: 'error' | 'warning', kind: string, message: string }[]}
 */
export function checkTextFiles(cwd = process.cwd(), { staged = false } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 1024 * 1024 * 256 });
  const names = staged
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
    : git('ls-files', '--cached', '-z');
  const files = names
    .toString('utf8')
    .split('\0')
    .filter(file => file && isTextPath(file));
  const problems = [];
  for (const file of files) {
    let bytes;
    if (staged) {
      const stage = git('ls-files', '--stage', '-z', '--', file).toString('utf8');
      if (!['100644', '100755'].includes(stage.split(' ')[0])) continue;
      bytes = git('show', `:${file}`);
    } else {
      const path = resolve(cwd, file);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        continue; // файл удалён в рабочей копии — это не порча
      }
      if (!info.isFile()) continue;
      bytes = readFileSync(path);
    }
    const result = inspectBytes(bytes);
    if (result) problems.push({ file, ...result });
  }
  return problems;
}

/** Текст отчёта и подсказка по восстановлению. Возвращает число ошибок. */
export function report(problems, { staged = false } = {}, log = console) {
  const errors = problems.filter(problem => problem.level === 'error');
  for (const problem of problems) {
    const mark = problem.level === 'error' ? 'ОШИБКА' : 'внимание';
    (problem.level === 'error' ? log.error : log.warn)(`${mark}: ${problem.file}: ${problem.message}`);
  }
  if (errors.length) {
    log.error(
      staged
        ? 'Коммит остановлен: в индексе испорченные текстовые файлы. Восстановите их из HEAD и подготовьте заново.'
        : 'Найдены испорченные текстовые файлы. Восстановление из HEAD (PowerShell), если правок в них не было:'
    );
    if (!staged) {
      for (const problem of errors) {
        log.error(`  Remove-Item -LiteralPath '${problem.file}' -Force; git checkout HEAD -- '${problem.file}'`);
      }
    }
  }
  return errors.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const staged = process.argv.includes('--staged');
  try {
    const problems = checkTextFiles(process.cwd(), { staged });
    const errors = report(problems, { staged });
    if (errors) process.exitCode = 1;
    else if (!problems.length) console.log('Текстовые файлы в порядке.');
  } catch (error) {
    console.error(`Проверка текстовых файлов: ${error.message}`);
    process.exitCode = 1;
  }
}

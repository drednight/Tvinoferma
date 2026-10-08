import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
const json = path => JSON.parse(readFileSync(path, 'utf8'));

describe('версия релиза', () => {
  it('npm, lock-файл, Tauri и Cargo согласованы', () => {
    const version = json('package.json').version;
    expect(json('package-lock.json').version).toBe(version);expect(json('package-lock.json').packages[''].version).toBe(version);
    expect(json('src-tauri/tauri.conf.json').version).toBe(version);
    expect(readFileSync('src-tauri/Cargo.toml','utf8')).toMatch(new RegExp(`\\[package\\][^]*?version = "${version.replaceAll('.', '\\.')}"`));
    expect(readFileSync('src-tauri/Cargo.lock','utf8').replace(/\r\n/g, '\n')).toContain(`name = "tvinoferma"\nversion = "${version}"`);
  });
  it('команда bump обновляет lock-файл, не меняя версии зависимостей', () => {
    const dir=mkdtempSync(join(tmpdir(),'tf-version-'));
    try {
      mkdirSync(join(dir,'src-tauri'));
      writeFileSync(join(dir,'package.json'),'{"version":"1.0.0"}');
      writeFileSync(join(dir,'package-lock.json'),JSON.stringify({version:'1.0.0',packages:{'':{version:'1.0.0'},'node_modules/x':{version:'5.0.0'}}}));
      writeFileSync(join(dir,'src-tauri','tauri.conf.json'),'{"version":"1.0.0"}');
      writeFileSync(join(dir,'src-tauri','Cargo.toml'),'[package]\nname = "tvinoferma"\nversion = "1.0.0"\n');
      writeFileSync(join(dir,'src-tauri','Cargo.lock'),'[[package]]\r\nname = "tvinoferma"\r\nversion = "1.0.0"\r\n');
      const run=spawnSync(process.execPath,[resolve('scripts/bump-version.mjs'),'2.3.4'],{cwd:dir,encoding:'utf8'});expect(run.status).toBe(0);
      const lock=json(join(dir,'package-lock.json'));expect(lock.version).toBe('2.3.4');expect(lock.packages[''].version).toBe('2.3.4');expect(lock.packages['node_modules/x'].version).toBe('5.0.0');
      expect(readFileSync(join(dir,'src-tauri','Cargo.lock'),'utf8')).toContain('name = "tvinoferma"\r\nversion = "2.3.4"');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});

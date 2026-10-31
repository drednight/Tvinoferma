// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

it('сгенерированный один HTML запускается без сервера, не имеет сетевых/storage зависимостей и читает JSON только в браузере', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-file-check-'));
  let dom;
  try {
    const path = join(dir, 'check.html');
    execFileSync(process.execPath, ['scripts/build-state-file-check.mjs', path], { cwd: process.cwd() });
    const html = readFileSync(path, 'utf8');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).not.toMatch(/<(?:script|link|img)\b[^>]*(?:src|href)=/i);
    dom = new JSDOM(html, {
      url: 'file:///local-check.html',
      runScripts: 'dangerously',
      beforeParse(window) {
        window.TextEncoder = TextEncoder;
        window.TextDecoder = TextDecoder;
        // jsdom не даёт собственный structuredClone: Node-версия создала бы
        // чужие прототипы, которые строгая схема справедливо отклоняет.
        window.structuredClone = value => window.JSON.parse(window.JSON.stringify(value));
        Object.defineProperty(window, 'crypto', { value: webcrypto });
      }
    });
    const { document, Event } = dom.window;
    const input = document.getElementById('state-file');
    const output = document.getElementById('report');
    const text = JSON.stringify({
      schemaVersion: 10,
      characters: [{ id: 'hero', nick: 'FAKE_PRIVATE_NICK', contacts: { password: 'FAKE_PRIVATE_PASSWORD' } }],
      marathons: [
        {
          schemaVersion: 2,
          kind: 'single',
          id: 'm',
          title: 'FAKE_PRIVATE_TITLE',
          source: { url: 'http://pwonline.ru/supermarathon.php' }
        }
      ]
    });
    Object.defineProperty(input, 'files', {
      value: [{ size: text.length, name: 'FAKE_PRIVATE_FILENAME', text: async () => text }]
    });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(output.value).toBe('setup/identities/public.marathons.source.url/url_scheme'));
    expect(document.body.textContent + output.value).not.toContain('FAKE_PRIVATE');
  } finally {
    dom?.window.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

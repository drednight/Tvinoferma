import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';

let child;
let port;
let linkDir;

function request(path, method = 'GET') {
  return new Promise((resolveRequest, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () =>
        resolveRequest({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString()
        })
      );
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const probe = net.createServer();
  await new Promise((resolveListen, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  port = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close(error => (error ? reject(error) : resolveClose())));
  child = spawn(process.execPath, ['demo/serve.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DEMO_ENTRY: '/demo/app/index.html?show=cloud-sync' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error('Демо-сервер не запустился вовремя')), 10000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Демо-сервер завершился: ${code}`));
    });
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolveStarted();
    });
  });
}, 15000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    child.kill();
    await exited;
  }
  if (linkDir) await rm(linkDir, { recursive: true, force: true });
});

describe('демо-сервер, доступный из preview', () => {
  it('открывает только ресурсы лаборатории, а корень ведёт к выбранному макету', async () => {
    const root = await request('/');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/demo/app/index.html?show=cloud-sync');
    for (const path of [
      '/demo/app/index.html',
      '/demo/app/guard.js',
      '/js/core/utils.js',
      '/js/modules/cloudSync/ui/confirmCloudAccount.js',
      '/js/modules/cloudSync/providers/oauthAccountLabel.js',
      '/css/core/base.css',
      '/assets/icons/app/icon.png'
    ]) {
      expect((await request(path)).status, path).toBe(200);
    }
    const script = await request('/demo/app/guard.js');
    expect(script.headers['access-control-allow-origin']).toBe('*');
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    const html = await request('/demo/app/index.html');
    expect(html.headers['access-control-allow-origin']).toBeUndefined();
    const head = await request('/demo/app/guard.js', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it.each([
    '/.git/config',
    '/.git/HEAD',
    '/package.json',
    '/package-lock.json',
    '/docs/CLOUD-SYNC.md',
    '/demo/README.md',
    '/demo/serve.mjs',
    '/demo/../package.json',
    '/demo/%2e%2e/package.json',
    '/demo/%252e%252e%252fpackage.json',
    '/demo/%5c../package.json',
    '/demo/%00.js'
  ])('не отдаёт посторонний, скрытый или обходной путь %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('не следует по символическим ссылкам наружу или к скрытому файлу внутри каталога', async () => {
    if (process.platform === 'win32') return; // Для создания symlink на Windows могут требоваться особые права.
    linkDir = await mkdtemp(resolve('demo/tf-server-test-'));
    await symlink(resolve('package.json'), join(linkDir, 'outside.js'));
    await writeFile(join(linkDir, '.private'), 'fictional');
    await symlink(join(linkDir, '.private'), join(linkDir, 'inside.js'));
    const name = linkDir.split(/[\\/]/).pop();
    expect((await request(`/demo/${name}/outside.js`)).status).toBe(404);
    expect((await request(`/demo/${name}/inside.js`)).status).toBe(404);
  });

  it('не принимает методы изменения', async () => {
    const response = await request('/demo/app/index.html', 'POST');
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
  });
});

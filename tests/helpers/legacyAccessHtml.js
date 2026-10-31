import { readFileSync } from 'node:fs';
export function legacyAccessHtml(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const fragment = new DOMParser().parseFromString(
    readFileSync('tests/fixtures/cloud-access-tools.html', 'utf8'),
    'text/html'
  );
  parsed.getElementById('cloud-registration-panel').append(...fragment.body.childNodes);
  return parsed.documentElement.outerHTML;
}

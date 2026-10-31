export function legacyCloudHtml(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const template = parsed.getElementById('cloud-legacy-template');
  if (template) parsed.getElementById('cloud-registration-panel').append(template.content.cloneNode(true));
  return parsed.documentElement.outerHTML;
}

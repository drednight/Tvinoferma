// js/marathons/discoveryLauncher.js
// Слушатели поиска марафонов; startDiscovery открывает мастер сразу с поиском на сайте.

import { initSiteListeners } from './siteSync.js';
import { openMarathonWizard } from './wizard.js';

export async function initDiscoveryListener() {
  await initSiteListeners();
}

export function startDiscovery() {
  openMarathonWizard({ source: 'site', autoScan: true });
}

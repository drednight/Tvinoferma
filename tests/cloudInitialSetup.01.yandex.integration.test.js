// Same real crypto and assertions; separate file gives Vitest an isolated parallel unit.
import { registerSetupSuite1 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite1(['yandex']);

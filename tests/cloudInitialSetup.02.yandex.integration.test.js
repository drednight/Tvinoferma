// Same real crypto and assertions; separate file gives Vitest an isolated parallel unit.
import { registerSetupSuite2 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite2(['yandex']);

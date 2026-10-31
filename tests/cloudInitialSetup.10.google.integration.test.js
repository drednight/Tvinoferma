// Same real crypto and assertions; separate file gives Vitest an isolated parallel unit.
import { registerSetupSuite10 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite10(['google']);

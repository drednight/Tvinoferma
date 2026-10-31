// Same real crypto and assertions; separate file gives Vitest an isolated parallel unit.
import { registerSetupSuite21 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite21(['google']);

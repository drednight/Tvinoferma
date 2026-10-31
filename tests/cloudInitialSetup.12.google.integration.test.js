// Same real crypto and assertions; separate file gives Vitest an isolated parallel unit.
import { registerSetupSuite12 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite12(['google']);

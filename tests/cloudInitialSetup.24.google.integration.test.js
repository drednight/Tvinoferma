// Same real crypto and assertions; separate file gives Vitest an isolated parallel unit.
import { registerSetupSuite24 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite24(['google']);

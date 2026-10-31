// Same real crypto and assertions; separate file gives Vitest an isolated parallel unit.
import { registerSetupSuite20 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite20(['google']);

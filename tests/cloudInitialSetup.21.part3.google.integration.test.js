// Same real crypto and assertions, partitioned registration for independent scheduling.
import { registerSetupSuite21 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite21(['google'], 2, 4);

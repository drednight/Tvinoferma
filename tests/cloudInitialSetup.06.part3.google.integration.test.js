// Same real crypto and assertions, partitioned registration for independent scheduling.
import { registerSetupSuite6 } from './helpers/cloudInitialSetupSuites.js';
registerSetupSuite6(['google'], 2, 4);

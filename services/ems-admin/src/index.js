// ems-admin bootstrap
import { assertConfig } from './config.js';
import { start } from './server.js';
import { openDb } from './platform/db.js';
import { runSeeds } from './platform/seed.js';
import { startScheduler } from './platform/scheduler.js';

assertConfig();
openDb();
runSeeds();
start();
startScheduler();

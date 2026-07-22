// ems-admin bootstrap
import { assertConfig } from './config.js';
import { start } from './server.js';

assertConfig();
start();

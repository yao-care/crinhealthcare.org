// 入口：config → 模擬器或 Modbus client → poller → HTTP server。
import { config } from './config.js';
import { buildReadPlan } from './registers.js';
import { createModbusClient } from './modbusClient.js';
import { createSimulator } from './simulator.js';
import { startPoller } from './poller.js';
import { startServer } from './server.js';

const readPlan = buildReadPlan(config);
const client = config.sim
  ? createSimulator({ readPlan })
  : createModbusClient({ host: config.cabinetHost, port: config.cabinetPort, unitId: config.unitId, readPlan });
// 誠實原則：只有真實 Modbus 讀值才標 'live'；模擬資料標 'sim'（前端以展示資料呈現）。
// --sim-as-live 僅供本地驗證前端「即時」樣式，正式環境不可使用。
const source = config.sim ? (config.simAsLive ? 'live' : 'sim') : 'live';

console.log(`[ems-bridge] mode=${config.sim ? 'sim' : `modbus ${config.cabinetHost}:${config.cabinetPort}`} source=${source} poll=${config.pollMs}ms http=${config.httpPort}`);

const poller = startPoller(client, { pollMs: config.pollMs, source });
const server = startServer({ httpPort: config.httpPort, getSnapshot: poller.getSnapshot });

function shutdown() {
  poller.stop();
  client.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
